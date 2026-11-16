// 헤드리스 Chrome 을 CDP 로 직접 조작하는 작은 도우미 — 의존성 0개.
// browser-check.mjs(점검)와 capture-screens.mjs(시안 캡처)가 같이 쓴다.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9334, width = 1440, height = 900 } = {}) {
  const profile = join(tmpdir(), `studio-chrome-${port}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--force-device-scale-factor=1', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  for (let i = 0; i < 50 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* 아직 안 떴다 */ }
    if (!ws) await sleep(200);
  }
  if (!ws) throw new Error('Chrome 에 붙지 못했다');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  };
  // 답이 안 오는 호출을 영원히 기다리지 않는다 — 어느 단계에서 멈췄는지 알 수 있게
  const send = (method, params = {}, timeoutMs = 15000) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`${method} 가 ${timeoutMs / 1000}초 안에 답하지 않음 ${JSON.stringify(params).slice(0, 160)}`));
    }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra,
  });
  const click = async (x, y) => {
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
    await sleep(150);
  };
  const centerOf = (sel) => ev(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const clickEl = async (sel) => {
    const p = await centerOf(sel);
    if (!p) throw new Error('요소 없음: ' + sel);
    await click(p.x, p.y);
  };
  /** 요소 안의 비율 위치(0~1)를 누른다 — 레인의 특정 마디를 누를 때 */
  const clickIn = async (sel, fx, fy = 0.5) => {
    const r = await ev(`(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    if (!r) throw new Error('요소 없음: ' + sel);
    await click(r.x + r.w * fx, r.y + r.h * fy);
  };
  /** select 값을 바꾸고 React 가 알게 change 를 쏜다 */
  const choose = (sel, value) => ev(`(() => { const e = ${sel}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
  const type = async (sel, text) => {
    await ev(`(() => { const e = ${sel}; e.focus(); e.select?.(); })()`);
    await send('Input.insertText', { text });
    await sleep(100);
  };
  const key = async (keyName, code = keyName, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers });
    await sleep(80);
  };
  const goto = async (url, waitMs = 2500) => { await send('Page.navigate', { url }); await sleep(waitMs); };

  return {
    send, ev, mouse, click, clickEl, clickIn, centerOf, choose, type, key, goto, errors,
    close: () => { try { ws.close(); } catch { /* 무시 */ } proc.kill(); },
  };
}

export const byText = (t, tag = 'button') => `[...document.querySelectorAll(${JSON.stringify(tag)})].find((b) => b.textContent.trim() === ${JSON.stringify(t)}) ?? [...document.querySelectorAll(${JSON.stringify(tag)})].find((b) => b.textContent.trim().includes(${JSON.stringify(t)}))`;
export const byTitle = (t) => `[...document.querySelectorAll('button')].find((b) => (b.title || '').includes(${JSON.stringify(t)}))`;
export const byLabel = (t) => `document.querySelector(${JSON.stringify(`[aria-label="${t}"]`)})`;

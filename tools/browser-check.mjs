// 브라우저 실행 검증 — 의존성 없이 CDP 로 Chrome 을 직접 조작한다.
//
// 워크렛·AudioContext·React 배선은 Node 테스트로 못 잡는다. 이 스크립트가 실제
// Chrome 에서 음 찍기·끌기·되돌리기·재생(출력단 신호 측정)·WAV 내보내기·
// 자동 저장·새로고침 복원을 눌러 본다. **귀로 하는 판정은 대신하지 못한다.**
//
//   npm run dev            (다른 터미널)
//   npm run check:browser  [주소]
//
// 화면 캡처와 result.json 은 임시 폴더에 남고, 끝날 때 경로를 찍는다.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = join(tmpdir(), 'studio-browser-check');
const OUT = join(DIR, 'run');
const DL = join(OUT, 'downloads');
const PROFILE = join(DIR, 'chrome-profile');
const URL_APP = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PORT = 9333;
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
mkdirSync(DL, { recursive: true });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,900', '--force-device-scale-factor=1', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  // 마이크 녹음 점검용 — 가짜 장치(사인파)와 권한 자동 허용
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const problems = [];
// 서버 없이 도는 점검이라 `/v1` 호출 실패와 파비콘 404 는 앱 오류로 치지 않는다
const expected = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

let ws; let seq = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* 아직 안 떴다 */ }
    await sleep(200);
  }
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); return; }
    if (msg.method === 'Runtime.exceptionThrown') problems.push('예외: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 300));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && /favicon|\/v1\//.test(msg.params.entry.url ?? '')) { expected.push(msg.params.entry.url); return; }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push('log: ' + msg.params.entry.text.slice(0, 200) + ' ' + (msg.params.entry.url ?? ''));
  };
}
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const click = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(120); };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); };
const centerOf = (sel) => ev(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const clickEl = async (sel) => { const p = await centerOf(sel); if (!p) throw new Error('요소 없음: ' + sel); await click(p.x, p.y); };
const byText = (t) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(t)}))`;
const byTitle = (t) => `[...document.querySelectorAll('button')].find((b) => (b.title || '').includes(${JSON.stringify(t)}))`;
// 메뉴 — "클립 ▾" "트랙 ▾" 같은 단추를 열고 그 안의 항목을 누른다 (2026-11-21 화면 다시 짜기)
const menuDo = async (menu, item) => {
  await clickEl(`document.querySelector('button[aria-label=${JSON.stringify(menu + ' 메뉴')}]')`);
  await sleep(150);
  await clickEl(`[...document.querySelectorAll('[role=menu] button')].find((b) => b.textContent.includes(${JSON.stringify(item)}))`);
};
// 내보내기 창 — 열려 있으면 그대로 둔다 (단추가 여닫기를 오간다)
const openExport = async () => { if (!(await ev(`!!document.querySelector('[role=dialog][aria-label="내보내기"]')`))) await clickEl(`document.querySelector('button[aria-expanded]:not([aria-label])') && [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '내보내기')`); };
const noteCount = () => ev(`document.querySelectorAll('.cursor-crosshair [role=button]').length`);
const saved = () => ev(`(() => { const t = localStorage.getItem('project-autosave-v1'); if (!t) return null; const p = JSON.parse(t); const d = p.project ?? p; return (d.tracks ?? []).reduce((n, tr) => n + tr.clips.reduce((m, c) => m + c.notes.length, 0), 0); })()`);

// 출력단에 탭을 달아 실제로 소리가 나가는지 잰다
const TAP = `(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    try {
      if (dest instanceof AudioDestinationNode && !dest.context.__tap && !(dest.context instanceof OfflineAudioContext)) {
        const an = dest.context.createAnalyser(); an.fftSize = 2048; dest.context.__tap = an; window.__tap = an; window.__ctx = dest.context;
      }
      if (dest instanceof AudioDestinationNode && dest.context.__tap) orig.call(this, dest.context.__tap);
    } catch {}
    return orig.call(this, dest, ...rest);
  };
  window.__peak = () => { if (!window.__tap) return -1; const b = new Float32Array(2048); window.__tap.getFloatTimeDomainData(b); let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; };
})()`;

function analyzeWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, why: 'RIFF/WAVE 헤더 아님' };
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') { data = { start: off + 8, size }; break; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) return { ok: false, why: 'fmt/data 청크 없음' };
  const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.ch));
  let peak = 0, sum = 0;
  for (let i = 0; i < frames * fmt.ch; i++) {
    const o = data.start + i * bps;
    const v = bps === 3 ? b.readIntLE(o, 3) / 8388608 : b.readInt16LE(o) / 32768;
    peak = Math.max(peak, Math.abs(v)); sum += v * v;
  }
  return { ok: true, ...fmt, seconds: frames / fmt.rate, peak, rms: Math.sqrt(sum / (frames * fmt.ch)), bytes: b.length };
}

try {
  await connect();
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: TAP });
  // 글로벌 트랙은 기본 숨김 — 점검은 그 줄들을 누르므로 켜 두고 시작한다 (기본 숨김은 따로 본다)
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (localStorage.getItem('ui-globals') === null) localStorage.setItem('ui-globals', '1'); } catch {}" });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await send('Page.navigate', { url: URL_APP });
  await sleep(2500);

  // 1. 화면이 뜬다
  const grid = await ev(`(() => { const g = document.querySelector('.cursor-crosshair'); if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  record('편집기 화면 표시', !!grid, grid ? `격자 ${Math.round(grid.w)}×${Math.round(grid.h)}` : '격자를 못 찾음');
  await shot('01-start');

  // 2. 음 찍기
  const before = await noteCount();
  const spots = [[60, 20], [170, 50], [280, 80], [390, 110], [500, 140]];
  for (const [dx, dy] of spots) await click(grid.x + dx, grid.y + dy);
  const after = await noteCount();
  record('격자 클릭으로 음 추가', after - before === spots.length, `${before} → ${after}개`);
  await shot('02-notes');

  // 3. 자동 저장
  await sleep(400);
  const s1 = await saved();
  const badge = await ev(`document.querySelector('[data-save-state]')?.textContent ?? '(표시 없음)'`);
  record('저장 상태 표시', badge === '저장됨', badge);
  record('자동 저장 (브라우저 저장소)', s1 === after, `저장된 음 ${s1}개 / 화면 ${after}개`);

  // 4. 음 옮기기 (끌기)
  const titlesBefore = await ev(`[...document.querySelectorAll('.cursor-crosshair [role=button]')].map((e) => e.title + '@' + Math.round(e.getBoundingClientRect().x)).join(' ')`);
  const n0 = await ev(`(() => { const e = document.querySelector('.cursor-crosshair [role=button]'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 3, y: r.y + r.height / 2, title: e.title, left: r.x, top: r.y }; })()`);
  await mouse('mouseMoved', n0.x, n0.y, { buttons: 0 }); await mouse('mousePressed', n0.x, n0.y);
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', n0.x + i * 10, n0.y + i * 6); await sleep(30); }
  await mouse('mouseReleased', n0.x + 60, n0.y + 36); await sleep(200);
  const titles = await ev(`[...document.querySelectorAll('.cursor-crosshair [role=button]')].map((e) => e.title + '@' + Math.round(e.getBoundingClientRect().x)).join(' ')`);
  record('음 끌어서 이동', !titles.includes(n0.title + '@' + Math.round(n0.left)), titles);

  // 5. 되돌리기·다시 실행
  await clickEl(byTitle('되돌리기'));
  const afterUndo = await ev(`[...document.querySelectorAll('.cursor-crosshair [role=button]')].map((e) => e.title + '@' + Math.round(e.getBoundingClientRect().x)).join(' ')`);
  await clickEl(byTitle('다시 실행'));
  const afterRedo = await ev(`[...document.querySelectorAll('.cursor-crosshair [role=button]')].map((e) => e.title + '@' + Math.round(e.getBoundingClientRect().x)).join(' ')`);
  record('되돌리기 / 다시 실행', afterUndo === titlesBefore && afterRedo === titles, `되돌리면 끌기 전 자리=${afterUndo === titlesBefore}, 다시 실행하면 옮긴 자리=${afterRedo === titles}`);
  // 음을 누르기만 한 것은 언두 단계가 아니어야 한다
  const nc = await centerOf(`document.querySelectorAll('.cursor-crosshair [role=button]')[2]`);
  await click(nc.x, nc.y);
  await clickEl(byTitle('되돌리기'));
  const afterClickUndo = await ev(`[...document.querySelectorAll('.cursor-crosshair [role=button]')].map((e) => e.title + '@' + Math.round(e.getBoundingClientRect().x)).join(' ')`);
  record('음을 누르기만 하면 언두 단계가 안 생김', afterClickUndo === titlesBefore, `되돌리기 한 번에 끌기 전으로=${afterClickUndo === titlesBefore}`);
  await clickEl(byTitle('다시 실행'));

  // 6. 재생 — 실제 출력 신호를 잰다
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  let peak = 0; const lcd = [];
  for (let i = 0; i < 16; i++) { await sleep(150); peak = Math.max(peak, await ev('window.__peak()')); if (i % 5 === 0) lcd.push(await ev(`(${byTitle('정지')} ? 'playing' : 'stopped') + ' ctx=' + (window.__ctx ? window.__ctx.state + '@' + window.__ctx.currentTime.toFixed(2) : 'none')`)); }
  record('재생 중 출력단에 신호', peak > 0.001, `피크 ${peak.toFixed(4)} · ${lcd.join(' | ')}`);
  await shot('03-playing');
  const stopBtn = await centerOf(byTitle('정지'));
  if (stopBtn) await click(stopBtn.x, stopBtn.y);
  await sleep(600);
  const tail = await ev('window.__peak()');
  record('정지', !(await centerOf(byTitle('정지'))), `정지 0.6초 뒤 피크 ${tail.toFixed(4)}`);

  // 7. WAV 내보내기
  await openExport(); await clickEl(byText('바운스'));
  let wav = null;
  for (let i = 0; i < 60 && !wav; i++) { await sleep(500); wav = readdirSync(DL).find((f) => f.endsWith('.wav')) ?? null; }
  if (wav) { await sleep(500); const a = analyzeWav(join(DL, wav)); record('WAV 내보내기', a.ok && a.peak > 0.001, a.ok ? `${wav} · ${a.ch}ch ${a.rate}Hz ${a.bits}bit · ${a.seconds.toFixed(2)}초 · 피크 ${a.peak.toFixed(3)} · RMS ${a.rms.toFixed(4)} · ${(a.bytes / 1024).toFixed(0)}KB` : a.why); }
  else record('WAV 내보내기', false, '30초 안에 파일이 내려오지 않음: ' + (await ev(`document.body.innerText.slice(0, 0) + ([...document.querySelectorAll('[role=alert], .text-red-600')].map((e) => e.textContent).join(' | '))`)));

  // 8. 믹서·튜닝 도구 탭
  for (const [label, file] of [['믹서', '04-mixer'], ['튜닝 도구', '05-tuning'], ['편집기', '06-editor']]) {
    const n = problems.length;
    await clickEl(byText(label)); await sleep(700); await shot(file);
    const len = await ev('document.body.innerText.length');
    record(`"${label}" 탭 열기`, problems.length === n && len > 100, `글자 ${len}자, 새 오류 ${problems.length - n}건`);
  }

  // 9. 새로고침 뒤 복원
  const live = await noteCount();
  await send('Page.reload'); await sleep(2500);
  const restored = await noteCount();
  record('새로고침 뒤 작업 복원', restored === live && live > 0, `새로고침 전 ${live}개 → 뒤 ${restored}개`);

  // 10. 편집 직후 바로 닫아도 남는가 (실시간 저장)
  const g2 = await ev(`(() => { const r = document.querySelector('.cursor-crosshair').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  await mouse('mouseMoved', g2.x + 620, g2.y + 30, { buttons: 0 }); await mouse('mousePressed', g2.x + 620, g2.y + 30); await mouse('mouseReleased', g2.x + 620, g2.y + 30);
  const liveNow = await ev(`new Promise((r) => requestAnimationFrame(() => r(document.querySelectorAll('.cursor-crosshair [role=button]').length)))`);
  await send('Page.reload'); await sleep(2500);
  const afterQuick = await noteCount();
  record('편집 직후 곧바로 새로고침해도 남음', afterQuick === liveNow && liveNow === live + 1, `편집 뒤 ${liveNow}개 → 새로고침 뒤 ${afterQuick}개`);
  // 11. 누르자마자 같은 순간에 새로고침 — 타이머가 돌 틈이 없으므로 닫을 때 쓰는 경로만 남는다
  const before11 = await noteCount();
  const g3 = await ev(`(() => { const r = document.querySelector('.cursor-crosshair').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  await mouse('mouseMoved', g3.x + 700, g3.y + 60, { buttons: 0 });
  const t0 = Date.now();
  const burst = [mouse('mousePressed', g3.x + 700, g3.y + 60), mouse('mouseReleased', g3.x + 700, g3.y + 60), send('Page.reload')];
  await Promise.all(burst); const gap = Date.now() - t0;
  await sleep(2500);
  const after11 = await noteCount();
  record('누른 즉시 새로고침해도 남음 (닫을 때 저장)', after11 === before11 + 1, `${before11}개 → ${after11}개, 클릭~새로고침 ${gap}ms`);
  await shot('07-after-reload');

  // 12. 클립 나누기·합치기·반복, 트랙 복제·순서
  const shape = () => ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.map((t) => t.name + ':' + t.clips.map((c) => c.startTick + '+' + c.lengthTick + '/' + c.notes.length).sort((a, b) => parseInt(a) - parseInt(b)).join(',')).join(' | '); })()`);
  const settle = () => sleep(400);
  const s0 = await shape();
  await menuDo('클립', '끝까지 반복'); await settle();
  const sRepeat = await shape();
  record('클립 반복', sRepeat.split(',').length > s0.split(',').length, `${s0}  →  ${sRepeat}`);

  const ruler = await ev(`(() => { const r = document.querySelector('[title="클릭해 재생 위치를 옮깁니다"]').getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2 }; })()`);
  await click(ruler.x + 336, ruler.y);
  await menuDo('클립', '나누기'); await settle();
  const sSplit = await shape();
  record('클립 나누기 (커서 위치)', sSplit.split(',').length === sRepeat.split(',').length + 1, sSplit);

  await clickEl(byTitle('되돌리기')); await settle();
  const sUndo = await shape();
  await clickEl(byTitle('다시 실행')); await settle();
  record('나누기 되돌리기', sUndo === sRepeat && (await shape()) === sSplit, sUndo);

  await menuDo('클립', '합치기'); await settle();
  const sJoin = await shape();
  record('클립 합치기 (다음 클립과)', sJoin.split(',').length === sSplit.split(',').length - 1, sJoin);

  await menuDo('트랙', '트랙 복제'); await settle();
  const sDup = await shape();
  record('트랙 복제', sDup.split(' | ').length === 2 && sDup.split(' | ')[1].includes('복사'), sDup);
  await menuDo('트랙', '위로 옮기기'); await settle();
  const sMove = await shape();
  record('트랙 순서 바꾸기', sMove.split(' | ')[0].includes('복사'), sMove);
  const n12 = problems.length;
  await clickEl(byTitle('맨 앞으로')); await clickEl(byTitle('커서부터 재생'));
  let peak12 = 0; for (let i = 0; i < 10; i++) { await sleep(150); peak12 = Math.max(peak12, await ev('window.__peak()')); }
  const stop12 = await centerOf(byTitle('정지')); if (stop12) await click(stop12.x, stop12.y);
  record('조작 뒤에도 재생됨', peak12 > 0.001 && problems.length === n12, `피크 ${peak12.toFixed(4)}, 새 오류 ${problems.length - n12}건`);
  await shot('08-clips-tracks');

  // 13. 글로벌 트랙 — 구간·마커·코드·박자 변화, 마커 이동, 클립 뮤트, LCD 모드
  const saved13 = () => ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return p.project ?? p; })()`);
  const laneAt = async (row, fx) => { const r = await ev(`(() => { const e = document.querySelector('[data-global=${row}] > div:last-child'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`); await click(r.x + r.w * fx, r.y + r.h / 2); await sleep(300); };
  await laneAt('sections', 0.05);
  await laneAt('markers', 0.3);
  await laneAt('markers', 0.6);
  await laneAt('chords', 0.05);
  let d13 = await saved13();
  record('구간·마커·코드 추가', d13.sections?.length === 1 && d13.markers?.length === 2 && d13.chords?.length === 1,
    `구간 ${d13.sections?.length} · 마커 ${d13.markers?.length} · 코드 ${d13.chords?.length}`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await sleep(150);
  await clickEl(byText('음에서 찾기')); await sleep(300);
  d13 = await saved13();
  record('음에서 코드 찾기', (d13.chords?.length ?? 0) >= 1, (d13.chords ?? []).map((c) => c.root + c.quality).join(' '));
  await clickEl(`document.querySelector('[data-global=sections] [data-item]')`);
  await clickEl(byTitle('안의 음악째 복제')); await sleep(300);
  d13 = await saved13();
  record('구간 복제', d13.sections?.length === 2, (d13.sections ?? []).map((x) => x.name + '@' + x.startTick).join(' '));
  await clickEl(`document.querySelector('[data-bar="2"]')`);
  const sigSel = `document.querySelector('[aria-label="박자 변화"]')`;
  await ev(`(() => { const e = ${sigSel}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, '3/4'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  d13 = await saved13();
  record('박자 변화', d13.signatureChanges?.[0]?.bar === 1 && d13.signatureChanges[0].timeSignature.num === 3, JSON.stringify(d13.signatureChanges));
  await clickEl(byTitle('맨 앞으로'));
  await ev(`document.activeElement?.blur(); 'ok'`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Period', key: '.', modifiers: 1 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Period', key: '.', modifiers: 1 });
  await sleep(200);
  const lcdPos = await ev(`document.querySelector('[aria-label="재생 위치"]').textContent`);
  record('다음 마커로 이동', lcdPos !== '1.1.00', `LCD ${lcdPos}`);
  await clickEl(`document.querySelector('[aria-label="재생 위치"]')`);
  const lcdTime = await ev(`document.querySelector('[aria-label="재생 위치"]').textContent`);
  record('LCD 분:초 전환', /^\d+:\d\d\.\d$/.test(lcdTime), lcdTime);
  await menuDo('클립', '클립 뮤트'); await sleep(300);
  d13 = await saved13();
  record('클립 뮤트', d13.tracks.some((t) => t.clips.some((c) => c.muted === true)), '');
  await send('Page.reload'); await sleep(2500);
  const d13b = await saved13();
  record('글로벌 트랙 새로고침 뒤 유지', d13b.sections?.length === 2 && d13b.signatureChanges?.length === 1 && d13b.markers?.length >= 2,
    `구간 ${d13b.sections?.length} · 박자 변화 ${d13b.signatureChanges?.length} · 마커 ${d13b.markers?.length}`);
  await shot('09-global');

  // 14. 트랙 보호·카운트인·스택
  const notes14 = await noteCount();
  await menuDo('트랙', '보호');
  const g14 = await ev(`(() => { const r = document.querySelector('.cursor-crosshair').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  await click(g14.x + 100, g14.y + 40);
  const blockedMsg = await ev(`document.body.innerText.includes('보호돼 있습니다')`);
  record('보호된 트랙은 음을 못 찍는다', (await noteCount()) === notes14 && blockedMsg, `음 ${notes14} → ${await noteCount()}, 알림 ${blockedMsg}`);
  await menuDo('트랙', '보호');
  await clickEl(`document.querySelector('[aria-label="카운트인"]')`);
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  await sleep(900);
  const during = await ev(`document.querySelector('[aria-label="재생 위치"]').textContent`);
  await sleep(2600);
  const after14 = await ev(`document.querySelector('[aria-label="재생 위치"]').textContent`);
  const stop14 = await centerOf(byTitle('정지')); if (stop14) await click(stop14.x, stop14.y);
  record('카운트인 — 한 마디 센 뒤 시작', during.startsWith('0:00') || during.startsWith('1.1.'), `0.9초 ${during} → 3.5초 ${after14}`);
  await clickEl(`document.querySelector('[aria-label="카운트인"]')`);
  await menuDo('트랙', '＋ 새 스택');
  await sleep(300);
  const d14 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return { stacks: (d.stacks ?? []).length, member: d.tracks.some((t) => t.stackId) }; })()`);
  record('트랙 스택 만들기', d14.stacks === 1 && d14.member, JSON.stringify(d14));
  await shot('10-tracks');

  // 15. 오토메이션 — 레인 열기, 점 찍기, 팬 대상, 재생 중 쓰기 기록
  const trackName15 = await ev(`document.querySelector('[data-track]').dataset.track`);
  await clickEl(`document.querySelector('[aria-label="${trackName15} 오토메이션"]')`);
  // 레인이 화면 밖일 수 있다(글로벌 트랙 줄이 늘었다) — 먼저 보이게
  const lane15 = await ev(`(() => { const e = document.querySelector('[data-automation] > div:last-child'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await click(lane15.x + lane15.w * 0.1, lane15.y + lane15.h * 0.2);
  await click(lane15.x + lane15.w * 0.5, lane15.y + lane15.h * 0.8);
  await sleep(300);
  const auto15 = () => ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => t.automation.map((l) => l.target + ':' + l.points.length)).join(' '); })()`);
  record('오토메이션 점 찍기', (await auto15()).includes('volume:2'), await auto15());
  const target15 = `document.querySelector('[aria-label="${trackName15} 오토메이션 대상"]')`;
  await ev(`(() => { const e = ${target15}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'pan'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);
  const lanePan = await ev(`(() => { const e = document.querySelector('[data-automation] > div:last-child'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  await click(lanePan.x + lanePan.w * 0.3, lanePan.y + lanePan.h * 0.1);
  await sleep(300);
  record('팬 오토메이션', (await auto15()).includes('pan:1'), await auto15());
  // 악기 파라미터도 대상 — 고르고 점을 찍으면 inst: 레인이 생기고, 재생이 그 값으로 (오류 없이) 난다
  const inst15 = await ev(`[...${target15}.options].map((o) => o.value).filter((v) => v.startsWith('inst:'))`);
  if (inst15.length) {
    await ev(`(() => { const e = ${target15}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify('X')}.replace('X', ${JSON.stringify(inst15[0] ?? '')})); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(200);
    await click(lanePan.x + lanePan.w * 0.2, lanePan.y + lanePan.h * 0.8);
    await sleep(300);
  }
  const instLane = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => t.automation.filter((a) => a.target.startsWith('inst:')).map((a) => a.target + ':' + a.points.length)).join(' '); })()`);
  record('악기 파라미터 오토메이션 대상', inst15.length > 0 && /inst:\w+:1/.test(instLane), `대상 ${inst15.length}개 · ${instLane}`);
  await ev(`(() => { const e = ${target15}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'pan'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await clickEl(`document.querySelector('[aria-label="${trackName15} 오토메이션 모드"] [role=radio]:nth-child(4)')`);
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  await sleep(1500);
  const stop15 = await centerOf(byTitle('정지')); if (stop15) await click(stop15.x, stop15.y);
  await sleep(500);
  const after15 = await auto15();
  record('쓰기 모드 — 재생하는 동안 볼륨 곡선 기록', /volume:(\d+)/.test(after15) && Number(/volume:(\d+)/.exec(after15)[1]) >= 2, after15);
  await clickEl(byTitle('되돌리기')); await sleep(300);
  record('기록은 언두 한 단계', (await auto15()).includes('volume:2'), await auto15());
  await shot('11-automation');

  // 16. 믹서 — 버스·센드·인서트·VCA, 버스를 거쳐도 소리와 내보내기가 난다
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][1]`);
  await sleep(400);
  await clickEl(byText('＋ 버스')); await clickEl(byText('＋ VCA')); await sleep(200);
  const pick16 = (sel, v) => ev(`(() => { const e = ${sel}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await pick16(`document.querySelector('[data-strip="버스 1"] [aria-label="이펙트 추가"]')`, 'reverb');
  await pick16(`document.querySelector('[data-strip="마스터"] [aria-label="이펙트 추가"]')`, 'eq');
  await sleep(200);
  const strip16 = await ev(`document.querySelector('[data-strip]').dataset.strip`);
  const busId16 = await ev(`document.querySelector('[aria-label="${strip16} 출력"] option:nth-child(2)').value`);
  await pick16(`document.querySelector('[aria-label="${strip16} 출력"]')`, busId16);
  await sleep(300);
  const d16 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return { buses: (d.buses ?? []).length, vcas: (d.vcas ?? []).length, out: d.tracks[0].output ?? null, busFx: d.buses?.[0]?.effects?.length, masterFx: d.master.effects.length }; })()`);
  record('버스·VCA·인서트·출력 경로', d16.buses === 1 && d16.vcas === 1 && d16.out === busId16 && d16.busFx === 1 && d16.masterFx >= 1, JSON.stringify(d16));
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  let peak16 = 0; for (let i = 0; i < 12; i++) { await sleep(150); peak16 = Math.max(peak16, await ev('window.__peak()')); }
  const stop16 = await centerOf(byTitle('정지')); if (stop16) await click(stop16.x, stop16.y);
  record('버스를 거쳐도 재생됨 (마스터 이펙트 바꾼 뒤)', peak16 > 0.001, `피크 ${peak16.toFixed(4)}`);
  for (const f of readdirSync(DL)) rmSync(join(DL, f));
  await openExport(); await clickEl(byText('바운스'));
  let wav16 = null;
  for (let i = 0; i < 60 && !wav16; i++) { await sleep(500); wav16 = readdirSync(DL).find((f) => f.endsWith('.wav')) ?? null; }
  if (wav16) { await sleep(500); const a = analyzeWav(join(DL, wav16)); record('버스 경로 내보내기', a.ok && a.peak > 0.001, a.ok ? `피크 ${a.peak.toFixed(3)} · ${a.seconds.toFixed(1)}초` : a.why); }
  else record('버스 경로 내보내기', false, '파일이 안 내려옴');
  // 16b. 프리 페이더 센드 — 둘째 트랙 → 버스 센드를 켜고 프리로, 재생해도 오류 없이
  const strip16b = await ev(`[...document.querySelectorAll('[data-strip]')][1]?.dataset.strip ?? ''`);
  await ev(`(() => { const e = document.querySelector('[aria-label="${strip16b} → 버스 1 센드"]'); if (!e) return 'none'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '0.6'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return 'ok'; })()`);
  await sleep(300);
  await clickEl(`document.querySelector('[aria-label="${strip16b} → 버스 1 프리 페이더"]')`);
  await sleep(300);
  const n16b = problems.length;
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  let peak16b = 0; for (let i = 0; i < 8; i++) { await sleep(150); peak16b = Math.max(peak16b, await ev('window.__peak()')); }
  const stop16b = await centerOf(byTitle('정지')); if (stop16b) await click(stop16b.x, stop16b.y);
  const pre16 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => (t.sends ?? []).map((x) => t.name + ':' + x.level + (x.pre ? ':pre' : ''))).join(' '); })()`);
  record('프리 페이더 센드', /:pre/.test(pre16) && peak16b > 0.001 && problems.length === n16b, `${pre16} · 피크 ${peak16b.toFixed(4)}`);
  await shot('12-mixer');

  // 17. 이펙트 13종 — 전부 실제 노드로 만들어지고, 걸린 채로 소리가 난다
  const fxTypes = await ev(`[...document.querySelector('[data-strip] [aria-label="이펙트 추가"]').options].map((o) => o.value).filter(Boolean)`);
  for (const type of fxTypes) {
    await ev(`(() => { const e = document.querySelector('[data-strip] [aria-label="이펙트 추가"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(type)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(120);
  }
  await sleep(500); // 연달아 추가하면 자동 저장이 마지막까지 미뤄진다
  const n17 = problems.length;
  const fxCount = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.map((t) => t.name + '|' + (t.locked ? 'L' : '') + '|' + t.effects.length).join(' ; ') + ' :: ' + document.querySelector('[data-save-state]').textContent; })()`);
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  let peak17 = 0; for (let i = 0; i < 12; i++) { await sleep(150); peak17 = Math.max(peak17, await ev('window.__peak()')); }
  const stop17 = await centerOf(byTitle('정지')); if (stop17) await click(stop17.x, stop17.y);
  // Rust 이펙트(워크렛 노드)도 섞여 있다 — 실패하면 워크렛이 console.error 를 낸다
  record(`이펙트 ${fxTypes.length}종을 한 트랙에 걸고 재생`, fxTypes.length >= 17 && new RegExp(`\\|\\|${fxTypes.length}\\b`).test(String(fxCount)) && peak17 > 0.0005 && problems.length === n17,
    `종류 ${fxTypes.length} · 걸린 수 ${fxCount} · 피크 ${peak17.toFixed(4)} · 새 오류 ${problems.length - n17}`);
  const rust17 = await ev(`JSON.stringify(window.__rustFx ?? null)`);
  record('Rust 이펙트가 실제 워크렛 노드로 (통과로 떨어지지 않음)', /"created":[1-9]/.test(rust17) && /"passthrough":0/.test(rust17), rust17);
  const pdc17 = await ev(`document.querySelector('[data-pdc]')?.textContent ?? ''`);
  // 지연 있는 이펙트(컨볼루션 1024·리니어 페이즈 3072·리미터 137·오버샘플링 16…)를 다 걸었다 — 그 합
  const pdcMs = Number(/PDC ([\d.]+)ms/.exec(pdc17)?.[1] ?? 0);
  record('지연 보정 표시 (지연 있는 이펙트의 합)', pdcMs > 21, pdc17 || '표시 없음');
  await shot('13-effects');

  // 84종을 한 트랙에 건 채로는 뒤 점검(내보내기·연주)이 무거워진다 — 되돌리고,
  // 현실적인 구성(Rust 이펙트 넷: 컴프 모델·크로마버브·어댑티브 리미터·스텝 FX)으로 내보내기까지 확인한다
  for (let i = 0; i < fxTypes.length; i++) { await clickEl(byTitle('되돌리기')); await sleep(25); }
  await sleep(400);
  for (const type of ['compmodel', 'chromaverb', 'stepfx', 'adaptivelimiter']) {
    await ev(`(() => { const e = document.querySelector('[data-strip] [aria-label="이펙트 추가"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify('X')}.replace('X', ${JSON.stringify(type)})); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(150);
  }
  await sleep(800);
  const fx17b = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.map((t) => t.effects.map((e) => e.type).join('+')).filter(Boolean).join(' ; '); })()`);
  record('되돌린 뒤 Rust 이펙트 넷만 남김', /compmodel\+chromaverb\+stepfx\+adaptivelimiter/.test(String(fx17b)), String(fx17b));
  // 사이드체인 — 컴프의 감지 입력을 다른 트랙으로, 재생해도 오류 없이 소리 (덕킹 연결)
  await clickEl(`[...document.querySelectorAll('[data-strip] button')].find((b) => b.textContent.includes('컴프레서 (회로 모델)'))`);
  await sleep(300);
  const sc17 = await ev(`(() => { const e = document.querySelector('[aria-label="사이드체인"]'); if (!e || e.options.length < 2) return ''; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, e.options[1].value); e.dispatchEvent(new Event('change', { bubbles: true })); return e.options[1].textContent; })()`);
  await sleep(500);
  const n17c = problems.length;
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  let peak17c = 0; for (let i = 0; i < 10; i++) { await sleep(150); peak17c = Math.max(peak17c, await ev('window.__peak()')); }
  const stop17c = await centerOf(byTitle('정지')); if (stop17c) await click(stop17c.x, stop17c.y);
  const saved17c = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => t.effects.filter((e) => e.sidechain).map((e) => e.type)).join(','); })()`);
  record('사이드체인 — 컴프 감지를 다른 트랙으로, 재생', sc17.length > 0 && saved17c.includes('compmodel') && peak17c > 0.0005 && problems.length === n17c, `${sc17} · 저장 ${saved17c} · 피크 ${peak17c.toFixed(4)} · 새 오류 ${problems.length - n17c}`);
  // 서로 감지 (2026-11-19 2-b 17) — 둘째 트랙에도 컴프를 걸어 첫째 트랙을 감지하게: 고리여도 소리가 나야 한다
  const strip2 = await ev(`[...document.querySelectorAll('[data-strip]')][1]?.dataset.strip ?? ''`);
  await ev(`(() => { const e = document.querySelector('[data-strip="${strip2}"] [aria-label="이펙트 추가"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'compmodel'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(400);
  await ev(`(() => { const e = document.querySelector('[aria-label="사이드체인"]'); const first = document.querySelector('[data-strip]').dataset.strip; const opt = [...e.options].find((o) => o.textContent === first); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, opt.value); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(400);
  const n17d = problems.length;
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  let peak17d = 0; for (let i = 0; i < 10; i++) { await sleep(150); peak17d = Math.max(peak17d, await ev('window.__peak()')); }
  const stop17d = await centerOf(byTitle('정지')); if (stop17d) await click(stop17d.x, stop17d.y);
  const mutual = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.filter((t) => t.effects.some((e) => e.sidechain)).length; })()`);
  record('사이드체인 서로 감지 (고리) — 소리가 난다', mutual >= 2 && peak17d > 0.0005 && problems.length === n17d, `감지 트랙 ${mutual} · 피크 ${peak17d.toFixed(4)}`);

  // 18. 내보내기 창 — 16bit·44.1k·노멀라이즈, 측정값 표시, 스템 ZIP
  for (const f of readdirSync(DL)) rmSync(join(DL, f));
  await openExport();
  await clickEl(byText('16bit + 디더')); await clickEl(byText('44.1 kHz'));
  await ev(`(() => { const box = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')][1]; box.click(); })()`);
  await clickEl(byText('바운스'));
  let wav18 = null;
  for (let i = 0; i < 60 && !wav18; i++) { await sleep(500); wav18 = readdirSync(DL).find((f) => f.endsWith('.wav')) ?? null; }
  if (wav18) {
    await sleep(500);
    const a = analyzeWav(join(DL, wav18));
    record('16bit·44.1kHz·노멀라이즈 바운스', a.ok && a.bits === 16 && a.rate === 44100 && Math.abs(20 * Math.log10(a.peak) + 1) < 0.2, a.ok ? `${a.bits}bit ${a.rate}Hz 피크 ${(20 * Math.log10(a.peak)).toFixed(2)}dB` : a.why);
  } else record('16bit·44.1kHz·노멀라이즈 바운스', false, '파일이 안 내려옴');
  const meas = await ev(`document.querySelector('[aria-label="내보낸 파일 측정"]')?.innerText ?? ''`);
  record('내보낸 파일 측정값 표시', /dBTP/.test(meas), meas.replace(/\n/g, ' '));
  for (const f of readdirSync(DL)) rmSync(join(DL, f));
  await clickEl(byText('48 kHz'));
  await ev(`(() => { const box = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')][2]; box.click(); })()`);
  await clickEl(byText('스템'));
  let zip18 = null;
  for (let i = 0; i < 90 && !zip18; i++) { await sleep(500); zip18 = readdirSync(DL).find((f) => f.endsWith('.zip')) ?? null; }
  const zipBytes = zip18 ? readFileSync(join(DL, zip18)) : null;
  const entries = zipBytes ? (zipBytes.toString('latin1').match(/PK\x01\x02/g) ?? []).length : 0;
  record('스템 ZIP', zip18 !== null && entries >= 2, `${zip18} · 파일 ${entries}개`);
  await shot('14-export');
  await clickEl(byText('닫기'));

  // 19. 브라우저 — 검색, 곡에 없는 악기 미리 듣기, 트랙에 넣기, 패치 저장
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][0]`);
  await sleep(300);
  await clickEl(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.includes('브라우저'))`);
  await ev(`(() => { const e = document.querySelector('[aria-label="악기 검색"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '마림바'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const hits = await ev(`[...document.querySelectorAll('[data-instrument]')].map((e) => e.dataset.instrument).join(',')`);
  record('악기 검색', hits === 'marimba', hits);
  let peak19 = 0;
  await clickEl(`document.querySelector('[aria-label="마림바 미리 듣기"]')`);
  for (let i = 0; i < 12; i++) { await sleep(120); peak19 = Math.max(peak19, await ev('window.__peak()')); }
  record('곡에 없는 악기 미리 듣기', peak19 > 0.001, `피크 ${peak19.toFixed(4)}`);
  await clickEl(`[...document.querySelectorAll('[data-instrument="marimba"] button')].find((b) => b.textContent === '이 트랙에')`);
  await sleep(300);
  const inst19 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.map((t) => t.instrumentId).join(','); })()`);
  record('고른 트랙 악기 바꾸기', inst19.includes('marimba'), inst19);
  await clickEl(`[...document.querySelectorAll('[data-browser] button')].find((b) => b.textContent === '저장')`);
  await sleep(200);
  const patches = await ev(`JSON.parse(localStorage.getItem('user-patches-v1') ?? '[]').length`);
  record('패치 저장 (사용자 라이브러리)', patches === 1, `${patches}개`);
  await shot('15-browser');

  // 20. 건반 — 자판 연주로 소리, 스텝 입력으로 커서 자리에 음과 화음
  await clickEl(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.includes('음 편집'))`);
  await clickEl(`document.querySelector('[aria-label="건반"]')`);
  await ev(`document.activeElement?.blur(); 'ok'`);
  const press = async (code, shift = false) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.replace('Key', '').toLowerCase(), modifiers: shift ? 8 : 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.replace('Key', '').toLowerCase(), modifiers: shift ? 8 : 0 });
    await sleep(160);
  };
  let peak20 = 0;
  await press('KeyA');
  for (let i = 0; i < 8; i++) { await sleep(100); peak20 = Math.max(peak20, await ev('window.__peak()')); }
  record('자판으로 연주 (A = C4)', peak20 > 0.001, `피크 ${peak20.toFixed(4)}`);
  // 20b. 코드 스트립 — 누르고 있는 동안 화음이 울린다, 드럼 패드 탭이 있다
  await clickEl(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent === '코드 스트립')`);
  await sleep(200);
  const strip = await centerOf(`document.querySelector('[data-chord-strips] button')`);
  let peak20b = 0;
  if (strip) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: strip.x, y: strip.y, button: 'left', clickCount: 1 });
    for (let i = 0; i < 10; i++) { await sleep(100); peak20b = Math.max(peak20b, await ev('window.__peak()')); }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: strip.x, y: strip.y, button: 'left', clickCount: 1 });
  }
  const label20b = await ev(`document.querySelector('[data-chord-strips] button')?.getAttribute('aria-label') ?? ''`);
  record('코드 스트립 — 1도 화음 누르는 동안 소리', peak20b > 0.001 && label20b.length > 0, `${label20b} · 피크 ${peak20b.toFixed(4)}`);
  await clickEl(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent === '드럼 패드')`);
  await sleep(200);
  const pads20 = await ev(`document.querySelector('[data-drum-pads]')?.innerText.replace(/\\n/g, ' ') ?? ''`);
  record('드럼 패드 화면', pads20.length > 0, pads20.slice(0, 80));
  await clickEl(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent === '건반')`);

  // 20c. Flashback — 녹음을 안 누르고 재생하며 친 것을 "담기" 로 클립에
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  await sleep(500);
  await ev(`document.activeElement?.blur(); 'ok'`);
  for (const code of ['KeyA', 'KeyD', 'KeyG']) await press(code);
  await sleep(300);
  const stop20c = await centerOf(byTitle('정지')); if (stop20c) await click(stop20c.x, stop20c.y);
  await sleep(300);
  await clickEl(`document.querySelector('button[title="녹음 방식 · 펀치 · 방금 연주 담기"]')`); await sleep(150); await clickEl(`[...document.querySelectorAll('[role=menu] button')].find((b) => b.textContent.includes('방금 연주 담기'))`);
  await sleep(400);
  const fb20 = await ev(`document.body.innerText.match(/방금 연주 \\d+음을 담았습니다|담을 [^\\n]*/)?.[0] ?? ''`);
  record('Flashback — 녹음 없이 친 연주를 담기', /방금 연주 [1-9]/.test(fb20), fb20);

  // 20b2. 템포 트랙 — 빈 곳을 누르면 템포 변화, 그 점을 두 번 누르면 지운다
  const tempoRow = await ev(`(() => { const e = document.querySelector('[data-global="tempo"] > div:last-child'); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const tempoCount = () => ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return ((p.project ?? p).tempo.changes ?? []).length; })()`);
  let tempoLog = 'row 없음';
  if (tempoRow) {
    const before = await tempoCount();
    await click(tempoRow.x + tempoRow.w * 0.5, tempoRow.y + tempoRow.h * 0.3);
    await sleep(400);
    const added = await tempoCount();
    const pt = await centerOf(`[...document.querySelectorAll('[data-tempo-point]')].at(-1)`);
    if (pt) {
      // 두 번 누르기 = 누르고 떼기 두 번 (둘째는 clickCount 2)
      for (const n of [1, 2]) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: n });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: n });
      }
    }
    await sleep(400);
    tempoLog = `${before} → ${added} → ${await tempoCount()}`;
  }
  const [tc0, tc1, tc2] = tempoLog.split(' → ').map(Number);
  record('템포 트랙 — 누르면 변화, 두 번 누르면 지움', tc1 === tc0 + 1 && tc2 === tc0, tempoLog);
  // 램프 — 다시 하나 놓고 Shift+누르기
  let rampLog = 'row 없음';
  if (tempoRow) {
    await click(tempoRow.x + tempoRow.w * 0.6, tempoRow.y + tempoRow.h * 0.7);
    await sleep(300);
    const rp = await centerOf(`[...document.querySelectorAll('[data-tempo-point]')].at(-1)`);
    if (rp) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rp.x, y: rp.y, button: 'left', clickCount: 1, modifiers: 8 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rp.x, y: rp.y, button: 'left', clickCount: 1, modifiers: 8 });
    }
    await sleep(300);
    rampLog = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return JSON.stringify((p.project ?? p).tempo.changes ?? []); })()`);
  }
  record('템포 램프 (Shift+누르기)', /"ramp":true/.test(rampLog), rampLog);
  // 20c1. 스크럽 — 눈금자를 누른 채 끌면 지나가는 음이 들린다
  const rulerS = await ev(`(() => { const e = document.querySelector('[data-ruler]'); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width }; })()`);
  let peakScrub = 0;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rulerS.x + 2, y: rulerS.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rulerS.x + 2 + (rulerS.w * 0.25 * i) / 12, y: rulerS.y, button: 'left', buttons: 1 });
    await sleep(60);
    peakScrub = Math.max(peakScrub, await ev('window.__peak()'));
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rulerS.x + 2 + rulerS.w * 0.25, y: rulerS.y, button: 'left', buttons: 0, clickCount: 1 });
  for (let i = 0; i < 4; i++) { await sleep(100); peakScrub = Math.max(peakScrub, await ev('window.__peak()')); }
  record('스크럽 — 눈금자를 끌면 지나가는 음', peakScrub > 0.001, `피크 ${peakScrub.toFixed(4)}`);
  // 20c2. 리전 에일리어스 — 고른 클립 뒤에 원본을 따르는 복사, 음 수가 같다
  await menuDo('클립', '에일리어스 만들기');
  await sleep(500);
  const alias20 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; for (const t of d.tracks) for (const c of t.clips) if (c.aliasOf) { const src = t.clips.find((x) => x.id === c.aliasOf) ?? d.tracks.flatMap((x) => x.clips).find((x) => x.id === c.aliasOf); return c.label + ':' + c.notes.length + '/' + (src?.notes.length ?? -1); } return ''; })()`);
  const m20 = /:(\d+)\/(\d+)$/.exec(alias20);
  record('리전 에일리어스 — 원본과 같은 음', !!m20 && m20[1] === m20[2] && Number(m20[1]) > 0, alias20 || '안 생김');
  // 만든 에일리어스가 골라져 있다 — 진짜 복사로 바꿔 둔다 (뒤 점검이 음 수를 센다)
  await menuDo('클립', '진짜 복사로');
  await sleep(400);
  const real20 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => t.clips).filter((c) => c.aliasOf).length; })()`);
  record('에일리어스 → 진짜 복사', real20 === 0, `남은 에일리어스 ${real20}`);
  // 20c3. 악보에서 고치기 — 오선을 누르면 음이 늘고, 고른 음을 Delete 로 지운다
  const notesNow = () => ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.reduce((a, t) => a + t.clips.reduce((b, c) => b + c.notes.length, 0), 0); })()`);
  await clickEl(`[...document.querySelectorAll('[aria-label="편집기 보기"] button')].find((x) => x.textContent === '악보')`);
  await sleep(500);
  const sc0 = await notesNow();
  const staff = await ev(`(() => { const s = document.querySelector('[data-score] svg'); if (!s) return null; s.scrollIntoView({ block: 'center' }); const r = s.getBoundingClientRect(); return { x: r.x + r.width * 0.62, y: r.y + 34 * r.width / 1000 }; })()`);
  let scoreLog = '악보 없음';
  let scoreDebug = '';
  if (staff) {
    // 화면 아래 알림이 악보 아랫부분을 덮을 수 있다 — 악보에 직접 누르기를 보낸다
    await ev(`(() => { const s = document.querySelector('[data-score] svg'); s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: ${staff.x}, clientY: ${staff.y}, pointerId: 1, button: 0, buttons: 1 })); return 'ok'; })()`);
    await sleep(400);
    await ev(`document.querySelector('[data-score] > div:last-child').focus(); 'ok'`);
    const sc1 = await notesNow();
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 });
    await sleep(400);
    scoreLog = `${sc0} → ${sc1} → ${await notesNow()}`;
    scoreDebug = await ev(`(() => { const s = document.querySelector('[data-score] svg'); const r = s.getBoundingClientRect(); const top = document.elementFromPoint(${staff.x}, ${staff.y}); return 'svg ' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' · 누른 곳 ' + (top?.tagName ?? '-') + ' · ' + (document.querySelector('[data-score] span')?.textContent ?? '') + ' · 알림 ' + (document.body.innerText.match(/[^\\n]*(클립|음)[^\\n]*닫기/)?.[0] ?? ''); })()`);
  }
  const [sn0, sn1, sn2] = scoreLog.split(' → ').map(Number);
  record('악보에서 음 넣기·지우기', sn1 === sn0 + 1 && sn2 === sn0, `${scoreLog} · ${scoreDebug}`);
  // 악보 기호 — 음을 골라 스타카토, 가사
  await ev(`(() => { const h = document.querySelector('[data-score] [data-note-head]'); h?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, buttons: 1 })); return 'ok'; })()`);
  await sleep(300);
  await clickEl(`document.querySelector('[aria-label="스타카토 (반 길이)"]')`);
  await sleep(300);
  await ev(`(() => { const i = document.querySelector('[aria-label="가사"]'); if (!i) return 'none'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '라'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`);
  await sleep(300);
  const marks22 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; const n = d.tracks.flatMap((t) => t.clips.flatMap((c) => c.notes)).find((x) => x.articulation); return n ? n.articulation + ':' + (n.lyric ?? '') : ''; })()`);
  const drawn22 = await ev(`document.querySelectorAll('[data-score] [data-articulation], [data-score] [data-dynamic]').length`);
  record('악보 기호 — 스타카토·가사 저장, 셈여림 표시', marks22 === 'staccato:라' && drawn22 > 0, `${marks22} · 그린 기호 ${drawn22}`);
  await clickEl(`[...document.querySelectorAll('[aria-label="편집기 보기"] button')].find((x) => x.textContent === '피아노 롤')`);
  // 20d. 바운스 인 플레이스 · 프리즈 — 트랙을 오디오로 렌더해 놓고, 얼렸다 녹인다
  const tracksBefore20 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return (p.project ?? p).tracks.length; })()`);
  await menuDo('트랙', '바운스 인 플레이스');
  let bounced = '';
  for (let i = 0; i < 60 && !bounced; i++) { await sleep(500); bounced = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; const t = d.tracks.find((x) => x.name.endsWith('(바운스)')); return t ? t.name + ':' + (t.clips[0]?.audio?.assetSec ?? 0).toFixed(1) + '초' : ''; })()`); }
  record('바운스 인 플레이스 — 오디오 트랙이 생김', bounced.length > 0, bounced || '안 생김');
  await clickEl(`[...document.querySelectorAll('[data-track]')][0]?.querySelector('button, select') ?? null`);
  await menuDo('트랙', '❄ 프리즈');
  let frozen20 = '';
  for (let i = 0; i < 60 && !frozen20; i++) { await sleep(500); frozen20 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; const t = d.tracks.find((x) => x.frozen); return t ? t.name + ' → ' + d.tracks.find((x) => x.id === t.frozen.audioTrackId)?.name : ''; })()`); }
  await menuDo('트랙', '❄ 녹이기');
  await sleep(500);
  const thawed20 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.some((x) => x.frozen || x.freezeOf) ? '남음' : '녹음'; })()`);
  record('프리즈 · 녹이기', frozen20.length > 0 && thawed20 === '녹음', `${frozen20 || '안 얼림'} · ${thawed20} · 트랙 ${tracksBefore20}개 시작`);

  const totalNotes = () => ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.reduce((n, t) => n + t.clips.reduce((m, c) => m + c.notes.length, 0), 0); })()`);
  const before20 = await totalNotes();
  await clickEl(`document.querySelector('[data-play-surface] button[aria-pressed]')`);
  await ev(`document.activeElement?.blur(); 'ok'`);
  await press('KeyA'); await press('KeyD', true); await press('KeyG');
  await sleep(300);
  const after20 = await totalNotes();
  const starts = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; const all = d.tracks.flatMap((t) => t.clips.flatMap((c) => c.notes.map((n) => c.startTick + n.startTick + ':' + n.pitch.midi))); return all.slice(-3).join(' '); })()`);
  const note20 = await ev(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "닫기" && b.parentElement?.textContent.length < 200)?.parentElement?.textContent ?? ""`);
  record('스텝 입력 — 세 음 중 Shift 는 화음', after20 - before20 === 3, `${before20} → ${after20} · 마지막 셋 ${starts} · 알림 ${note20}`);
  await clickEl(byText('스텝 입력 중'));
  await shot('16-play-surface');

  // 21. 이벤트 목록 — 숫자로 고치기, MIDI 변환
  await clickEl(`document.querySelector('[aria-label="건반"]')`);
  await clickEl(`[...document.querySelectorAll('[aria-label="편집기 보기"] button')].find((x) => x.textContent === '이벤트 목록')`);
  await sleep(200);
  const rows21 = await ev(`document.querySelectorAll('[data-note-row]').length`);
  const firstMidi = `document.querySelector('[data-note-row="0"] input[aria-label="MIDI"]')`;
  const before21 = Number(await ev(`${firstMidi}.value`));
  await ev(`(() => { const e = ${firstMidi}; e.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '${before21 + 1}'); e.dispatchEvent(new Event('input', { bubbles: true })); e.blur(); })()`);
  await sleep(300);
  const after21 = Number(await ev(`${firstMidi}.value`));
  record('이벤트 목록 — MIDI 숫자 고치기', rows21 > 0 && after21 === before21 + 1, `${rows21}줄 · ${before21} → ${after21}`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await sleep(150);
  await clickEl(byText('+옥타브'));
  await sleep(300);
  const oct21 = Number(await ev(`${firstMidi}.value`));
  record('MIDI 변환 — +옥타브', oct21 === after21 + 12 || oct21 === 127, `${after21} → ${oct21}`);
  await shot('17-event-list');

  // 22. 스텝 시퀀서 — 칸 켜기/끄기가 음을 찍고 지운다
  await clickEl(`[...document.querySelectorAll('[aria-label="편집기 보기"] button')].find((b) => b.textContent === '스텝')`);
  await sleep(200);
  const total22 = await totalNotes();
  await clickEl(`document.querySelector('[data-step-sequencer] button[aria-pressed="false"]')`);
  await sleep(300);
  const on22 = await totalNotes();
  await clickEl(`document.querySelector('[data-step-sequencer] button[aria-pressed="true"]')`);
  await sleep(300);
  const off22 = await totalNotes();
  record('스텝 칸 켜기·끄기', on22 === total22 + 1 && off22 === on22 - 1, `${total22} → ${on22} → ${off22}`);
  // 스텝 확률 — 켠 칸을 ⌘ 누르고 누르면 75%
  await clickEl(`document.querySelector('[data-step-sequencer] button[aria-pressed="false"]')`);
  await sleep(300);
  const cellP = await centerOf(`document.querySelector('[data-step-sequencer] button[aria-pressed="true"]')`);
  if (cellP) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cellP.x, y: cellP.y, button: 'left', clickCount: 1, modifiers: 4 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cellP.x, y: cellP.y, button: 'left', clickCount: 1, modifiers: 4 });
  }
  await sleep(300);
  const prob22 = await ev(`document.querySelector('[data-step-sequencer] [data-probability]')?.textContent ?? ''`);
  record('스텝 확률 (⌘ 누르기)', prob22 === '75%', prob22 || '표시 없음');
  await shot('18-steps');

  // 22b. 스크린셋 — ⇧+1 로 지금 배치(믹서)를 저장, 편집기로 옮긴 뒤 1 을 누르면 믹서로 돌아온다
  await ev(`document.activeElement?.blur(); 'ok'`);
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][1]`);
  await sleep(300);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Digit7', key: '&', modifiers: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Digit7', key: '&', modifiers: 8 });
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][0]`);
  await sleep(300);
  await ev(`document.activeElement?.blur(); 'ok'`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Digit7', key: '7' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Digit7', key: '7' });
  await sleep(400);
  const ss = await ev(`!!document.querySelector('[data-strip]')`);
  record('스크린셋 — ⇧+7 저장, 7 로 불러오기', ss === true, ss ? '믹서로 돌아옴' : '안 바뀜');
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][0]`);
  await sleep(300);

  // 23. 스마트 컨트롤 — 손잡이 끌기, MIDI 이펙트(아르페지에이터) 걸고 재생
  await clickEl(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.includes('컨트롤'))`);
  await sleep(200);
  const knob = await ev(`(() => { const e = document.querySelector('[data-smart-controls] svg[role=slider]'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, v: e.getAttribute('aria-valuenow') }; })()`);
  await mouse('mouseMoved', knob.x, knob.y, { buttons: 0 }); await mouse('mousePressed', knob.x, knob.y);
  for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', knob.x, knob.y - i * 8); await sleep(30); }
  await mouse('mouseReleased', knob.x, knob.y - 40); await sleep(300);
  const knobAfter = await ev(`document.querySelector('[data-smart-controls] svg[role=slider]').getAttribute('aria-valuenow')`);
  record('스마트 컨트롤 손잡이 끌기', Number(knobAfter) > Number(knob.v), `${knob.v} → ${knobAfter}`);
  // 매핑 — 손잡이 1 에 팬을 함께 물리고 거꾸로, 돌리면 볼륨과 팬이 같이 움직인다
  await clickEl(`document.querySelector('[aria-label="손잡이 1 매핑"]')`);
  await sleep(200);
  await ev(`(() => { const e = document.querySelector('[aria-label="함께 움직일 대상"]'); const opt = [...e.options].find((o) => o.value === 'pan'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, opt ? 'pan' : e.options[1].value); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  const before23 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; const t = d.tracks.find((x) => x.smartMaps); return t ? t.gain.toFixed(2) + '/' + t.pan.toFixed(2) + ' ' + JSON.stringify(t.smartMaps[0]) : ''; })()`);
  const knob2 = await ev(`(() => { const e = document.querySelector('[data-smart-controls] svg[role=slider]'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await mouse('mouseMoved', knob2.x, knob2.y, { buttons: 0 }); await mouse('mousePressed', knob2.x, knob2.y);
  for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', knob2.x, knob2.y + i * 8); await sleep(30); }
  await mouse('mouseReleased', knob2.x, knob2.y + 40); await sleep(300);
  const after23 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; const t = d.tracks.find((x) => x.smartMaps); return t ? t.gain.toFixed(2) + '/' + t.pan.toFixed(2) : ''; })()`);
  const [g0, p0] = before23.split(' ')[0].split('/').map(Number);
  const [g1, p1] = after23.split('/').map(Number);
  record('스마트 컨트롤 매핑 — 한 손잡이가 대상 둘', before23.includes('"extra"') && g1 !== g0 && p1 !== p0, `${before23} → ${after23}`);
  await ev(`(() => { const e = document.querySelector('[aria-label="MIDI 이펙트 추가"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'arpeggiator'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  const fx23 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.map((t) => (t.midiEffects ?? []).map((f) => f.type).join('+')).join(','); })()`);
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  let peak23 = 0; for (let i = 0; i < 10; i++) { await sleep(150); peak23 = Math.max(peak23, await ev('window.__peak()')); }
  const stop23 = await centerOf(byTitle('정지')); if (stop23) await click(stop23.x, stop23.y);
  record('MIDI 이펙트(아르페지에이터) 걸고 재생', fx23.includes('arpeggiator') && peak23 > 0.001, `${fx23} · 피크 ${peak23.toFixed(4)}`);
  await shot('19-smart-controls');

  // 24. 곡 고르기 — 템플릿 새 곡, 최근 곡으로 돌아오기, 버전 남기기·돌아가기
  const name24 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return (p.project ?? p).name; })()`);
  const tracksNow = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return (p.project ?? p).tracks.length; })()`);
  await clickEl(`document.querySelector('button[title^="파일"]')`);
  await clickEl(byText('새 곡 · 최근 곡 · 버전'));
  await clickEl(`document.querySelector('[data-template="band"]')`);
  await sleep(500);
  const band = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.name + ':' + d.tracks.length; })()`);
  record('템플릿으로 새 곡 (밴드)', band === '새 밴드:6', band);
  await clickEl(`document.querySelector('button[title^="파일"]')`);
  await clickEl(byText('새 곡 · 최근 곡 · 버전'));
  const recent24 = await ev(`[...document.querySelectorAll('[data-recent]')].map((e) => e.dataset.recent).join(',')`);
  await clickEl(`[...document.querySelectorAll('[data-recent="${name24}"] button')].find((b) => b.textContent === '열기')`);
  await sleep(500);
  const back24 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.name + ':' + d.tracks.length; })()`);
  record('최근 곡으로 돌아오기', recent24.includes(name24) && back24 === `${name24}:${tracksNow}`, `최근 [${recent24}] → ${back24}`);
  await clickEl(`document.querySelector('button[title^="파일"]')`);
  await clickEl(byText('새 곡 · 최근 곡 · 버전'));
  await ev(`(() => { const e = document.querySelector('[aria-label="버전 이름"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '점검 전'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await clickEl(byText('남기기'));
  await clickEl(`[...document.querySelectorAll('[role=dialog][aria-label="곡 고르기"] button')].find((b) => b.textContent === '닫기')`);
  await menuDo('트랙', '숨기기');
  await sleep(300);
  await clickEl(`document.querySelector('button[title^="파일"]')`);
  await clickEl(byText('새 곡 · 최근 곡 · 버전'));
  await clickEl(`[...document.querySelectorAll('[data-version="점검 전"] button')].find((b) => b.textContent === '돌아가기')`);
  await sleep(500);
  const hidden24 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.filter((t) => t.hidden).length; })()`);
  const versions24 = await ev(`Object.keys(localStorage).filter((k) => k.startsWith('library-version-')).length`);
  record('버전 남기기·돌아가기 (돌아가기 전 상태도 남음)', hidden24 === 0 && versions24 >= 2, `숨긴 트랙 ${hidden24} · 버전 ${versions24}개`);
  await shot('20-projects');

  // 25. 설정 — 단축키 바꾸기가 실제로 먹는다, 한글 입력과 상관없이 위치로
  await clickEl(`document.querySelector('[aria-label="설정"]')`);
  await clickEl(`[...document.querySelectorAll('[role=dialog][aria-label="설정"] [role=tab]')].find((b) => b.textContent === '단축키')`);
  await clickEl(`document.querySelector('[data-command="metronome"] button')`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyM', key: 'ㅡ' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyM', key: 'ㅡ' });
  await sleep(200);
  const bound = await ev(`document.querySelector('[data-command="metronome"] kbd')?.textContent`);
  await clickEl(`[...document.querySelectorAll('[role=dialog][aria-label="설정"] button')].find((b) => b.textContent === '닫기')`);
  const metroBefore = await ev(`document.querySelector('button[title="메트로놈"]').getAttribute('aria-pressed')`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyM', key: 'ㅡ' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyM', key: 'ㅡ' });
  await sleep(200);
  const metroAfter = await ev(`document.querySelector('button[title="메트로놈"]').getAttribute('aria-pressed')`);
  record('단축키 바꾸기 (한글 입력 상태 키로)', bound === 'M' && metroBefore !== metroAfter, `${bound} · 메트로놈 ${metroBefore} → ${metroAfter}`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyZ', key: 'ㅋ', modifiers: 4 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyZ', key: 'ㅋ', modifiers: 4 });
  await sleep(200);
  const metroUndo = await ev(`document.querySelector('button[title="메트로놈"]').getAttribute('aria-pressed')`);
  record('⌘Z 가 한글 입력 상태에서도 먹는다 (메트로놈은 곡이 아니라 언두 대상 아님)', metroUndo === metroAfter, String(metroUndo));
  await ev(`localStorage.removeItem('settings-v1'); 'ok'`);
  await shot('21-settings');

  // 26. 녹음 — 재생하며 자판으로 친 음이 클립에, 바꿔 녹음은 옛 음을 테이크로
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][0]`);
  const total26 = await totalNotes();
  await clickEl(`document.querySelector('[aria-label="녹음"]')`);
  await ev(`document.activeElement?.blur(); 'ok'`);
  await sleep(2800); // 카운트인 한 마디
  for (const code of ['KeyA', 'KeyD', 'KeyG']) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.slice(3).toLowerCase() });
    await sleep(250);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.slice(3).toLowerCase() });
    await sleep(150);
  }
  await clickEl(`document.querySelector('[aria-label="녹음"]')`);
  await sleep(600);
  const after26 = await totalNotes();
  const takes26 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => t.clips).reduce((n, c) => n + (c.takes ?? []).length, 0); })()`);
  const msg26 = await ev(`document.body.innerText.match(/\\d+음을 녹음했습니다[^\\n]*/)?.[0] ?? ''`);
  record('녹음 — 친 음이 클립에 (바꿔 녹음)', msg26.startsWith('3음') && after26 >= 3, `${total26} → ${after26} · 테이크 ${takes26} · ${msg26}`);
  await shot('22-recording');

  // 27. 라이브 루프 — 구간에서 장면, 장면 재생(소리), 편곡으로 붙이기
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')].find((b) => b.title === '라이브 루프')`);
  await sleep(300);
  await clickEl(byText('구간에서 장면 만들기'));
  await sleep(300);
  const scenes27 = await ev(`document.querySelectorAll('[data-scene]').length`);
  const bars27 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return (p.project ?? p).lengthBars; })()`);
  await clickEl(`document.querySelector('[data-scene] button')`);
  let peak27 = 0; for (let i = 0; i < 12; i++) { await sleep(150); peak27 = Math.max(peak27, await ev('window.__peak()')); }
  await clickEl(byText('모두 멈춤'));
  await sleep(200);
  await clickEl(`[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('편곡으로'))`);
  await sleep(400);
  const after27 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return (p.project ?? p).lengthBars; })()`);
  record('라이브 루프 — 장면 재생·편곡으로', scenes27 >= 1 && peak27 > 0.001 && after27 > bars27, `장면 ${scenes27} · 피크 ${peak27.toFixed(4)} · 마디 ${bars27} → ${after27}`);
  await shot('23-live-loops');

  // 28. 악보 — 그려지고, MusicXML 이 내려온다
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][0]`);
  await sleep(300);
  await clickEl(`[...document.querySelectorAll('[aria-label="편집기 보기"] button')].find((b) => b.textContent === '악보')`);
  await sleep(300);
  const measures28 = await ev(`document.querySelectorAll('[data-score] [data-measure]').length`);
  const heads28 = await ev(`document.querySelectorAll('[data-score] ellipse').length`);
  for (const f of readdirSync(DL)) rmSync(join(DL, f));
  await clickEl(byText('MusicXML 내보내기'));
  let xml28 = null;
  for (let i = 0; i < 20 && !xml28; i++) { await sleep(300); xml28 = readdirSync(DL).find((f) => f.endsWith('.musicxml')) ?? null; }
  const xmlText = xml28 ? readFileSync(join(DL, xml28), 'utf8') : '';
  record('악보 그리기·MusicXML', measures28 > 0 && heads28 > 0 && xmlText.includes('<score-partwise') && xmlText.includes('<note>'),
    `마디 ${measures28} · 음표 머리 ${heads28} · ${xml28} ${xmlText.length}B`);
  await shot('24-score');

  // 29. 오디오 — 파일 가져오기·편집기·재생, 마이크 녹음(가짜 장치)
  await clickEl(`[...document.querySelectorAll('[aria-label="편집기 보기"] button')][0]`);
  const sine = (() => {
    const sr = 48000, n = sr * 2, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / sr) * 12000), 44 + i * 2);
    return b;
  })();
  const wavPath = join(OUT, '사인 220.wav');
  writeFileSync(wavPath, sine);
  const doc = await send('DOM.getDocument', {});
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[aria-label="오디오 파일"]' });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [wavPath] });
  await sleep(1500);
  const audio29 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => t.clips.filter((c) => c.audio).map((c) => t.name + ':' + c.audio.name + ':' + c.audio.assetSec.toFixed(2))).join(' '); })()`);
  const editorShown = await ev(`!!document.querySelector('[data-audio-editor]')`);
  await sleep(800);
  const bars29 = await ev(`document.querySelectorAll('[data-audio-editor] svg rect').length`);
  record('오디오 가져오기 — 새 오디오 트랙에 클립, 편집기·파형', audio29.includes('2.00') && editorShown && bars29 > 100, `${audio29} · 파형 막대 ${bars29}`);
  await clickEl(`document.querySelector('[aria-label="게인"]')`);
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  let peak29 = 0; for (let i = 0; i < 12; i++) { await sleep(150); peak29 = Math.max(peak29, await ev('window.__peak()')); }
  const stop29 = await centerOf(byTitle('정지')); if (stop29) await click(stop29.x, stop29.y);
  record('오디오 클립 재생', peak29 > 0.01, `피크 ${peak29.toFixed(4)}`);
  // 마이크 녹음
  await clickEl(byText('＋ 오디오'));
  await sleep(300);
  const selected29 = await ev(`[...document.querySelectorAll('[data-track]')].map((e) => e.dataset.track).join(',')`);
  await clickEl(`document.querySelector('[aria-label="녹음"]')`);
  await sleep(2000);
  const rec29 = await ev(`document.querySelector('[aria-label="녹음"]').getAttribute('aria-pressed') + ' / ' + (document.body.innerText.match(/마이크[^\\n]*/)?.[0] ?? '')`);
  await clickEl(`document.querySelector('[aria-label="녹음"]')`);
  await sleep(2500);
  const mic29 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => t.clips.filter((c) => c.audio && c.audio.name.startsWith('녹음')).map((c) => c.audio.assetSec.toFixed(1))).join(','); })()`);
  record('마이크 녹음 (가짜 장치)', mic29.length > 0 && Number(mic29.split(',')[0]) > 0.5, `${mic29}초 · ${await ev(`document.body.innerText.match(/오디오 [\\d.]+초를 녹음|마이크를 열지[^\\n]*|녹음을 저장하지[^\\n]*/)?.[0] ?? ''`)}`);
  await shot('25-audio');

  // 29b. 묶음 파일 — ⌘S 로 소리까지 .zip, 에셋 저장소를 비운 뒤 그 파일을 열면 소리가 돌아온다
  for (const f of readdirSync(DL)) rmSync(join(DL, f));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyS', key: 's', modifiers: 4 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyS', key: 's', modifiers: 4 });
  let zip29 = null;
  for (let i = 0; i < 30 && !zip29; i++) { await sleep(300); zip29 = readdirSync(DL).find((f) => f.endsWith('.zip')) ?? null; }
  record('묶음 파일 저장 (소리 포함 .zip)', zip29 !== null, zip29 ?? '파일이 안 내려옴');
  if (zip29) {
    const zipPath = join(DL, zip29);
    await ev(`new Promise((r) => { const q = indexedDB.deleteDatabase('studio-assets'); q.onsuccess = q.onerror = q.onblocked = () => r('ok'); })`);
    const doc29 = await send('DOM.getDocument', {});
    const open29 = await send('DOM.querySelector', { nodeId: doc29.root.nodeId, selector: 'input[aria-label="곡 파일 열기"]' });
    await send('DOM.setFileInputFiles', { nodeId: open29.nodeId, files: [zipPath] });
    await sleep(2000);
    const back29 = await ev(`new Promise((r) => { const q = indexedDB.open('studio-assets', 1); q.onupgradeneeded = () => q.result.createObjectStore('audio'); q.onsuccess = () => { const t = q.result.transaction('audio', 'readonly').objectStore('audio').count(); t.onsuccess = () => r(t.result); }; })`);
    await clickEl(byTitle('맨 앞으로'));
    await clickEl(byTitle('커서부터 재생'));
    let peak29b = 0; for (let i = 0; i < 12; i++) { await sleep(150); peak29b = Math.max(peak29b, await ev('window.__peak()')); }
    const stop29b = await centerOf(byTitle('정지')); if (stop29b) await click(stop29b.x, stop29b.y);
    record('묶음 파일 열기 — 비운 저장소에 소리가 돌아와 재생', Number(back29) >= 2 && peak29b > 0.01, `에셋 ${back29}개 · 피크 ${peak29b.toFixed(4)}`);
  }

  // 30. 영상 — 가져오면 창이 뜨고 재생을 따라간다, 3D 패너가 걸린다
  //     ffmpeg 없이 브라우저에서 2초짜리 webm(캔버스 + 사인) 을 만들어 쓴다
  const b64 = await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d');
    const ac = new AudioContext(); const osc = ac.createOscillator(); const dest = ac.createMediaStreamDestination(); osc.connect(dest); osc.start();
    const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    let f = 0; const draw = setInterval(() => { g.fillStyle = 'hsl(' + (f++ * 12) + ',70%,50%)'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(String(f), 140, 100); }, 33);
    rec.start(); await new Promise((r) => setTimeout(r, 2000)); rec.stop(); await new Promise((r) => rec.onstop = r); clearInterval(draw); osc.stop(); ac.close();
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer()); let s = ''; for (const x of buf) s += String.fromCharCode(x); return btoa(s);
  })()`);
  const videoPath = join(OUT, '장면.webm');
  writeFileSync(videoPath, Buffer.from(b64, 'base64'));
  const doc30 = await send('DOM.getDocument', {});
  const node30 = await send('DOM.querySelector', { nodeId: doc30.root.nodeId, selector: 'input[aria-label="영상 파일"]' });
  await send('DOM.setFileInputFiles', { nodeId: node30.nodeId, files: [videoPath] });
  for (let i = 0; i < 20 && !(await ev(`!!document.querySelector('[data-video-panel] video')`)); i++) await sleep(300);
  await sleep(800);
  const video30 = await ev(`(() => { const v = document.querySelector('[data-video-panel] video'); return v ? v.readyState + ':' + v.duration.toFixed(1) : 'none'; })()`);
  await clickEl(byTitle('맨 앞으로'));
  await clickEl(byTitle('커서부터 재생'));
  await sleep(1200);
  const playingT = await ev(`document.querySelector('[data-video-panel] video')?.currentTime ?? -1`);
  const stop30 = await centerOf(byTitle('정지')); if (stop30) await click(stop30.x, stop30.y);
  record('영상 가져오기·재생 따라가기', video30 !== 'none' && playingT > 0.3, `영상 ${video30} · 재생 1.2초 뒤 영상 ${Number(playingT).toFixed(2)}초`);
  await clickEl(byText('장면 마커'));
  await sleep(300);
  const scene30 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return (d.markers ?? []).filter((m) => m.name.startsWith('장면')).length; })()`);
  record('장면 마커', scene30 >= 1, `${scene30}개`);
  await shot('26-video');

  // 31. 도우미 — 세션 건반 연주자(코드 따라), 마스터링 도우미(재고 적용)
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')].find((b) => b.title === '도우미')`);
  await sleep(300);
  const keysTrack = await ev(`document.querySelector('[aria-label="건반 트랙"] option:nth-child(2)').value`);
  await ev(`(() => { const e = document.querySelector('[aria-label="건반 트랙"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(keysTrack)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const before31 = await totalNotes();
  await clickEl(byText('건반 만들기'));
  await sleep(400);
  const after31 = await totalNotes();
  const msg31 = await ev(`document.body.innerText.match(/[^\\n]*(만들었습니다|코드 트랙이 비었다)[^\\n]*/)?.[0] ?? ''`);
  record('세션 건반 연주자', after31 > before31, `${before31} → ${after31} · ${msg31}`);
  await clickEl(byText('믹스 재기'));
  for (let i = 0; i < 60 && !(await ev(`!![...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('마스터에 적용'))`)); i++) await sleep(500);
  await sleep(400); // 결과가 뜨며 배치가 움직인다 — 자리 잡은 뒤에 누른다
  const lufs31 = await ev(`document.querySelector('[data-mastering] dl')?.innerText.replace(/\\n/g, ' ') ?? ''`);
  await clickEl(`[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('마스터에 적용'))`);
  await sleep(400);
  const master31 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); return (p.project ?? p).master.effects.map((e) => e.type).join('+'); })()`);
  record('마스터링 도우미 — 재고 적용', master31 === 'eq+compressor+limiter' && /LUFS/.test(lufs31), `${lufs31} · 마스터 ${master31}`);
  await shot('27-assistant');
  // 앞 단계들이 남긴 정리 — 편집기로 돌아와 기본 보기로
  await clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][0]`);
  await clickEl(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.includes('음 편집'))`);

  // 24. 화면 다시 짜기 (2026-11-21, `UX_REDESIGN.md`) — 한 줄 머리, 우클릭, 명령 찾기, 글로벌 기본 숨김
  await ev(`localStorage.removeItem('project-autosave-v1'); localStorage.removeItem('ui-globals'); 'ok'`);
  await ev(`localStorage.setItem('ui-globals', '0'); 'ok'`);
  await send('Page.reload'); await sleep(2500);
  const keyTap = async (code, key, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers });
    await sleep(250);
  };
  const gl0 = await ev(`document.querySelectorAll('[data-tempo-row], [data-global-row]').length + (document.body.textContent.includes('빈 곳을 눌러 마커 추가') ? 1 : 0)`);
  await ev(`document.activeElement?.blur(); 'ok'`);
  await keyTap('KeyG', 'g');
  const gl1 = await ev(`document.body.textContent.includes('빈 곳을 눌러 마커 추가') ? 1 : 0`);
  await keyTap('KeyG', 'g');
  const rows24 = await ev(`(() => { const h = document.querySelector('header'); const bars = [...document.querySelectorAll('header ~ div')].filter((d) => d.className.includes('h-11') && d.className.includes('border-b')); return { header: Math.round(h.getBoundingClientRect().height), editRows: bars.length, headerButtons: h.querySelectorAll(':scope > nav button, :scope > div > button').length }; })()`);
  record('한 줄 머리 — 편집 줄이 없고 글로벌 트랙은 기본 숨김 (G 로 켬)', gl0 === 0 && gl1 === 1 && rows24.editRows === 0 && rows24.header <= 64, `숨김 ${gl0} → G ${gl1} · ${JSON.stringify(rows24)}`);

  // 우클릭 — 클립 위에서 메뉴가 열리고, 누른 클립이 골라지고, 뮤트가 된다
  const clip24 = await centerOf(`[...document.querySelectorAll('[data-clip]')].at(-1)`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clip24.x, y: clip24.y, button: 'right', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clip24.x, y: clip24.y, button: 'right', clickCount: 1 });
  await sleep(300);
  const menu24 = await ev(`[...document.querySelectorAll('[role=menu][aria-label="클립"] button')].map((b) => b.textContent.trim()).join('/')`);
  await clickEl(`[...document.querySelectorAll('[role=menu] button')].find((b) => b.textContent.includes('클립 뮤트'))`);
  await sleep(300);
  const muted24 = await ev(`document.querySelectorAll('[data-clip][data-muted="true"]').length`);
  record('클립 우클릭 메뉴 → 뮤트', menu24.includes('나누기') && menu24.includes('클립 삭제') && muted24 === 1, `${menu24.slice(0, 80)} · 뮤트 ${muted24}`);
  // 트랙 이름 칸 우클릭 — 메뉴가 열리고 Esc 로 닫힌다
  const head24 = await ev(`(() => { const r = document.querySelector('[data-track-head]').getBoundingClientRect(); return { x: r.x + 14, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: head24.x, y: head24.y, button: 'right', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: head24.x, y: head24.y, button: 'right', clickCount: 1 });
  await sleep(300);
  const tmenu24 = await ev(`[...document.querySelectorAll('[role=menu][aria-label="트랙"] button')].map((b) => b.textContent.trim()).join('/')`);
  await keyTap('Escape', 'Escape');
  const closed24 = await ev(`document.querySelectorAll('[role=menu]').length`);
  record('트랙 우클릭 메뉴 · Esc 로 닫힘', tmenu24.includes('프리즈') && tmenu24.includes('트랙 삭제') && closed24 === 0, tmenu24.slice(0, 90));

  // 명령 찾기 (⌘K) — "메트로" 를 쳐서 Enter → 메트로놈이 켜진다
  const metro0 = await ev(`document.querySelector('button[title="메트로놈"]').getAttribute('aria-pressed')`);
  await keyTap('KeyK', 'k', 4);
  await ev(`(() => { const i = document.querySelector('[aria-label="명령 이름"]'); if (!i) return 'none'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '메트로'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  await sleep(250);
  const found24 = await ev(`[...document.querySelectorAll('[role=dialog][aria-label="명령 찾기"] button')].map((b) => b.textContent).join('|')`);
  await ev(`document.querySelector('[aria-label="명령 이름"]').focus(); 'ok'`);
  await keyTap('Enter', 'Enter');
  const metro1 = await ev(`document.querySelector('button[title="메트로놈"]').getAttribute('aria-pressed')`);
  record('명령 찾기 (⌘K) → 메트로놈', found24.includes('메트로놈') && metro0 !== metro1 && !(await ev(`!!document.querySelector('[role=dialog][aria-label="명령 찾기"]')`)), `${found24.slice(0, 60)} · ${metro0} → ${metro1}`);

  // 피아노 롤 우클릭 — 빈 곳은 음을 찍지 않고, 음 위는 그 음을 고르고 메뉴를 연다 (세기 +10%)
  const rc = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 }); await sleep(300); };
  // 새 곡의 클립은 비어 있다 — 먼저 하나 찍는다 (격자는 길어서 위쪽 보이는 곳을 누른다)
  await ev(`document.querySelector('.cursor-crosshair').scrollIntoView({ block: 'start' }); 'ok'`);
  const g24 = await ev(`(() => { const r = document.querySelector('.cursor-crosshair').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`);
  await click(g24.x + 60, g24.y + 50); await sleep(400);
  const n24a = await noteCount();
  const grid24 = { x: g24.x + 300, y: g24.y + 20 };
  await rc(grid24.x, grid24.y);
  const emptyMenu24 = await ev(`!!document.querySelector('[role=menu][aria-label="음"]')`);
  await keyTap('Escape', 'Escape');
  const n24b = await noteCount();
  const note24 = await centerOf(`document.querySelector('.cursor-crosshair [role=button]')`);
  const vel = () => ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return d.tracks.flatMap((t) => t.clips.flatMap((c) => c.notes.map((n) => n.velocity))).reduce((a, b) => a + b, 0).toFixed(3); })()`);
  const v24a = await vel();
  if (note24) { await rc(note24.x, note24.y); await clickEl(`[...document.querySelectorAll('[role=menu][aria-label="음"] button')].find((b) => b.textContent.includes('세기 +10%'))`); await sleep(400); }
  const v24b = await vel();
  record('피아노 롤 우클릭 — 빈 곳은 안 찍고, 음 위는 골라서 메뉴', emptyMenu24 && n24a === n24b && !!note24 && Number(v24b) > Number(v24a), `음 ${n24a}→${n24b} · 세기 합 ${v24a}→${v24b}`);

  // 알림은 떠서 나온다 — 편집기가 밀리지 않는다 · 오른쪽 칸 접기(I)
  const top0 = await ev(`Math.round(document.querySelector('[data-lane]').getBoundingClientRect().y)`);
  await menuDo('클립', '에일리어스 만들기');
  await sleep(300);
  const toast24 = await ev(`(() => { const t = document.querySelector('[data-toast]'); return t ? getComputedStyle(t).position : 'none'; })()`);
  const top1 = await ev(`Math.round(document.querySelector('[data-lane]').getBoundingClientRect().y)`);
  await ev(`document.activeElement?.blur(); 'ok'`);
  const w0 = await ev(`Math.round(document.querySelector('[data-lane]').getBoundingClientRect().width)`);
  await keyTap('KeyI', 'i');
  const w1 = await ev(`Math.round(document.querySelector('[data-lane]').getBoundingClientRect().width)`);
  await keyTap('KeyI', 'i');
  record('알림이 화면을 안 밀고, I 로 오른쪽 칸을 접는다', toast24 === 'fixed' && top0 === top1 && w1 > w0 + 200, `알림 ${toast24} · 레인 y ${top0}→${top1} · 폭 ${w0}→${w1}`);


  // 25. 설정 오디오 탭 — 장치·지연·스피커 배치 (2026-11-22). 웹에서는 서라운드가 잠겨 있고 이유를 말한다
  await clickEl(byTitle('맨 앞으로')); await clickEl(byTitle('커서부터 재생')); await sleep(600);
  { const st = await centerOf(byTitle('정지')); if (st) await click(st.x, st.y); }
  await clickEl(`document.querySelector('[aria-label="설정"]')`); await sleep(300);
  await clickEl(`[...document.querySelectorAll('[role=dialog][aria-label="설정"] [role=tab]')].find((b) => b.textContent === '오디오')`); await sleep(500);
  const audio25 = await ev(`(() => { const t = document.querySelector('[data-audio-tab]'); if (!t) return null; return { out: !!t.querySelector('[aria-label="출력 장치"]'), inp: !!t.querySelector('[aria-label="입력 장치"]'), info: t.querySelector('[data-audio-info]')?.textContent ?? '', locked: t.querySelector('[data-layout="5.1"]')?.dataset.available, stereo: t.querySelector('[data-layout="stereo"]')?.dataset.available, reason: t.querySelector('[data-surround-reason]')?.textContent ?? '' }; })()`);
  await clickEl(`[...document.querySelectorAll('[data-audio-tab] button')].find((b) => b.textContent === '크게')`); await sleep(300);
  const latency25 = await ev(`JSON.parse(localStorage.getItem('settings-v1') ?? '{}').latency`);
  await clickEl(`[...document.querySelectorAll('[data-audio-tab] button')].find((b) => b.textContent === '작게')`); await sleep(200);
  await clickEl(`[...document.querySelectorAll('[role=dialog][aria-label="설정"] button')].find((b) => b.textContent === '닫기')`);
  record('설정 오디오 탭 — 장치 칸·지금 값·지연 저장, 웹은 서라운드 잠김과 이유', !!audio25 && audio25.out && audio25.inp && /kHz/.test(audio25.info) && audio25.locked === 'false' && audio25.stereo === 'true' && /설치형/.test(audio25.reason) && latency25 === 'playback', JSON.stringify(audio25).slice(0, 260) + ' · ' + latency25);
  // 프로필 단추 — 로그인 전에도 늘 보이고, 계정 창이 "안 해도 된다"고 말한다
  await clickEl(`document.querySelector('[aria-label="계정"]')`); await sleep(400);
  const acct25 = await ev(`document.querySelector('[role=dialog][aria-label="계정"]')?.textContent ?? ''`);
  await clickEl(`[...document.querySelectorAll('[role=dialog][aria-label="계정"] button')].find((b) => b.textContent === '닫기')`);
  record('프로필 단추 · 로그인 전 계정 창', acct25.includes('로그인하지 않아도') && acct25.includes('로그인 · 가입'), acct25.slice(0, 60));

} catch (err) {
  record('스크립트 실행', false, String(err.stack ?? err).slice(0, 500));
} finally {
  console.log('\n화면 캡처·결과: ' + OUT);
  console.log(`서버 미기동으로 인한 요청 실패 ${expected.length}건 (무시): ${[...new Set(expected)].join(', ')}`);
  console.log('콘솔 오류·예외 ' + problems.length + '건');
  for (const p of [...new Set(problems)].slice(0, 15)) console.log('  · ' + p);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ results, problems }, null, 2));
  try { ws?.close(); } catch {}
  chrome.kill();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

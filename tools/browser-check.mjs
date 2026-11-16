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
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', 'about:blank',
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
  await clickEl(byText('WAV 내보내기'));
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
  await clickEl(byText('반복')); await settle();
  const sRepeat = await shape();
  record('클립 반복', sRepeat.split(',').length > s0.split(',').length, `${s0}  →  ${sRepeat}`);

  const ruler = await ev(`(() => { const r = document.querySelector('[title="클릭해 재생 위치를 옮깁니다"]').getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2 }; })()`);
  await click(ruler.x + 336, ruler.y);
  await clickEl(byText('나누기')); await settle();
  const sSplit = await shape();
  record('클립 나누기 (커서 위치)', sSplit.split(',').length === sRepeat.split(',').length + 1, sSplit);

  await clickEl(byTitle('되돌리기')); await settle();
  const sUndo = await shape();
  await clickEl(byTitle('다시 실행')); await settle();
  record('나누기 되돌리기', sUndo === sRepeat && (await shape()) === sSplit, sUndo);

  await clickEl(byText('합치기')); await settle();
  const sJoin = await shape();
  record('클립 합치기 (다음 클립과)', sJoin.split(',').length === sSplit.split(',').length - 1, sJoin);

  await clickEl(byText('트랙 복제')); await settle();
  const sDup = await shape();
  record('트랙 복제', sDup.split(' | ').length === 2 && sDup.split(' | ')[1].includes('복사'), sDup);
  await clickEl(`document.querySelector('[aria-label="트랙 위로"]')`); await settle();
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
  await clickEl(`document.querySelector('[aria-label="다음 마커"]')`);
  const lcdPos = await ev(`document.querySelector('[aria-label="재생 위치"]').textContent`);
  record('다음 마커로 이동', lcdPos !== '1.1.00', `LCD ${lcdPos}`);
  await clickEl(`document.querySelector('[aria-label="재생 위치"]')`);
  const lcdTime = await ev(`document.querySelector('[aria-label="재생 위치"]').textContent`);
  record('LCD 분:초 전환', /^\d+:\d\d\.\d$/.test(lcdTime), lcdTime);
  await clickEl(byText('클립 뮤트')); await sleep(300);
  d13 = await saved13();
  record('클립 뮤트', d13.tracks.some((t) => t.clips.some((c) => c.muted === true)), '');
  await send('Page.reload'); await sleep(2500);
  const d13b = await saved13();
  record('글로벌 트랙 새로고침 뒤 유지', d13b.sections?.length === 2 && d13b.signatureChanges?.length === 1 && d13b.markers?.length >= 2,
    `구간 ${d13b.sections?.length} · 박자 변화 ${d13b.signatureChanges?.length} · 마커 ${d13b.markers?.length}`);
  await shot('09-global');

  // 14. 트랙 보호·카운트인·스택
  const notes14 = await noteCount();
  await clickEl(byTitle('고른 트랙을 보호합니다'));
  const g14 = await ev(`(() => { const r = document.querySelector('.cursor-crosshair').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  await click(g14.x + 100, g14.y + 40);
  const blockedMsg = await ev(`document.body.innerText.includes('보호돼 있습니다')`);
  record('보호된 트랙은 음을 못 찍는다', (await noteCount()) === notes14 && blockedMsg, `음 ${notes14} → ${await noteCount()}, 알림 ${blockedMsg}`);
  await clickEl(byTitle('고른 트랙을 보호합니다'));
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
  await ev(`(() => { const e = document.querySelector('[aria-label="트랙 스택"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'new'); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(300);
  const d14 = await ev(`(() => { const p = JSON.parse(localStorage.getItem('project-autosave-v1')); const d = p.project ?? p; return { stacks: (d.stacks ?? []).length, member: d.tracks.some((t) => t.stackId) }; })()`);
  record('트랙 스택 만들기', d14.stacks === 1 && d14.member, JSON.stringify(d14));
  await shot('10-tracks');
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

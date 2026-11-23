// 시나리오 점검 — 곡을 **코드로 만들어** 앱에 넣고, 사용자가 할 법한 흐름을 끝까지 눌러 본다.
//
// `browser-check.mjs` 는 화면 하나하나를 눌러 보고, 이 스크립트는 "이런 곡을 이렇게 내보내면?" 을 본다:
// 형식마다 내려받은 파일을 다시 풀어 길이·크기·소리를 재고, MIDI·악보·곡 파일은 되읽어 비교한다.
//
//   npm run dev                (다른 터미널)
//   npm run check:scenarios    [주소] [--only=이름,이름]
//
// 결과는 임시 폴더에 남고, 끝날 때 경로를 찍는다. **귀로 하는 판정은 대신하지 못한다.**
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEMO_SONGS } from '../src/model/songs.ts';
import { createClip, createEmptyProject, createNote, createTrack, projectLengthTicks } from '../src/model/factory.ts';
import { deserializeProject, serializeProject } from '../src/model/persistence.ts';
import { decodeMidi } from '../src/model/midi.ts';
import { readZip } from '../src/audio/zip.ts';
import { decodeWav, readWavHeader } from '../src/audio/wav.ts';
import { TEMPLATES, projectFromTemplate } from '../src/model/templates.ts';
import { PPQ, ticksToSeconds } from '../src/model/time.ts';
import { barStartTick } from '../src/model/meter.ts';
import { encodeWav } from '../src/audio/wav.ts';

const DIR = join(tmpdir(), 'studio-scenario-check');
const OUT = join(DIR, 'run');
const DL = join(OUT, 'downloads');
const PROFILE = join(DIR, 'chrome-profile');
const args = process.argv.slice(2);
const URL_APP = args.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:5173/';
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? []).filter(Boolean);
const PORT = 9334;
const FILE_PORT = 9434;
rmSync(OUT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

// 내려받은 파일을 화면이 다시 읽게 — 브라우저의 디코더로 풀어 본다
const fileServer = createServer((req, res) => {
  const path = join(DL, decodeURIComponent((req.url ?? '/').slice(1)));
  if (!existsSync(path)) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Length': statSync(path).size });
  res.end(readFileSync(path));
}).listen(FILE_PORT, '127.0.0.1');

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,900', '--force-device-scale-factor=1', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const problems = [];
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
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && /favicon|\/v1\//.test(msg.params.entry.url ?? '')) return;
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
const byText = (t, scope = 'document') => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(t)}))`;
const byExact = (t, scope = 'document') => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(t)})`;
const byTitle = (t) => `[...document.querySelectorAll('button')].find((b) => (b.title || '').includes(${JSON.stringify(t)}))`;
const fileMenu = async (item) => { await clickEl(byTitle('파일 — 저장')); await sleep(150); await clickEl(byText(item)); };
const DIALOG = `document.querySelector('[role=dialog][aria-label="내보내기"]')`;
const toast = () => ev(`document.querySelector('[data-toast]')?.innerText ?? ''`);
const setSelect = (sel, pick) => ev(`(() => { const e = ${sel}; if (!e) return false; const o = [...e.options].find(${pick}); if (!o) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, o.value); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const setFiles = async (selector, files) => {
  const doc = await send('DOM.getDocument', {});
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!node.nodeId) throw new Error('파일 입력 없음: ' + selector);
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
};

const clearDownloads = () => { for (const f of readdirSync(DL)) rmSync(join(DL, f), { force: true }); };
/** 조건에 맞는 파일이 다 내려올 때까지 (`.crdownload` 가 사라지고 크기가 멎을 때까지) */
async function waitDownload(match, timeoutMs = 120000, giveUp = null) {
  const until = Date.now() + timeoutMs;
  let last = -1; let idle = 0;
  while (Date.now() < until) {
    // 앱이 이미 손을 뗐는데(실패) 파일이 없으면 더 기다리지 않는다
    if (giveUp && !readdirSync(DL).length) { idle = (await giveUp()) ? idle + 1 : 0; if (idle > 32) return null; }
    const names = readdirSync(DL);
    const name = names.find((f) => !f.endsWith('.crdownload') && match(f));
    if (name && !names.some((f) => f.endsWith('.crdownload'))) {
      const size = statSync(join(DL, name)).size;
      if (size > 0 && size === last) return name;
      last = size;
    }
    await sleep(250);
  }
  return null;
}

/** 곡을 자동 저장 자리에 넣고 새로 연다 — 화면은 그 곡으로 시작한다 */
async function loadProject(project) {
  const text = serializeProject(project);
  // 시나리오마다 새 곡이라 보관함이 금방 찬다 — 점검이 넣는 곡은 보관함을 비우고 넣는다 (차는 경우는 '저장소' 가 따로 본다)
  await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('library-')) localStorage.removeItem(k); localStorage.setItem('project-autosave-v1', ${JSON.stringify(text)}); })()`);
  await send('Page.reload', {});
  for (let i = 0; i < 40; i++) { await sleep(250); if (await ev(`!!document.querySelector('button[aria-label="설정"]')`).catch(() => false)) break; }
  await sleep(1200);
}
const savedProject = async () => deserializeProject(await ev(`localStorage.getItem('project-autosave-v1')`));

const openExport = async () => {
  if (await ev(`!!${DIALOG}`)) return;
  await clickEl(byExact('내보내기'));
  await sleep(200);
};
/**
 * 내보내기 창을 열어 옵션을 맞추고 누른다. 창은 새로 열 때마다 기본값(WAV·24bit·48k·꼬리 켬)이라
 * 시나리오마다 닫았다 연다.
 */
async function bounce(o = {}) {
  if (await ev(`!!${DIALOG}`)) { await clickEl(byExact('닫기', DIALOG)); await sleep(150); }
  await openExport();
  const format = o.format ?? 'wav';
  await clickEl(`${DIALOG}.querySelector('[data-format="${format}"]')`);
  if (o.depth) await clickEl(byText(o.depth === 16 ? '16bit' : o.depth === 32 ? '32bit' : '24bit', DIALOG));
  if (o.kbps) await clickEl(byExact(`${o.kbps}k`, DIALOG));
  if (o.rate === 44100) await clickEl(byText('44.1 kHz', DIALOG));
  if (o.range) { if (!(await setSelect(`${DIALOG}.querySelector('select')`, `(x) => x.textContent.includes(${JSON.stringify(o.range)})`))) throw new Error('범위 없음: ' + o.range); }
  const boxes = `[...${DIALOG}.querySelectorAll('input[type=checkbox]')]`;
  if (o.tail === false) await ev(`${boxes}[0].click()`);
  if (o.normalize) await ev(`${boxes}[1].click()`);
  if (o.stems) await ev(`${boxes}[2].click()`);
  await sleep(100);
  clearDownloads();
  await clickEl(`[...${DIALOG}.querySelectorAll('button')].find((b) => b.className.includes('bg-cta'))`);
  const ext = o.stems ? 'zip' : (o.ext ?? format);
  const busy = `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('내보내는 중'))`;
  const name = await waitDownload((f) => f.endsWith('.' + ext), o.timeoutMs ?? 120000, async () => !(await ev(busy)));
  for (let i = 0; i < 40 && await ev(`${DIALOG} ? [...${DIALOG}.querySelectorAll('button')].some((b) => b.textContent.includes('내보내는 중')) : false`); i++) await sleep(250);
  return name;
}

/** 내려받은 파일을 브라우저 디코더로 풀어 잰다. `rate` 로 풀어 다시 샘플링이 끼지 않게 */
const probeAudio = (name, rate = 48000) => ev(`(async () => {
  try {
    const bytes = await (await fetch('http://127.0.0.1:${FILE_PORT}/' + encodeURIComponent(${JSON.stringify(name)}))).arrayBuffer();
    const size = bytes.byteLength;
    const head = [...new Uint8Array(bytes.slice(0, 12))];
    const ctx = new OfflineAudioContext(2, 1, ${rate});
    const buf = await ctx.decodeAudioData(bytes);
    let peak = 0, sum = 0; const env = [];
    const win = Math.round(buf.sampleRate * 0.05);
    const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
    for (let i = 0; i < buf.length; i += win) {
      let e = 0; const to = Math.min(buf.length, i + win);
      for (let j = i; j < to; j++) { const l = a[j], r = b[j]; peak = Math.max(peak, Math.abs(l), Math.abs(r)); e += l * l + r * r; }
      sum += e; env.push(Math.sqrt(e / (2 * (to - i))));
    }
    window.__decoded = window.__decoded || {};
    window.__decoded[${JSON.stringify(name)}] = [a.slice(), b.slice()];
    return { ok: true, size, head, sampleRate: buf.sampleRate, channels: buf.numberOfChannels, seconds: buf.duration, peak, rms: Math.sqrt(sum / (2 * buf.length)), env };
  } catch (e) { return { ok: false, why: String(e) }; }
})()`);
/** 두 파일의 표본 차 — 무손실끼리 비교할 때. 뒤 파일을 `lag` 만큼 당겨 맞춘다 */
const diffAudio = (nameA, nameB) => ev(`(() => {
  const A = window.__decoded?.[${JSON.stringify(nameA)}], B = window.__decoded?.[${JSON.stringify(nameB)}];
  if (!A || !B) return null;
  const n = Math.min(A[0].length, B[0].length); let max = 0;
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(A[ch][i] - B[ch][i]));
  return { max, lenA: A[0].length, lenB: B[0].length };
})()`);
/** 소리의 윤곽(50ms 창)이 얼마나 닮았나 — 손실 형식은 표본이 아니라 윤곽으로 본다. 인코더 지연은 ±3칸까지 밀어 본다 */
function envelopeMatch(a, b) {
  let best = -1;
  for (let lag = -3; lag <= 3; lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < a.length; i++) { const j = i + lag; if (j < 0 || j >= b.length) continue; xy += a[i] * b[j]; xx += a[i] * a[i]; yy += b[j] * b[j]; }
    if (xx > 0 && yy > 0) best = Math.max(best, xy / Math.sqrt(xx * yy));
  }
  return best;
}
/** 열쇠 순서와 무관하게 견준다 */
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const MAGIC = {
  wav: (h) => String.fromCharCode(...h.slice(0, 4)) === 'RIFF' && String.fromCharCode(...h.slice(8, 12)) === 'WAVE',
  flac: (h) => String.fromCharCode(...h.slice(0, 4)) === 'fLaC',
  mp3: (h) => String.fromCharCode(...h.slice(0, 3)) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0),
  m4a: (h) => String.fromCharCode(...h.slice(4, 8)) === 'ftyp',
  mp4: (h) => String.fromCharCode(...h.slice(4, 8)) === 'ftyp',
  ogg: (h) => String.fromCharCode(...h.slice(0, 4)) === 'OggS',
  webm: (h) => h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3,
};

// ───────── 곡 만들기 ─────────
const song = (id) => DEMO_SONGS.find((s) => s.id === id).build();
const secOf = (project, ticks) => (ticks / PPQ) * (60 / project.tempo.bpm);
/** 한 트랙에 4분음표 `count` 개 */
function simpleProject(name, { bars = 4, instrument = 'acoustic-piano', notes = 8, bpm = 120 } = {}) {
  const p = createEmptyProject(name);
  p.tempo = { ...p.tempo, bpm };
  p.lengthBars = bars;
  const track = createTrack({ name: '피아노', instrumentId: instrument });
  const clip = createClip({ startTick: 0, lengthTick: bars * 4 * PPQ });
  for (let i = 0; i < notes; i++) clip.notes.push(createNote({ startTick: i * PPQ, lengthTick: PPQ, midi: 60 + (i % 8), velocity: 0.8 }));
  track.clips.push(clip);
  p.tracks.push(track);
  return p;
}

const scenarios = [];
const scenario = (name, run) => scenarios.push({ name, run });

// ───────── 1. 형식마다 내보내고 다시 풀어 본다 ─────────
scenario('형식', async () => {
  const project = song('first-snow-night');
  await loadProject(project);
  const intro = project.sections[0];
  const want = secOf(project, intro.lengthTick) + 2; // 꼬리 2초
  const ref = await bounce({ range: intro.name });
  const refProbe = ref ? await probeAudio(ref) : null;
  record('형식 · WAV 24bit (기준)', !!refProbe?.ok && MAGIC.wav(refProbe.head) && Math.abs(refProbe.seconds - want) < 0.05 && refProbe.peak > 0.05,
    refProbe?.ok ? `${refProbe.seconds.toFixed(2)}초(기대 ${want.toFixed(2)}) · 피크 ${db(refProbe.peak).toFixed(1)}dB · ${(refProbe.size / 1024).toFixed(0)}KB` : (refProbe?.why ?? '파일이 안 내려옴'));
  if (!refProbe?.ok) return;
  const refBytes = readFileSync(join(DL, ref));
  writeFileSync(join(OUT, 'ref.wav'), refBytes);

  const matrix = [
    { label: 'WAV 16bit', o: { format: 'wav', depth: 16 }, lossless: 1.2 / 32768 * 2 },
    { label: 'WAV 32bit float', o: { format: 'wav', depth: 32 }, lossless: 3 / 8388607 },
    { label: 'FLAC 24bit', o: { format: 'flac', depth: 24 }, lossless: 3 / 8388607, smaller: true },
    { label: 'FLAC 16bit', o: { format: 'flac', depth: 16 }, lossless: 1.2 / 32768 * 2, smaller: true },
    { label: 'MP3 128k', o: { format: 'mp3', kbps: 128 }, kbps: 128 },
    { label: 'MP3 320k', o: { format: 'mp3', kbps: 320 }, kbps: 320 },
    { label: 'M4A 256k', o: { format: 'm4a', kbps: 256 }, kbps: 256 },
    { label: 'OGG 192k', o: { format: 'ogg', kbps: 192 }, kbps: 192 },
    { label: 'WAV 44.1k', o: { format: 'wav', rate: 44100 }, rate: 44100 },
    { label: 'FLAC 44.1k', o: { format: 'flac', rate: 44100 }, rate: 44100 },
    { label: 'MP3 44.1k 192k', o: { format: 'mp3', rate: 44100, kbps: 192 }, rate: 44100, kbps: 192 },
    { label: 'M4A 44.1k 128k', o: { format: 'm4a', rate: 44100, kbps: 128 }, rate: 44100, kbps: 128 },
  ];
  for (const m of matrix) {
    const name = await bounce({ ...m.o, range: intro.name });
    if (!name) { record(`형식 · ${m.label}`, false, `파일이 안 내려옴 · ${await toast()}`); continue; }
    // 기준 파일도 같이 둔다 (비교하려고)
    writeFileSync(join(DL, 'ref.wav'), refBytes);
    const rate = m.rate ?? 48000;
    const p = await probeAudio(name, rate);
    if (!p.ok) { record(`형식 · ${m.label}`, false, p.why); continue; }
    const checks = [];
    checks.push(['머리', MAGIC[m.o.format](p.head)]);
    checks.push(['표본율', p.sampleRate === rate]);
    checks.push(['길이', Math.abs(p.seconds - want) < (m.kbps ? 0.12 : 0.05)]);
    checks.push(['채널', p.channels === 2]);
    let extra = '';
    if (rate === 48000) {
      const match = envelopeMatch(refProbe.env, p.env);
      checks.push(['윤곽', match > (m.kbps ? 0.97 : 0.999)]);
      checks.push(['피크', Math.abs(db(p.peak) - db(refProbe.peak)) < (m.kbps ? 1.5 : 0.1)]);
      extra += ` · 윤곽 ${match.toFixed(4)}`;
      if (m.lossless) {
        await probeAudio('ref.wav');
        const d = await diffAudio('ref.wav', name);
        checks.push(['무손실', !!d && d.max <= m.lossless && d.lenA === d.lenB]);
        extra += ` · 표본 차 ${d ? d.max.toExponential(1) : '?'}`;
      }
    } else checks.push(['소리', p.peak > 0.05]);
    if (m.smaller) checks.push(['크기', p.size < refProbe.size * 0.9]);
    if (m.kbps) {
      const actual = (p.size * 8) / p.seconds / 1000;
      checks.push(['비트레이트', actual > m.kbps * 0.45 && actual < m.kbps * 1.25]);
      extra += ` · 실제 ${actual.toFixed(0)}kbps`;
    }
    const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
    record(`형식 · ${m.label}`, bad.length === 0, `${name.split('.').pop()} ${(p.size / 1024).toFixed(0)}KB · ${p.seconds.toFixed(2)}초 · 피크 ${db(p.peak).toFixed(1)}dB${extra}${bad.length ? ' · 어긋남: ' + bad.join(',') : ''}`);
  }
  await shot('s1-formats');
});

// ───────── 2. 스템 — 형식마다, 트랙 수만큼 ─────────
scenario('스템', async () => {
  const project = song('little-bells');
  await loadProject(project);
  const sec = project.sections[0];
  for (const format of ['wav', 'mp3', 'flac']) {
    const name = await bounce({ format, stems: true, range: sec.name, timeoutMs: 240000 });
    if (!name) { record(`스템 · ${format.toUpperCase()}`, false, `ZIP 이 안 내려옴 · ${await toast()}`); continue; }
    const entries = readZip(new Uint8Array(readFileSync(join(DL, name))));
    const names = [...entries.keys()];
    const allExt = names.every((n) => n.endsWith('.' + format));
    const unique = new Set(names).size === names.length;
    const nonEmpty = [...entries.values()].every((b) => b.length > 500);
    record(`스템 · ${format.toUpperCase()}`, names.length === project.tracks.length && allExt && unique && nonEmpty,
      `${names.length}개(트랙 ${project.tracks.length}) · ${names.slice(0, 3).join(', ')}…`);
  }
});

// ───────── 3. 범위 · 꼬리 · 노멀라이즈 ─────────
scenario('범위', async () => {
  const project = song('little-bells'); // 3/4
  project.loop = { startTick: project.sections[1].startTick, endTick: project.sections[1].startTick + 2 * 3 * PPQ };
  await loadProject(project);
  const whole = await bounce({ format: 'flac', timeoutMs: 240000 });
  const wp = whole ? await probeAudio(whole) : null;
  const wantWhole = secOf(project, projectLengthTicks(project)) + 2;
  record('범위 · 곡 전체 (3/4 · 32마디)', !!wp?.ok && Math.abs(wp.seconds - wantWhole) < 0.05, wp?.ok ? `${wp.seconds.toFixed(2)}초 (기대 ${wantWhole.toFixed(2)})` : (wp?.why ?? '없음'));

  const loop = await bounce({ range: '반복 구간', tail: false });
  const lp = loop ? await probeAudio(loop) : null;
  const wantLoop = secOf(project, 2 * 3 * PPQ);
  const tailEnd = lp?.ok ? lp.env[lp.env.length - 1] : 1;
  record('범위 · 반복 구간, 꼬리 없이', !!lp?.ok && Math.abs(lp.seconds - wantLoop) < 0.02, lp?.ok ? `${lp.seconds.toFixed(3)}초 (기대 ${wantLoop.toFixed(3)}) · 끝 50ms 크기 ${tailEnd.toFixed(4)}` : (lp?.why ?? '없음'));

  const norm = await bounce({ range: project.sections[3].name, normalize: true });
  const np = norm ? await probeAudio(norm) : null;
  const meas = await ev(`document.querySelector('[aria-label="내보낸 파일 측정"]')?.innerText ?? ''`);
  record('범위 · 구간 + 노멀라이즈 −1dB', !!np?.ok && Math.abs(db(np.peak) + 1) < 0.05 && /LUFS/.test(meas), np?.ok ? `피크 ${db(np.peak).toFixed(2)}dB · ${meas.replace(/\n/g, ' ').slice(0, 60)}` : (np?.why ?? '없음'));

  const normMp3 = await bounce({ format: 'mp3', kbps: 320, range: project.sections[3].name, normalize: true });
  const mp = normMp3 ? await probeAudio(normMp3) : null;
  record('범위 · MP3 + 노멀라이즈 (넘치지 않게)', !!mp?.ok && db(mp.peak) < 0.5 && db(mp.peak) > -3, mp?.ok ? `풀어 본 피크 ${db(mp.peak).toFixed(2)}dB` : (mp?.why ?? '없음'));
});

// ───────── 4. 가장자리 — 빈 곡, 이상한 이름, 소리 없는 곡 ─────────
scenario('가장자리', async () => {
  await loadProject(createEmptyProject('빈 곡'));
  const none = await bounce({ timeoutMs: 6000 });
  const msg = await toast();
  record('가장자리 · 트랙 없는 곡 — 알려 주고 멈춘다', none === null ? msg.length > 0 : true, none ? `파일 ${none} (무음)` : `알림: ${msg.slice(0, 60)}`);
  const stuck = await ev(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('내보내는 중'))`);
  record('가장자리 · 실패 뒤 단추가 돌아온다', !stuck, stuck ? '"내보내는 중" 에 멈춤' : '');

  const odd = simpleProject('내 곡: "겨울/밤" <1>? 🎄*|', { bars: 2 });
  await loadProject(odd);
  for (const format of ['wav', 'mp3']) {
    const name = await bounce({ format });
    record(`가장자리 · 파일 이름에 못 쓰는 문자 (${format})`, !!name && !/[/\\?%*:|"<>]/.test(name) && name.includes('🎄'), name ?? `없음 · ${await toast()}`);
  }

  const silent = simpleProject('무음', { bars: 1, notes: 0 });
  await loadProject(silent);
  for (const format of ['wav', 'mp3', 'flac', 'm4a']) {
    const name = await bounce({ format, normalize: true });
    const p = name ? await probeAudio(name) : null;
    record(`가장자리 · 음이 하나도 없는 곡 + 노멀라이즈 (${format})`, !!p?.ok && p.peak < 1e-3 && Number.isFinite(p.seconds), p?.ok ? `${p.seconds.toFixed(2)}초 · 피크 ${p.peak.toExponential(1)}` : (p?.why ?? `없음 · ${await toast()}`));
  }

  const one = simpleProject('한 음', { bars: 1, notes: 1 });
  await loadProject(one);
  const name = await bounce({ format: 'ogg', tail: false });
  const p = name ? await probeAudio(name) : null;
  record('가장자리 · 한 마디짜리 곡, 꼬리 없이 OGG', !!p?.ok && Math.abs(p.seconds - 2) < 0.1 && p.peak > 0.01, p?.ok ? `${p.seconds.toFixed(2)}초 · 피크 ${db(p.peak).toFixed(1)}dB` : (p?.why ?? `없음 · ${await toast()}`));
});

// ───────── 5. 솔로 · 뮤트가 내보낸 파일에 그대로 ─────────
scenario('솔로뮤트', async () => {
  const base = song('first-snow-night');
  const sec = base.sections[3]; // 코러스
  await loadProject(base);
  const full = await bounce({ range: sec.name });
  const fp = full ? await probeAudio(full) : null;

  const muted = song('first-snow-night');
  for (const t of muted.tracks) if (t.name !== '글로켄슈필') t.mute = true;
  await loadProject(muted);
  const only = await bounce({ range: sec.name });
  const op = only ? await probeAudio(only) : null;
  record('솔로뮤트 · 글로켄슈필만 남기고 뮤트하면 파일도 글로켄슈필만', !!fp?.ok && !!op?.ok && op.rms < fp.rms * 0.7 && op.peak > 0.01, fp?.ok && op?.ok ? `전체 RMS ${db(fp.rms).toFixed(1)}dB → 글로켄슈필만 ${db(op.rms).toFixed(1)}dB` : '파일 없음');

  const solo = song('first-snow-night');
  solo.tracks.find((t) => t.name === '글로켄슈필').solo = true;
  await loadProject(solo);
  const s = await bounce({ range: sec.name });
  const sp = s ? await probeAudio(s) : null;
  record('솔로뮤트 · 글로켄슈필 솔로 = 나머지 뮤트', !!sp?.ok && !!op?.ok && Math.abs(db(sp.rms) - db(op.rms)) < 0.2, sp?.ok && op?.ok ? `솔로 ${db(sp.rms).toFixed(2)}dB · 뮤트 ${db(op.rms).toFixed(2)}dB` : '파일 없음');

  const all = song('first-snow-night');
  for (const t of all.tracks) t.mute = true;
  await loadProject(all);
  const z = await bounce({ range: sec.name, format: 'mp3' });
  const zp = z ? await probeAudio(z) : null;
  record('솔로뮤트 · 전부 뮤트하면 무음 파일 (MP3)', !!zp?.ok && zp.peak < 1e-3, zp?.ok ? `피크 ${zp.peak.toExponential(1)}` : (zp?.why ?? `없음 · ${await toast()}`));
});

// ───────── 6. MIDI · 곡 파일 · 악보 — 내보낸 것을 되읽는다 ─────────
scenario('되읽기', async () => {
  for (const id of ['first-snow-night', 'little-bells']) {
    const project = song(id);
    await loadProject(project);
    clearDownloads();
    await fileMenu('MIDI 내보내기');
    const mid = await waitDownload((f) => f.endsWith('.mid'), 15000);
    if (!mid) { record(`되읽기 · MIDI (${project.name})`, false, '파일이 안 내려옴'); continue; }
    const back = decodeMidi(new Uint8Array(readFileSync(join(DL, mid))));
    const count = (p) => p.tracks.reduce((n, t) => n + t.clips.reduce((m, c) => m + c.notes.length, 0), 0);
    const lyrics = (p) => p.tracks.reduce((n, t) => n + t.clips.reduce((m, c) => m + c.notes.filter((x) => x.lyric).length, 0), 0);
    record(`되읽기 · MIDI (${project.name})`,
      count(back) === count(project) && Math.abs(back.tempo.bpm - project.tempo.bpm) < 0.01
        && back.timeSignature.num === project.timeSignature.num && back.timeSignature.den === project.timeSignature.den
        && back.tracks.length === project.tracks.length && lyrics(back) === lyrics(project),
      `음 ${count(project)} → ${count(back)} · 템포 ${back.tempo.bpm} · ${back.timeSignature.num}/${back.timeSignature.den} · 트랙 ${back.tracks.length} · 가사 ${lyrics(project)} → ${lyrics(back)}`);

    // 되읽은 MIDI 를 앱에 다시 가져와 소리가 나는지
    await setFiles('input[accept*=".mid"]', [join(DL, mid)]);
    await sleep(1500);
    const after = await savedProject();
    record(`되읽기 · 그 MIDI 를 다시 가져오기 (${project.name})`, count(after) === count(project), `화면의 곡: 음 ${count(after)} · 트랙 ${after.tracks.length}`);
  }

  const project = song('little-bells');
  await loadProject(project);
  clearDownloads();
  await fileMenu('파일로 저장');
  const file = await waitDownload((f) => f.endsWith('.json') || f.endsWith('.zip'), 15000);
  if (file) {
    const bytes = readFileSync(join(DL, file));
    const text = file.endsWith('.zip') ? new TextDecoder().decode([...readZip(new Uint8Array(bytes)).entries()].find(([k]) => k.endsWith('.json'))[1]) : bytes.toString('utf8');
    const back = deserializeProject(text);
    record('되읽기 · 곡 파일로 저장 → 같은 곡', canon(JSON.parse(serializeProject(back))) === canon(JSON.parse(serializeProject(project))), `${file} ${(bytes.length / 1024).toFixed(0)}KB`);
    await loadProject(createEmptyProject('다른 곡'));
    await setFiles('input[aria-label="곡 파일 열기"]', [join(DL, file)]);
    await sleep(1500);
    const now = await savedProject();
    record('되읽기 · 그 파일을 다시 열기', now.name === project.name && now.tracks.length === project.tracks.length, `${now.name} · 트랙 ${now.tracks.length}`);
  } else record('되읽기 · 곡 파일로 저장 → 같은 곡', false, '파일이 안 내려옴');
});

// ───────── 7. 영상 — MP4 · WebM, 어긋남 ─────────
scenario('영상', async () => {
  const project = song('first-snow-night');
  await loadProject(project);
  const make = (mime) => ev(`(async () => {
    if (!MediaRecorder.isTypeSupported(${JSON.stringify(mime)})) return null;
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d');
    const stream = c.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: ${JSON.stringify(mime)} }); const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    let f = 0; const draw = setInterval(() => { g.fillStyle = 'hsl(' + (f++ * 12) + ',70%,50%)'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(String(f), 140, 100); }, 33);
    rec.start(); await new Promise((r) => setTimeout(r, 3000)); rec.stop(); await new Promise((r) => rec.onstop = r); clearInterval(draw);
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192)); return btoa(s);
  })()`);
  const sources = [
    { label: 'WebM(VP8) 원본', mime: 'video/webm;codecs=vp8', file: '장면-vp8.webm' },
    { label: 'WebM(VP9) 원본', mime: 'video/webm;codecs=vp9', file: '장면-vp9.webm' },
    { label: 'MP4(H.264) 원본', mime: 'video/mp4;codecs=avc1.42E01E', file: '장면-avc.mp4' },
  ];
  const probeVideo = (name, mime) => ev(`(async () => {
    try {
      const bytes = await (await fetch('http://127.0.0.1:${FILE_PORT}/' + encodeURIComponent(${JSON.stringify(name)}))).arrayBuffer();
      const head = [...new Uint8Array(bytes.slice(0, 12))];
      const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(new Blob([bytes], { type: ${JSON.stringify(mime)} }));
      await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('영상을 열 수 없음: ' + (v.error?.message ?? ''))); });
      await v.play(); await new Promise((r) => setTimeout(r, 500));
      const s = v.captureStream(); const tracks = { video: s.getVideoTracks().length, audio: s.getAudioTracks().length };
      const t = v.currentTime; v.pause();
      const ctx = new OfflineAudioContext(2, 1, 48000);
      const buf = await ctx.decodeAudioData(bytes.slice(0));
      let peak = 0; const a = buf.getChannelData(0); const env = []; const win = 2400;
      for (let i = 0; i < a.length; i += win) { let e = 0; const to = Math.min(a.length, i + win); for (let j = i; j < to; j++) { peak = Math.max(peak, Math.abs(a[j])); e += a[j] * a[j]; } env.push(Math.sqrt(e / (to - i))); }
      return { ok: true, head, size: bytes.byteLength, w: v.videoWidth, h: v.videoHeight, duration: v.duration, played: t, ...tracks, audioSec: buf.duration, peak, env };
    } catch (e) { return { ok: false, why: String(e) }; }
  })()`);

  // 기준 — 곡 앞 3초의 윤곽 (영상 소리와 견준다)
  const ref = await bounce({ range: project.sections[0].name });
  const refProbe = ref ? await probeAudio(ref) : null;

  for (const src of sources) {
    const b64 = await make(src.mime);
    if (!b64) { record(`영상 · ${src.label}`, true, '이 Chrome 은 그 형식을 못 만들어 건너뜀'); continue; }
    const path = join(OUT, src.file);
    writeFileSync(path, Buffer.from(b64, 'base64'));
    await loadProject(project);
    await setFiles('input[aria-label="영상 파일"]', [path]);
    for (let i = 0; i < 30 && !(await ev(`!!document.querySelector('[data-video-panel] video')`)); i++) await sleep(300);
    await sleep(600);
    for (const container of ['mp4', 'webm']) {
      await setSelect(`document.querySelector('[data-video-container]')`, `(x) => x.value === ${JSON.stringify(container)}`);
      clearDownloads();
      const t0 = Date.now();
      await clickEl(`document.querySelector('[data-video-export]')`);
      const name = await waitDownload((f) => f.endsWith('.mp4') || f.endsWith('.webm'), 90000);
      const took = (Date.now() - t0) / 1000;
      const note = await toast();
      if (!name) { record(`영상 · ${src.label} → ${container.toUpperCase()}`, false, `파일이 안 내려옴 · ${note.slice(0, 80)}`); continue; }
      const p = await probeVideo(name, container === 'mp4' ? 'video/mp4' : 'video/webm');
      const match = p.ok && refProbe?.ok ? envelopeMatch(refProbe.env.slice(0, p.env.length), p.env) : -1;
      // MP4 안의 그림은 H.264/H.265 여야 한다 (VP9 을 넣으면 다른 플레이어가 못 연다)
      const raw = readFileSync(join(DL, name)).toString('latin1');
      const h264 = container !== 'mp4' || raw.includes('avc1') || raw.includes('hvc1');
      record(`영상 · ${src.label} → ${container.toUpperCase()}`,
        p.ok && name.endsWith('.' + container) && MAGIC[container](p.head) && p.video === 1 && p.audio === 1 && p.w === 320 && p.h === 180
          && Math.abs(p.duration - 3) < 0.5 && p.played > 0.2 && p.peak > 0.02 && match > 0.9 && h264,
        p.ok ? `${(p.size / 1024).toFixed(0)}KB · ${p.w}×${p.h} · ${p.duration.toFixed(2)}초 · 소리 피크 ${db(p.peak).toFixed(1)}dB · 곡과 윤곽 ${match.toFixed(3)} · ${took.toFixed(1)}초 걸림 · ${note.match(/\(([^)]*)\)\s*$/)?.[1] ?? note.slice(0, 40)}` : p.why);
    }
  }

  // 어긋남 — 영상이 곡 2초에서 시작 / 곡보다 1초 먼저 시작
  const b64 = await make('video/webm;codecs=vp8');
  const path = join(OUT, '장면-어긋남.webm');
  writeFileSync(path, Buffer.from(b64, 'base64'));
  const full = await (async () => { await loadProject(project); const n = await bounce({ tail: false, format: 'wav' }); return n ? await probeAudio(n) : null; })();
  for (const offset of [2, -1]) {
    await loadProject(project);
    await setFiles('input[aria-label="영상 파일"]', [path]);
    for (let i = 0; i < 30 && !(await ev(`!!document.querySelector('[data-video-panel] video')`)); i++) await sleep(300);
    await sleep(500);
    await ev(`(() => { const e = document.querySelector('input[aria-label="영상 시작 어긋남"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '${offset}'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);
    clearDownloads();
    await clickEl(`document.querySelector('[data-video-export]')`);
    const name = await waitDownload((f) => f.endsWith('.mp4'), 90000);
    const p = name ? await probeVideo(name, 'video/mp4') : null;
    if (!p?.ok || !full?.ok) { record(`영상 · 어긋남 ${offset}초`, false, p?.why ?? `파일 없음 · ${await toast()}`); continue; }
    // 곡의 기대 윤곽 — 영상 시각 t 는 곡의 t+offset 초
    const shift = Math.round(offset / 0.05);
    const want = p.env.map((_, i) => (i + shift >= 0 ? full.env[i + shift] ?? 0 : 0));
    const match = envelopeMatch(want, p.env);
    const lead = offset < 0 ? Math.max(...p.env.slice(0, Math.round(-offset / 0.05) - 2)) : 0;
    record(`영상 · 어긋남 ${offset}초`, match > 0.9 && lead < 1e-3, `기대 윤곽과 ${match.toFixed(3)}${offset < 0 ? ` · 앞 ${-offset}초 무음 ${lead.toExponential(1)}` : ''}`);
  }
  await shot('s7-video');
});

// ───────── 8. 템플릿마다 — 열고, 한 음 넣고, 내보낸다 ─────────
scenario('템플릿', async () => {
  for (const template of TEMPLATES) {
    const project = projectFromTemplate(template, `시험 ${template.name}`);
    let placed = 0;
    for (const track of project.tracks) {
      if (track.kind === 'audio') continue;
      if (track.clips.length === 0) track.clips.push(createClip({ startTick: 0, lengthTick: 4 * PPQ }));
      track.clips[0].notes.push(createNote({ startTick: 0, lengthTick: PPQ, midi: 60, velocity: 0.8 }));
      placed++;
    }
    project.lengthBars = 2;
    await loadProject(project);
    const before = problems.length;
    const name = await bounce({ format: 'mp3', kbps: 192, timeoutMs: 180000 });
    const p = name ? await probeAudio(name) : null;
    record(`템플릿 · ${template.name} (트랙 ${project.tracks.length})`, placed === 0 ? true : (!!p?.ok && p.peak > 0.005 && problems.length === before),
      p?.ok ? `피크 ${db(p.peak).toFixed(1)}dB · ${p.seconds.toFixed(1)}초` : (placed === 0 ? '악기 트랙 없음' : `${p?.why ?? '파일 없음'} · ${await toast()}`));
  }
});

// ───────── 9. 되풀이 — 형식을 바꿔 가며 여러 번 (엔진이 새지 않는지) ─────────
scenario('되풀이', async () => {
  const project = song('first-snow-night'); // 10트랙
  await loadProject(project);
  const sec = project.sections[0];
  const formats = ['wav', 'mp3', 'flac', 'm4a', 'ogg'];
  let ok = 0; let firstPeak = null; let lastWhy = '';
  const N = 20;
  for (let i = 0; i < N; i++) {
    const name = await bounce({ format: formats[i % formats.length], range: sec.name });
    const p = name ? await probeAudio(name) : null;
    if (p?.ok && p.peak > 0.05) { ok++; firstPeak ??= p.peak; } else lastWhy = p?.why ?? `파일 없음 · ${await toast()}`;
  }
  record(`되풀이 · 10트랙 곡을 ${N}번 내보내기 (엔진 ${N * 10}개)`, ok === N, `${ok}/${N} 성공${lastWhy ? ' · ' + lastWhy.slice(0, 80) : ''}`);
  // 그 뒤에도 재생이 된다
  await clickEl(byTitle('커서부터 재생'));
  await sleep(1500);
  const playing = await ev(`document.querySelector('[data-toast]')?.innerText ?? ''`);
  await clickEl(byTitle('정지')).catch(() => {});
  record('되풀이 · 그 뒤에도 재생 오류 없음', !/오류|memory|못/.test(playing), playing.slice(0, 80));
});


/** 풀어 둔 파일에서 소리가 시작하는 시각들 (5ms 창, 300ms 안의 것은 한 번으로) */
const onsets = (name, threshold = 0.02) => ev(`(() => {
  const A = window.__decoded?.[${JSON.stringify(name)}]; if (!A) return null;
  const a = A[0]; const win = 240; const out = []; let quietFor = 1e9;
  for (let i = 0; i + win <= a.length; i += win) {
    let p = 0; for (let j = i; j < i + win; j++) p = Math.max(p, Math.abs(a[j]));
    if (p > ${threshold}) { if (quietFor >= 60) out.push(i / 48000); quietFor = 0; } else quietFor++;
  }
  return out;
})()`);
/** 마디 첫 박마다 킥 하나 */
function clickProject(name, bars, mutate) {
  const p = createEmptyProject(name);
  p.lengthBars = bars;
  mutate(p);
  const track = createTrack({ name: '킥', instrumentId: 'kick' });
  const clip = createClip({ startTick: 0, lengthTick: barStartTick(p, bars) });
  for (let b = 0; b < bars; b++) clip.notes.push(createNote({ startTick: barStartTick(p, b), lengthTick: PPQ / 4, midi: 36, velocity: 0.9 }));
  track.clips.push(clip);
  p.tracks.push(track);
  return p;
}
async function checkClicks(label, project) {
  await loadProject(project);
  const name = await bounce({ tail: false });
  const p = name ? await probeAudio(name) : null;
  if (!p?.ok) { record(label, false, p?.why ?? `파일 없음 · ${await toast()}`); return; }
  const want = Array.from({ length: project.lengthBars }, (_, b) => ticksToSeconds(barStartTick(project, b), project.tempo));
  const total = ticksToSeconds(barStartTick(project, project.lengthBars), project.tempo);
  const got = await onsets(name);
  const worst = got.length === want.length ? Math.max(...want.map((w, i) => Math.abs(got[i] - w))) : Infinity;
  record(label, Math.abs(p.seconds - total) < 0.02 && worst < 0.03,
    `길이 ${p.seconds.toFixed(3)}초(기대 ${total.toFixed(3)}) · 마디 첫 박 ${got.length}/${want.length}개 · 가장 큰 어긋남 ${(worst * 1000).toFixed(0)}ms · 기대 [${want.map((x) => x.toFixed(2)).join(' ')}]`);
}

// ───────── 10. 템포·박자가 바뀌는 곡 — 길이와 박 자리가 맞는가 ─────────
scenario('템포박자', async () => {
  await checkClicks('템포박자 · 템포 고정 97bpm', clickProject('고정', 4, (p) => { p.tempo = { ...p.tempo, bpm: 97 }; }));
  await checkClicks('템포박자 · 중간에 120 → 60 으로 뚝', clickProject('뚝', 6, (p) => { p.tempo = { ...p.tempo, bpm: 120, changes: [{ tick: 2 * 4 * PPQ, bpm: 60 }] }; }));
  await checkClicks('템포박자 · 서서히 120 → 180 (램프)', clickProject('램프', 8, (p) => { p.tempo = { ...p.tempo, bpm: 120, changes: [{ tick: 2 * 4 * PPQ, bpm: 120 }, { tick: 6 * 4 * PPQ, bpm: 180, ramp: true }] }; }));
  await checkClicks('템포박자 · 4/4 → 3/4 → 6/8', clickProject('박자', 7, (p) => { p.signatureChanges = [{ bar: 2, timeSignature: { num: 3, den: 4 } }, { bar: 4, timeSignature: { num: 6, den: 8 } }]; }));
  await checkClicks('템포박자 · 7/8 에 템포 변화까지', clickProject('둘 다', 6, (p) => { p.timeSignature = { num: 7, den: 8 }; p.tempo = { ...p.tempo, bpm: 140, changes: [{ tick: Math.round(3 * 3.5 * PPQ), bpm: 90 }] }; }));
  await checkClicks('템포박자 · 아주 느림 30bpm', clickProject('느림', 3, (p) => { p.tempo = { ...p.tempo, bpm: 30 }; }));
  await checkClicks('템포박자 · 아주 빠름 280bpm', clickProject('빠름', 12, (p) => { p.tempo = { ...p.tempo, bpm: 280 }; }));
});

// ───────── 11. 오디오 트랙 — 가져온 소리가 그대로 나가는가 ─────────
scenario('오디오트랙', async () => {
  const project = simpleProject('오디오와 함께', { bars: 2, notes: 0 });
  await loadProject(project);
  const tone = Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const src = join(OUT, '사인 440.wav');
  writeFileSync(src, encodeWav([tone, tone], { sampleRate: 48000, bitDepth: 24 }));
  await setFiles('input[aria-label="오디오 파일"]', [src]);
  let placed = null;
  for (let i = 0; i < 30 && !placed; i++) { await sleep(300); const now = await savedProject(); placed = now.tracks.find((t) => t.kind === 'audio' && t.clips.length > 0) ?? null; }
  record('오디오트랙 · WAV 가져오기 → 오디오 트랙', !!placed, placed ? `${placed.name} · ${placed.clips[0].audio?.assetSec?.toFixed(2)}초 · 게인 ${placed.gain}` : `안 생김 · ${await toast()}`);
  if (!placed) return;
  const gain = placed.gain;
  for (const format of ['wav', 'flac', 'm4a']) {
    const name = await bounce({ format, tail: false });
    const p = name ? await probeAudio(name) : null;
    // 사인 1초 뒤는 무음 — 윤곽이 앞 1초만 차 있어야 한다
    const on = p?.ok ? p.env.slice(1, 19) : []; const off = p?.ok ? p.env.slice(22, 38) : [];
    const level = on.length ? on.reduce((a, b) => a + b, 0) / on.length : 0;
    record(`오디오트랙 · 내보낸 파일에 그 소리 (${format})`, !!p?.ok && level > 0.05 && Math.max(...off, 0) < 0.002 && Math.abs(p.seconds - 4) < 0.1,
      p?.ok ? `앞 1초 RMS ${db(level).toFixed(1)}dB(트랙 게인 ${gain}) · 그 뒤 ${Math.max(...off, 0).toExponential(1)} · ${p.seconds.toFixed(2)}초` : (p?.why ?? `없음 · ${await toast()}`));
  }
  const zip = await bounce({ stems: true, tail: false });
  const entries = zip ? readZip(new Uint8Array(readFileSync(join(DL, zip)))) : new Map();
  const audioStem = [...entries.entries()].find(([k]) => k.includes(placed.name));
  const peak = audioStem ? decodeWav(audioStem[1]).channels[0].reduce((m, v) => Math.max(m, Math.abs(v)), 0) : 0;
  record('오디오트랙 · 스템에 오디오 트랙도 따로', entries.size === 2 && peak > 0.05, `${[...entries.keys()].join(', ')} · 오디오 스템 피크 ${db(peak).toFixed(1)}dB`);
});

// ───────── 12. 긴 곡 — 3분, 12트랙, 음 1만 개 ─────────
scenario('긴곡', async () => {
  const p = createEmptyProject('긴 곡');
  p.tempo = { ...p.tempo, bpm: 160 };
  p.lengthBars = 120;
  const kit = ['acoustic-piano', 'synth-bass', 'synth-pad', 'synth-pluck', 'glockenspiel', 'harp', 'celesta', 'kick', 'clap', 'hihat', 'tambourine', 'synth-lead'];
  let total = 0;
  for (const [i, instrumentId] of kit.entries()) {
    const track = createTrack({ name: `${i + 1} ${instrumentId}`, instrumentId });
    track.gain = 0.12;
    const clip = createClip({ startTick: 0, lengthTick: 120 * 4 * PPQ });
    for (let n = 0; n < 120 * 8; n++) { clip.notes.push(createNote({ startTick: n * (PPQ / 2), lengthTick: PPQ / 2, midi: 48 + ((n * (i + 3)) % 24), velocity: 0.6 })); total++; }
    track.clips.push(clip);
    p.tracks.push(track);
  }
  await loadProject(p);
  const want = (120 * 4 * 60) / 160 + 2;
  for (const format of ['mp3', 'flac']) {
    const t0 = Date.now();
    const name = await bounce({ format, ...(format === 'mp3' ? { kbps: 192 } : {}), timeoutMs: 420000 });
    const took = (Date.now() - t0) / 1000;
    const probe = name ? await probeAudio(name) : null;
    record(`긴곡 · ${Math.round(want)}초 · 12트랙 · 음 ${total}개 (${format})`, !!probe?.ok && Math.abs(probe.seconds - want) < 0.2 && probe.peak > 0.05 && probe.peak <= 1,
      probe?.ok ? `${(probe.size / 1024 / 1024).toFixed(1)}MB · ${probe.seconds.toFixed(1)}초 · 피크 ${db(probe.peak).toFixed(1)}dB · ${took.toFixed(0)}초 걸림 (실시간의 ${(want / took).toFixed(1)}배)` : (probe?.why ?? `없음 · ${await toast()}`));
    await ev(`(() => { window.__decoded = {}; })()`);
  }
});

// ───────── 13. 재생 중에 — 내보내기, 곡 바꾸기 ─────────
scenario('재생중', async () => {
  const project = song('first-snow-night');
  await loadProject(project);
  const before = problems.length;
  await clickEl(byTitle('커서부터 재생'));
  await sleep(1500);
  const name = await bounce({ format: 'mp3', range: project.sections[0].name });
  const p = name ? await probeAudio(name) : null;
  record('재생중 · 재생하면서 내보내기', !!p?.ok && p.peak > 0.05 && problems.length === before, p?.ok ? `피크 ${db(p.peak).toFixed(1)}dB` : (p?.why ?? `없음 · ${await toast()}`));
  if (await ev(`!!${DIALOG}`)) await clickEl(byExact('닫기', DIALOG));
  // 재생 중에 다른 예제 곡으로
  if (!(await ev(`!!${byTitle('정지')}`))) await clickEl(byTitle('커서부터 재생'));
  await sleep(800);
  await fileMenu('새 곡 · 최근 곡 · 버전');
  await sleep(300);
  await clickEl(`document.querySelector('[data-demo-song="little-bells"]')`);
  await sleep(1500);
  const now = await savedProject();
  if (await ev(`!!${byTitle('정지')}`)) await clickEl(byTitle('정지'));
  await sleep(300);
  await clickEl(byTitle('커서부터 재생'));
  await sleep(1500);
  const playing = await ev(`!!${byTitle('정지')}`);
  const err = await toast();
  await clickEl(byTitle('정지')).catch(() => {});
  record('재생중 · 재생하다 다른 곡으로 바꾸고 다시 재생', now.name === '작은 종소리' && playing && problems.length === before && !/못|오류|rror/.test(err), `${now.name} · 재생 ${playing} · ${err.slice(0, 60)}`);
  const carol = await bounce({ format: 'm4a', range: '인트로' });
  const cp = carol ? await probeAudio(carol) : null;
  record('재생중 · 바꾼 곡을 바로 내보내기', !!cp?.ok && cp.peak > 0.02 && carol.startsWith('작은 종소리'), cp?.ok ? `${carol} · 피크 ${db(cp.peak).toFixed(1)}dB` : (cp?.why ?? `없음 · ${await toast()}`));
});


// ───────── 14. 저장소가 차도 — 곡을 계속 열어도 지금 곡은 저장된다 ─────────
scenario('저장소', async () => {
  await loadProject(song('first-snow-night'));
  const before = problems.length;
  let saved = 0; let used = 0; let kept = 0; const N = 16;
  for (let i = 0; i < N; i++) {
    const id = i % 2 === 0 ? 'little-bells' : 'first-snow-night';
    await fileMenu('새 곡 · 최근 곡 · 버전');
    await sleep(250);
    await clickEl(`document.querySelector('[data-demo-song="${id}"]')`);
    await sleep(900);
    const state = await ev(`(() => { const t = localStorage.getItem('project-autosave-v1'); const p = t ? JSON.parse(t) : null; const d = p?.project ?? p; let n = 0; for (const k of Object.keys(localStorage)) n += k.length + localStorage.getItem(k).length; return { name: d?.name ?? '', used: n, kept: JSON.parse(localStorage.getItem('library-v1') ?? '[]').length }; })()`);
    if (state.name === (id === 'little-bells' ? '작은 종소리' : '첫눈 오는 밤')) saved++;
    used = state.used; kept = state.kept;
  }
  const note = await toast();
  record(`저장소 · 예제 곡을 ${N}번 열어도 지금 곡이 자동 저장된다`, saved === N && problems.length === before && !/저장.*(못|실패|안 )/.test(note),
    `${saved}/${N} · 저장소 ${(used / 1024 / 1024).toFixed(2)}M자 사용 · 보관함에 ${kept}곡 남음 · ${note.slice(0, 50)}`);
});

let failed = false;
try {
  await connect();
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('DOM.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await send('Page.navigate', { url: URL_APP });
  await sleep(2500);
  for (const s of scenarios) {
    if (ONLY.length > 0 && !ONLY.includes(s.name)) continue;
    console.log(`\n── ${s.name} ──`);
    try { await s.run(); } catch (err) { record(`${s.name} · 스크립트 실행`, false, String(err).slice(0, 300)); await shot(`fail-${s.name}`).catch(() => {}); }
  }
} catch (err) {
  record('스크립트 실행', false, String(err));
} finally {
  const bad = results.filter((r) => !r.ok);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ results, problems }, null, 2));
  console.log(`\n${results.length - bad.length}/${results.length} 통과 · 실패 ${bad.length}`);
  console.log(`결과: ${OUT}`);
  console.log(`콘솔 오류·예외 ${problems.length}건`);
  for (const p of [...new Set(problems)].slice(0, 12)) console.log('  ' + p);
  failed = bad.length > 0 || problems.length > 0;
  try { ws?.close(); } catch { /* 이미 닫힘 */ }
  chrome.kill();
  fileServer.close();
  process.exit(failed ? 1 : 0);
}

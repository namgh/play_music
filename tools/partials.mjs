/**
 * 배음 분석 — **파라미터를 어느 쪽으로 움직일지 숫자로 알려 준다.**
 *
 * ## 왜 기존 지표로는 부족한가
 *
 * `quality-compare.mjs` 는 "깨끗한가"를 잰다 — 트루피크·THD+N·옥타브 밴드·중심주파수.
 * 상용 제품과 같은 단위라 비교에는 좋지만, **튜닝에는 못 쓴다.** "중심주파수가
 * 200Hz 높다"를 들어도 `stiffness` 를 올릴지 `damping` 을 내릴지 알 수 없다.
 *
 * 줄 악기의 사실감은 사실상 세 가지가 정한다:
 *
 *  1. **배음별 세기** — 몇 번째 배음이 얼마나 센가 (뜯는 위치·픽 강도)
 *  2. **배음별 감쇠** — 어느 배음이 먼저 죽는가. 실제 줄은 **고음이 먼저 죽는다**.
 *     이게 안 맞으면 "전자 오르간 같다"는 인상이 된다 (`sound.md` 6-3)
 *  3. **인하모니시티 B** — 배음이 정수배에서 얼마나 벗어나는가. 줄의 강성이다.
 *     피아노 저음이 "피아노처럼" 들리는 이유가 이것이고, 우리 `stiffness` 와 직결된다
 *
 * 셋 다 **순수 신호처리로 계산된다. 학습 모델이 필요 없다.**
 *
 * ## 무엇과 비교해야 하나
 *
 * **완성곡과는 비교가 성립하지 않는다.** 시중 음원은 여러 악기가 섞이고 믹스·마스터링을
 * 거친 신호라, 거기서 기타 한 대의 배음을 떼어낼 수 없다. 비교 대상은 **같은 음을 친
 * 단일 악기 녹음**이어야 한다 (`AB_TEST.md` 2절의 조건).
 *
 * ## 쓰는 법
 *
 *   node --experimental-strip-types tools/partials.mjs acoustic-guitar 57
 *   node --experimental-strip-types tools/partials.mjs acoustic-guitar 57 --ref 참조.wav
 *   node --experimental-strip-types tools/partials.mjs acoustic-guitar 57 --params stiffness=0.05
 */

import { readFileSync } from 'node:fs';

import { readAudioBytes } from './audio-input.mjs';
import { fileURLToPath } from 'node:url';

const R = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const { createClip, createEmptyProject, createNote, createTrack } = await import(R('../src/model/factory.ts'));
const { PPQ } = await import(R('../src/model/time.ts'));
const { loadAllInstruments } = await import(R('../src/instruments/definitions.ts'));
const { WasmVoiceEngine } = await import(R('../src/audio/voice/wasmEngine.ts'));
const { seededRng } = await import(R('../src/audio/analysis.ts'));
const { renderProjectOffline } = await import(R('../src/audio/offlineRender.ts'));
const { pitchToHz } = await import(R('../src/model/pitch.ts'));

const FS = 48000;
const PARTIALS = 12;
/** 감쇠를 재는 창. 짧으면 분해능이 없고, 길면 감쇠 자체에 뭉개진다 */
const WIN_SEC = 0.25;

// ---------------------------------------------------------------------------

/** 한 주파수의 크기만 본다. FFT 전체를 뜰 이유가 없다 */
function goertzel(x, from, len, hz, fs) {
  const w = (2 * Math.PI * hz) / fs;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i += 1) {
    // 해닝 창 — 안 씌우면 옆 배음이 새어 들어온다
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    const s = x[from + i] * win + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / len;
}

/**
 * `around` 근처에서 실제 배음 봉우리를 찾는다.
 *
 * **정수배 자리를 그냥 재면 안 된다** — 인하모니시티 때문에 위 배음일수록 위로
 * 밀려 있고, 그 밀림이 바로 우리가 재려는 값이다.
 */
function findPeak(x, from, len, around, fs, spanCents = 120) {
  const lo = around * Math.pow(2, -spanCents / 1200);
  const hi = around * Math.pow(2, spanCents / 1200);
  let best = { hz: around, mag: 0 };
  const steps = 64;
  for (let i = 0; i <= steps; i += 1) {
    const hz = lo * Math.pow(hi / lo, i / steps);
    const mag = goertzel(x, from, len, hz, fs);
    if (mag > best.mag) best = { hz, mag };
  }
  // 봉우리 주변을 한 번 더 좁혀 본다
  const fine = best.hz;
  const span = (hi - lo) / steps;
  for (let i = -8; i <= 8; i += 1) {
    const hz = fine + (span * i) / 8;
    if (hz <= 0) continue;
    const mag = goertzel(x, from, len, hz, fs);
    if (mag > best.mag) best = { hz, mag };
  }
  return best;
}

/** 소리가 실제로 시작하는 지점 — 앞의 무음을 재면 감쇠가 거짓이 된다 */
function onset(x, fs) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const gate = peak * 0.02;
  for (let i = 0; i < x.length; i += 1) if (Math.abs(x[i]) > gate) return i;
  return 0;
}

/**
 * 배음마다 세기와 감쇠(T60)를 잰다.
 *
 * 감쇠는 창을 옮겨 가며 크기를 재고 **로그 크기의 기울기**로 구한다. 지수 감쇠는
 * dB 로 보면 직선이므로, 기울기(dB/초)에서 60dB 떨어지는 시간이 T60 이다.
 */
function analyze(x, f0, fs) {
  const start = onset(x, fs);
  const win = Math.round(WIN_SEC * fs);
  const usable = x.length - start;
  const windows = Math.max(2, Math.min(12, Math.floor(usable / win)));

  const rows = [];
  for (let n = 1; n <= PARTIALS; n += 1) {
    const nominal = f0 * n;
    if (nominal > fs * 0.45) break;
    // 첫 창에서 실제 봉우리 위치를 잡는다
    const peak = findPeak(x, start, Math.min(win, usable), nominal, fs);
    const mags = [];
    for (let w = 0; w < windows; w += 1) {
      const from = start + w * win;
      if (from + win > x.length) break;
      mags.push(goertzel(x, from, win, peak.hz, fs));
    }
    // 최소제곱으로 dB 기울기
    const pts = mags
      .map((m, i) => ({ t: i * WIN_SEC, db: 20 * Math.log10(m || 1e-12) }))
      .filter((p) => Number.isFinite(p.db) && p.db > -120);
    let slope = 0;
    if (pts.length >= 2) {
      const mt = pts.reduce((s, p) => s + p.t, 0) / pts.length;
      const md = pts.reduce((s, p) => s + p.db, 0) / pts.length;
      const num = pts.reduce((s, p) => s + (p.t - mt) * (p.db - md), 0);
      const den = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0);
      slope = den > 0 ? num / den : 0;
    }
    rows.push({
      n,
      hz: peak.hz,
      // 정수배에서 얼마나 벗어났나 (센트). 인하모니시티가 여기 보인다
      cents: 1200 * Math.log2(peak.hz / nominal),
      db: 20 * Math.log10(peak.mag || 1e-12),
      t60: slope < -0.1 ? 60 / -slope : Infinity,
    });
  }

  // 인하모니시티 계수 B — (f_n / (n·f0))² − 1 = B·n² 를 최소제곱으로 푼다
  let sx = 0;
  let sy = 0;
  for (const r of rows) {
    if (r.n < 2) continue;
    const y = (r.hz / (f0 * r.n)) ** 2 - 1;
    const xx = r.n ** 2;
    sx += xx * xx;
    sy += xx * y;
  }
  const B = sx > 0 ? sy / sx : 0;

  const ref = rows[0]?.db ?? 0;
  return { rows: rows.map((r) => ({ ...r, rel: r.db - ref })), B, windows };
}

// ---------------------------------------------------------------------------

function readWav(buffer) {
  let pos = 12;
  let fmt = null;
  let off = 0;
  let len = 0;
  while (pos < buffer.length - 8) {
    const id = buffer.toString('ascii', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        ch: buffer.readUInt16LE(pos + 10),
        rate: buffer.readUInt32LE(pos + 12),
        bits: buffer.readUInt16LE(pos + 22),
      };
    }
    if (id === 'data') { off = pos + 8; len = size; break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt) throw new Error('WAV 형식을 못 읽었다');
  const bytes = fmt.bits / 8;
  const full = 2 ** (fmt.bits - 1);
  const frames = Math.floor(len / (bytes * fmt.ch));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < fmt.ch; c += 1) {
      sum += buffer.readIntLE(off + (i * fmt.ch + c) * bytes, bytes) / full;
    }
    mono[i] = sum / fmt.ch;
  }
  return { x: mono, rate: fmt.rate };
}

const registry = await loadAllInstruments();
const wasmBytes = readFileSync(R('../src/generated/dsp.wasm'));

async function renderOurs(instrumentId, midi, overrides) {
  const project = createEmptyProject('배음');
  project.tempo.bpm = 60;
  project.lengthBars = 2;
  const track = createTrack({ name: instrumentId, instrumentId });
  if (overrides) track.toneParams = overrides;
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ });
  const note = createNote({ startTick: 0, lengthTick: 4 * PPQ, midi });
  note.id = `not_partials-${midi}`;
  clip.notes.push(note);
  track.clips.push(clip);
  project.tracks.push(track);
  const wasm = await WasmVoiceEngine.create(wasmBytes, FS);
  const { pcm } = renderProjectOffline(project, registry, {
    sampleRate: FS, rng: seededRng(), tailSec: 2, wasm: [wasm],
  });
  return { x: pcm, f0: pitchToHz(note.pitch, project.tuning) };
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const instrumentId = args[0] ?? 'acoustic-guitar';
const midi = Number(args[1] ?? 57);
const refAt = args.indexOf('--ref');
const paramAt = args.indexOf('--params');
const overrides = paramAt >= 0
  ? Object.fromEntries(args[paramAt + 1].split(',').map((kv) => {
    const [k, v] = kv.split('=');
    return [k, Number(v)];
  }))
  : null;

const ours = await renderOurs(instrumentId, midi, overrides);
const a = analyze(ours.x, ours.f0, FS);

let b = null;
let refLabel = null;
if (refAt >= 0) {
  const path = args[refAt + 1];
  const wav = readWav(readAudioBytes(path));
  if (wav.rate !== FS) console.log(`  ※ 참조가 ${wav.rate}Hz 다 — 같은 표본율로 뽑는 편이 정확하다`);
  b = analyze(wav.x, ours.f0, wav.rate);
  refLabel = path;
}

console.log('');
console.log(`${instrumentId} · MIDI ${midi} · ${ours.f0.toFixed(2)}Hz · 창 ${WIN_SEC}s × ${a.windows}`);
if (overrides) console.log(`파라미터 덮어쓰기: ${JSON.stringify(overrides)}`);
if (refLabel) console.log(`참조: ${refLabel}`);
console.log('='.repeat(refLabel ? 78 : 56));

const head = refLabel
  ? '배음      주파수      정수배대비   세기(상대)   T60      참조세기   참조T60'
  : '배음      주파수      정수배대비   세기(상대)   T60';
console.log(head);
const t60 = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}s` : '  ∞');
for (const r of a.rows) {
  const m = b?.rows.find((x) => x.n === r.n);
  const base = `${String(r.n).padStart(3)}   ${r.hz.toFixed(1).padStart(9)}Hz`
    + `${r.cents.toFixed(1).padStart(9)}c`
    + `${r.rel.toFixed(1).padStart(11)}dB`
    + `${t60(r.t60).padStart(9)}`;
  console.log(base + (m ? `${m.rel.toFixed(1).padStart(11)}dB${t60(m.t60).padStart(9)}` : ''));
}
console.log('');
console.log(`인하모니시티 B = ${a.B.toExponential(2)}`
  + (b ? `   참조 B = ${b.B.toExponential(2)}` : ''));

if (b) {
  // **어느 쪽으로 움직여야 하는지까지 적는다.** 숫자만 보여 주면 결국 감으로 돌아간다
  const brightUs = a.rows.filter((r) => r.n >= 4).reduce((s, r) => s + r.rel, 0) / Math.max(1, a.rows.filter((r) => r.n >= 4).length);
  const brightRef = b.rows.filter((r) => r.n >= 4).reduce((s, r) => s + r.rel, 0) / Math.max(1, b.rows.filter((r) => r.n >= 4).length);
  const diff = brightUs - brightRef;
  console.log('');
  console.log('읽는 법');
  console.log(`  · 4배음 이상 평균이 참조보다 ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}dB`
    + ` → ${Math.abs(diff) < 1.5 ? '비슷하다' : diff > 0 ? '우리가 밝다. damping 을 올리거나 pluckHardness 를 낮춘다' : '우리가 어둡다. damping 을 낮추거나 pluckHardness 를 올린다'}`);
  const bRatio = b.B > 0 ? a.B / b.B : 0;
  console.log(`  · 인하모니시티가 참조의 ${bRatio ? `${bRatio.toFixed(2)}배` : '— (참조가 0)'}`
    + ` → ${bRatio && Math.abs(bRatio - 1) < 0.3 ? '비슷하다' : bRatio > 1 ? '우리가 더 뻣뻣하다. stiffness 를 낮춘다' : 'stiffness 를 올린다'}`);
}

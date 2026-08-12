/**
 * 음질 리포트 — **다른 앱과 나란히 놓을 수 있는 숫자**를 뽑는다.
 *
 *     npm run quality
 *     npm run quality -- --out out/          # WAV 도 함께 저장 (귀로 들으려면)
 *     npm run quality -- --instrument grand-piano
 *
 * ## 왜 이게 "비교"인가
 *
 * 여기 나오는 값은 전부 **절대 측정값**이다 — THD+N(dB), 노이즈 플로어(dBFS),
 * 트루 피크(dBTP), 라우드니스(LUFS), 어택(ms), 스펙트럼 무게중심(Hz).
 * 다른 앱에서 같은 음을 내보내 `quality-compare.mjs` 에 넣으면 같은 함수가 같은
 * 단위로 잰다. "우리가 더 낫다"를 인상이 아니라 숫자로 말할 수 있는 범위가 여기까지다.
 *
 * ## 여기서 답하지 않는 것
 *
 * **"진짜 악기 같은가"는 못 잰다.** 스펙트럼이 비슷해도 사실감은 다른 질문이고,
 * 그건 블라인드 청취로만 판정된다 (`sound.md` 11-3). 이 도구는 그 청취를
 * 대체하지 않고 **준비한다** — `--out` 으로 라우드니스를 맞춘 WAV 를 뽑아 준다.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';

import { WasmVoiceEngine } from '../src/audio/voice/wasmEngine.ts';
import { encodeWav } from '../src/audio/wav.ts';
import { createRegistry, playableInstrumentIds } from '../src/instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../src/instruments/resolve.ts';
import { VOICE_KIND_INDEX } from '../src/instruments/types.ts';

import {
  attackMs,
  dbfs,
  integratedLufs,
  matchLoudness,
  noiseFloorDbfs,
  octaveBands,
  preciseCentsError,
  rms,
  spectralCentroidHz,
  stereoCorrelation,
  thdPlusN,
  truePeakDbfs,
} from '../src/audio/quality.ts';

const FS = 48000;
const BLOCK = 128;
const registry = createRegistry();

const args = new Map();
for (let i = 2; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1] ?? true);
}
const outDir = typeof args.get('out') === 'string' ? args.get('out') : null;
const onlyInstrument = typeof args.get('instrument') === 'string' ? args.get('instrument') : null;
/** 블라인드 청취용 목표 라우드니스. 방송 표준(-23)보다 조금 크게 잡아 조용하지 않게 */
const TARGET_LUFS = Number(args.get('lufs') ?? -18);

const wasmPath = fileURLToPath(new URL('../src/generated/dsp.wasm', import.meta.url));
const wasm = await WasmVoiceEngine.create(await readFile(wasmPath), FS);

const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * 음 하나를 스테레오로 렌더한다.
 *
 * **`voiceKind` 를 반드시 넘긴다.** 안 넘기면 0(줄)으로 해석돼 마림바가 줄 악기로
 * 울린다 — 그것 때문에 "모달 악기가 전부 NaN" 이라는 잘못된 결론이 나온 적이 있다
 * (`HANDOFF.md`: 측정기를 먼저 검증하라).
 */
function renderNote(instrumentId, midi, seconds, velocity = 0.8) {
  const instrument = resolveInstrument(instrumentId, registry);
  const params = {
    ...instrumentParams(instrument, 'default', null),
    voiceKind: VOICE_KIND_INDEX[instrument.voice] ?? 0,
  };
  wasm.allOff();
  wasm.noteOn(midiToHz(midi), velocity, params);

  const total = Math.round(seconds * FS);
  const mono = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    wasm.process(scratch, frames);
    mono.set(scratch.subarray(0, frames), at);
  }
  return mono;
}

function peakOf(x) {
  // **전개 연산자를 쓰면 안 된다.** 3초 = 144000 샘플이라 스택이 넘친다
  let peak = 0;
  for (let i = 0; i < x.length; i += 1) peak = Math.max(peak, Math.abs(x[i]));
  return peak;
}

/** 소리가 실제로 나는 구간만 — 꼬리의 무음이 평균을 끌어내리지 않게 */
function sounding(x, thresholdDb = -60) {
  const peak = peakOf(x);
  const gate = 10 ** (thresholdDb / 20) * peak;
  let end = x.length;
  while (end > 1 && Math.abs(x[end - 1]) < gate) end -= 1;
  return x.subarray(0, end);
}

/**
 * **잡음 바닥은 음을 끈 상태에서 잰다.**
 *
 * 처음에는 3초 뒤의 꼬리를 쟀는데, 그건 잡음이 아니라 **아직 울리고 있는 음악
 * 신호**였다 — 신스 패드는 노트오프를 안 보내면 영원히 난다. 그 값을 그대로
 * 리포트에 넣었다면 멀쩡한 엔진을 "잡음 바닥 -20dBFS" 라고 보고할 뻔했다.
 */
function idleNoiseFloorDbfs() {
  wasm.allOff();
  const total = Math.round(0.5 * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    wasm.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
  }
  return noiseFloorDbfs(out);
}

function measure(instrumentId, midi) {
  const seconds = 3;
  const x = renderNote(instrumentId, midi, seconds);
  const body = sounding(x);
  const freq = midiToHz(midi);

  const instrument = resolveInstrument(instrumentId, registry);
  // **보이스 이름을 정확히 쓴다.** 'string' 으로 비교했더니 실제 이름이
  // 'waveguide-string' 이라 **줄 악기 전체의 음정 칸이 비어 있었다** —
  // 음정 정밀도는 이 제품의 핵심 주장인데 그게 측정에서 빠져 있었다
  const isTonal =
    instrument.voice === 'waveguide-string' ||
    instrument.voice === 'modal' ||
    instrument.voice === 'virtual-analog';

  // **유니즌 디튠은 설계 의도다.** 여러 보이스를 일부러 어긋나게 쌓아 두께를
  // 만드는 것이라, 거기서 "음정 오차"를 재면 기능을 결함으로 읽는다.
  // synth-lead 가 -3.75센트로 나왔던 것이 그 경우다 (디튠 ±8센트 설정)
  const params0 = instrumentParams(instrument, 'default', null);
  const detuned =
    Number(params0.synthUnison ?? 1) > 1 && Number(params0.synthUnisonDetuneCents ?? 0) > 0;

  return {
    instrument: instrumentId,
    voice: instrument.voice,
    midi,
    peakDbfs: dbfs(peakOf(body)),
    truePeakDbtp: truePeakDbfs(body.subarray(0, Math.min(body.length, FS))),
    rmsDbfs: dbfs(rms(body)),
    lufs: integratedLufs([body, body], FS),
    // **잡음이 아니라 지속성이다.** 3초 뒤에도 얼마나 남아 있는가 —
    // 악기의 성질이지 결함이 아니다
    sustain3sDb: dbfs(rms(x.subarray(x.length - Math.round(0.1 * FS)))) - dbfs(peakOf(body)),
    // 음정은 조성 악기에서만 의미가 있다 (드럼·노이즈는 기본파가 없다)
    centsError: isTonal && !detuned ? preciseCentsError(body, freq, FS) : null,
    detuned,
    attackMs: attackMs(body, FS),
    centroidHz: spectralCentroidHz(body, FS),
    thdPlusNDb: isTonal
      ? thdPlusN(body.subarray(0, Math.min(body.length, FS)), freq, FS).thdPlusNDb
      : null,
    soundingSec: body.length / FS,
  };
}

const ids = onlyInstrument ? [onlyInstrument] : playableInstrumentIds();
const rows = [];
for (const id of ids) {
  const instrument = resolveInstrument(id, registry);
  // 음역 가운데 음 하나 — 악기마다 같은 조건에서 비교되게
  const midi = Math.round((instrument.range.low + instrument.range.high) / 2);
  rows.push(measure(id, midi));
}

// --- 출력 --------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const num = (v, digits = 1, n = 8) =>
  (v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits)).padStart(n);

console.log('');
console.log('음질 리포트 — 48kHz · 벨로시티 0.8 · 음역 중앙 음');
console.log('='.repeat(114));
const head = (t) => String(t).padStart(9);
console.log(
  pad('악기', 24) + pad('보이스', 18) +
    head('피크') + head('트루피크') + head('LUFS') +
    head('3초잔향') + head('음정¢') + head('어택ms') +
    head('중심Hz') + head('THD+N'),
);
console.log('-'.repeat(114));

for (const r of rows) {
  console.log(
    pad(r.instrument, 24) + pad(r.voice, 18) +
      num(r.peakDbfs, 1, 9) + num(r.truePeakDbtp, 1, 9) + num(r.lufs, 1, 9) +
      num(r.sustain3sDb, 0, 9) +
      (r.detuned ? '   유니즌'.padStart(9) : num(r.centsError, 3, 9)) +
      num(r.attackMs, 0, 9) +
      num(r.centroidHz, 0, 9) + num(r.thdPlusNDb, 0, 9),
  );
}

// --- 판정 --------------------------------------------------------------------
//
// **기준을 넘는지 여기서 바로 말한다.** 표만 뽑아 놓으면 아무도 안 본다.

console.log('');
console.log('판정 (`SOUND_QUALITY.md` 기준)');
console.log('-'.repeat(114));

const problems = [];
for (const r of rows) {
  if (r.truePeakDbtp > -1) {
    // -1dBTP 는 스트리밍 플랫폼 공통 권장선. 넘으면 mp3/AAC 변환에서 깎인다
    problems.push(`${r.instrument}: 트루 피크 ${r.truePeakDbtp.toFixed(2)}dBTP (권장 -1 이하)`);
  }
  if (r.centsError !== null && Math.abs(r.centsError) > 1) {
    problems.push(`${r.instrument}: 음정 오차 ${r.centsError.toFixed(2)}센트 (기준 ±1)`);
  }
}

const idleNoise = idleNoiseFloorDbfs();
if (idleNoise > -90) {
  problems.push(`유휴 잡음 바닥 ${idleNoise.toFixed(0)}dBFS (기준 -90 이하)`);
}

const worstPitch = rows.filter((r) => r.centsError !== null);
if (worstPitch.length) {
  const worst = worstPitch.reduce((a, b) => (Math.abs(a.centsError) > Math.abs(b.centsError) ? a : b));
  console.log(`음정 최대 오차   ${worst.centsError.toFixed(3)} 센트  (${worst.instrument}) — 기준 ±1`);
}
const worstPeak = rows.reduce((a, b) => (a.truePeakDbtp > b.truePeakDbtp ? a : b));
console.log(`트루 피크 최대   ${worstPeak.truePeakDbtp.toFixed(2)} dBTP  (${worstPeak.instrument}) — 권장 -1 이하`);
console.log(`유휴 잡음 바닥   ${idleNoise.toFixed(0)} dBFS — 기준 -90 이하`);
const detunedCount = rows.filter((r) => r.detuned).length;
if (detunedCount) {
  console.log(`  (유니즌 디튠 악기 ${detunedCount}개는 음정 측정에서 뺐다 — 어긋남이 설계 의도다)`);
}
console.log('  (음을 끈 상태에서 잰다. 3초 잔향은 잡음이 아니라 악기의 지속성이다)');

console.log('');
if (problems.length === 0) {
  console.log('기준을 넘은 항목 없음.');
} else {
  console.log(`기준을 넘은 항목 ${problems.length}개:`);
  for (const p of problems) console.log(`  - ${p}`);
}

console.log('');
console.log('※ 여기까지가 숫자로 답할 수 있는 부분이다.');
console.log('  "진짜 악기 같은가"는 블라인드 청취로만 판정된다 (sound.md 11-3).');
console.log('  `npm run quality -- --out out/` 로 라우드니스를 맞춘 WAV 를 뽑을 수 있다.');

// --- WAV 내보내기 ------------------------------------------------------------

if (outDir) {
  await mkdir(outDir, { recursive: true });
  for (const r of rows) {
    const x = renderNote(r.instrument, r.midi, 3);
    // **라우드니스를 맞춰서 뽑는다.** 안 맞추면 큰 것이 좋게 들리고,
    // 그렇게 나온 A/B 결론은 전부 버려야 한다
    const { channels, gainDb } = matchLoudness([x, Float32Array.from(x)], TARGET_LUFS, FS);
    const bytes = encodeWav(channels, { sampleRate: FS, bitDepth: 24 });
    await writeFile(`${outDir}/${r.instrument}_midi${r.midi}.wav`, bytes);
    r.exportGainDb = gainDb;
  }
  console.log('');
  console.log(`WAV ${rows.length}개를 ${outDir} 에 저장했다 (${TARGET_LUFS} LUFS 정합).`);
  console.log('  같은 음을 다른 앱에서 내보낸 뒤:');
  console.log('    node --experimental-strip-types tools/quality-compare.mjs 우리.wav 그쪽.wav');
}

// 기계가 읽을 형태도 남긴다 — 나중에 회귀 비교에 쓴다
if (typeof args.get('json') === 'string') {
  await writeFile(args.get('json'), JSON.stringify({ sampleRate: FS, rows }, null, 2));
  console.log(`JSON: ${args.get('json')}`);
}

// 옥타브 밴드는 표가 너무 넓어져서 요청할 때만
if (args.get('bands') && onlyInstrument) {
  const x = sounding(renderNote(onlyInstrument, rows[0].midi, 3));
  console.log('');
  console.log(`옥타브 밴드 — ${onlyInstrument}`);
  for (const b of octaveBands(x, FS)) {
    const bar = '█'.repeat(Math.max(0, Math.round((b.db + 80) / 2)));
    console.log(`  ${String(b.centerHz).padStart(6)}Hz ${b.db.toFixed(1).padStart(7)}dB ${bar}`);
  }
}

// 스테레오 폭은 트랙 렌더에서만 의미가 있다 (보이스 하나는 모노다)
void stereoCorrelation;

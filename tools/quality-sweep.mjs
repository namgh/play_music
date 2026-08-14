/**
 * 전수 측정 — **전 악기 × 전 음역 × 여러 세기.**
 *
 *     npm run quality:sweep
 *     npm run quality:sweep -- --semitones 3     # 더 촘촘히 (느리다)
 *     npm run quality:sweep -- --json out.json
 *
 * ## 왜 전수인가
 *
 * 음역 중앙 한 음만 재면 **가장 어려운 곳을 놓친다.** 웨이브가이드는 고음일수록
 * 딜레이 라인이 짧아져 음정이 틀어지기 쉽고(`sound.md` 6-2), 에일리어싱도 고음에서
 * 나온다. 저음은 반대로 루프가 길어 발산하기 쉽다. **양 끝이 진짜 시험이다.**
 *
 * ## 등급을 숫자로 못 박는다
 *
 * "상~최상"을 인상으로 말하면 아무도 검증할 수 없다. 아래 표는 전부 **들리는가**
 * 또는 **규격이 정했는가**에 근거를 둔다 — 경쟁사가 주장하는 숫자를 옮겨 적지
 * 않는다(확인할 수 없는 값을 기준으로 삼으면 그 자체가 거짓이 된다).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';

import { WasmVoiceEngine } from '../src/audio/voice/wasmEngine.ts';
import { createRegistry, playableInstrumentIds } from '../src/instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../src/instruments/resolve.ts';
import { VOICE_KIND_INDEX } from '../src/instruments/types.ts';
import {
  aliasingVsReferenceDb,
  dbfs,
  spectrum,
  noiseFloorDbfs,
  preciseCentsError,
  rms,
  truePeakDbfs,
} from '../src/audio/quality.ts';

const FS = 48000;
const BLOCK = 128;
const registry = createRegistry();

const args = new Map();
for (let i = 2; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1] ?? true);
}
const STEP = Number(args.get('semitones') ?? 6);

/**
 * 등급표. **각 줄의 근거가 있어야 한다** — 없으면 그냥 바람이다.
 *
 * `최상` 은 "측정으로도 트집 잡을 데가 없다", `상` 은 "들어서 문제를 못 느낀다".
 */
const TIERS = {
  pitchCents: {
    name: '음정 오차',
    unit: '센트',
    best: 0.5,
    good: 1.0,
    ok: 3.0,
    lowerIsBetter: true,
    why: '사람이 구분하는 한계는 지속음에서 약 5센트. 1센트는 그 1/5, 0.5센트는 1/10',
  },
  aliasingDb: {
    name: '에일리어싱',
    unit: 'dB',
    best: -90,
    good: -70,
    ok: -60,
    lowerIsBetter: true,
    why: '접힌 성분은 배음과 무관한 주파수라 적어도 귀에 띈다. -90dB 면 24bit 잡음에 묻힌다',
  },
  truePeakDbtp: {
    name: '트루 피크',
    unit: 'dBTP',
    best: -1.0,
    good: -0.3,
    ok: 0.0,
    lowerIsBetter: true,
    why: 'EBU R128 / 스트리밍 공통 권장선이 -1dBTP. 넘으면 mp3·AAC 변환에서 깎인다',
  },
  dcDb: {
    name: 'DC 오프셋',
    unit: 'dB',
    best: -60,
    good: -45,
    ok: -30,
    lowerIsBetter: true,
    // 처음에 -80/-60/-40 으로 잡았다가 고쳤다. **도달할 수 없는 기준이었다** —
    // 웨이브가이드의 DC 차단 극은 0.76Hz 로 아주 완만한데(`string_voice.rs`
    // DC_BLOCK_POLE), 더 세게 걸면 최저음에서 루프 이득이 1을 넘어 발산한다.
    // 실측하면 최저음의 DC 가 시간에 따라 -47 → -58dB 로 **정착해 간다**.
    // 기준을 내가 지어내고 엔진을 탓하는 것이 가장 나쁜 보고다
    why: '안 들리지만 헤드룸을 먹는다. -30dB 는 1%, -60dB 는 0.1%. 최저음은 차단기가 정착 중이다',
  },
  noiseFloorDbfs: {
    name: '유휴 잡음 바닥',
    unit: 'dBFS',
    best: -120,
    good: -100,
    ok: -90,
    lowerIsBetter: true,
    why: '24bit 이론 한계가 -144dBFS. -120 이면 어떤 재생 환경에서도 안 들린다',
  },
};

function grade(key, value) {
  const t = TIERS[key];
  if (value === null || !Number.isFinite(value)) return '—';
  const v = t.lowerIsBetter ? value : -value;
  const best = t.lowerIsBetter ? t.best : -t.best;
  const good = t.lowerIsBetter ? t.good : -t.good;
  const ok = t.lowerIsBetter ? t.ok : -t.ok;
  if (v <= best) return '최상';
  if (v <= good) return '상';
  if (v <= ok) return '중';
  return '미달';
}

const wasmPath = fileURLToPath(new URL('../src/generated/dsp.wasm', import.meta.url));
const wasmBytes = await readFile(wasmPath);
const wasm = await WasmVoiceEngine.create(wasmBytes, FS);
// **에일리어싱 기준용 4배 표본율 엔진.** 접힘이 없는 쪽과 견주어야 비조화 부분음을
// 접힘으로 오해하지 않는다 (그 오해로 멀쩡한 피아노가 +21dB 로 읽혔다)
const REF_RATE = FS * 4;
const wasmRef = await WasmVoiceEngine.create(wasmBytes, REF_RATE);
const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

function renderWith(engine, rate, instrument, midi, seconds, velocity) {
  const params = {
    ...instrumentParams(instrument, 'default', null),
    voiceKind: VOICE_KIND_INDEX[instrument.voice] ?? 0,
  };
  engine.allOff();
  engine.noteOn(midiToHz(midi), velocity, params);
  const total = Math.round(seconds * rate);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    engine.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
  }
  return out;
}

const renderNote = (instrument, midi, seconds, velocity) =>
  renderWith(wasm, FS, instrument, midi, seconds, velocity);

function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i += 1) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/**
 * DC 오프셋 — **스펙트럼의 0Hz 빈**으로 잰다.
 *
 * 처음에는 시간축 평균으로 쟀는데 타악에서 엉뚱한 값이 나왔다. 킥은 2초 창의
 * 대부분이 무음이라 평균도 RMS 도 거의 0 이고, 그 비율은 아무 값이나 된다 —
 * DC 차단기를 붙여도 값이 안 변해서 계기가 틀렸다는 걸 알았다.
 * 시간축 평균은 **감쇠하는 소리와 저역 스윕에 오염된다.**
 *
 * 0Hz 빈은 정의 그대로다. 창은 Blackman-Harris 로 잡아 40Hz 성분이 0Hz 로
 * 새어 들어오지 않게 한다.
 */
function dcDb(x) {
  // **어택을 뺀다.** 발음 순간은 계단에 가까워서 스펙트럼이 0Hz 까지 퍼진다 —
  // 그건 DC 오프셋이 아니라 온셋이다. 어택을 넣고 재면 멀쩡한 하프가 -36dB 로
  // 읽힌다 (계기가 세 번째로 틀린 자리였다)
  const from = Math.round(0.2 * FS);
  const window = x.subarray(from, from + 32768);
  if (window.length < 8192) return -200; // 짧은 소리는 판정하지 않는다
  const level = rms(window);
  if (level < 1e-9) return -200;
  const mag = spectrum(window, 32768, 'blackman-harris');
  return dbfs(mag[0]) - dbfs(level);
}

function idleNoiseFloor() {
  wasm.allOff();
  const total = Math.round(0.5 * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    scratch.fill(0);
    wasm.process(scratch, Math.min(BLOCK, total - at));
    out.set(scratch.subarray(0, Math.min(BLOCK, total - at)), at);
  }
  return noiseFloorDbfs(out);
}

// --- 측정 --------------------------------------------------------------------

const VELOCITIES = [0.3, 0.8, 1.0];
const results = [];
let noteCount = 0;

for (const id of playableInstrumentIds()) {
  const instrument = resolveInstrument(id, registry);
  const params0 = instrumentParams(instrument, 'default', null);
  const detuned =
    Number(params0.synthUnison ?? 1) > 1 && Number(params0.synthUnisonDetuneCents ?? 0) > 0;
  const tonal =
    instrument.voice === 'waveguide-string' ||
    instrument.voice === 'modal' ||
    (instrument.voice === 'virtual-analog' && !detuned);

  const worst = {
    instrument: id,
    voice: instrument.voice,
    tonal,
    notes: 0,
    pitchCents: null,
    pitchAt: null,
    aliasingDb: null,
    aliasingAt: null,
    truePeakDbtp: -Infinity,
    truePeakAt: null,
    dcDb: -Infinity,
    nonFinite: [],
  };

  const { low, high } = instrument.range;
  for (let midi = low; midi <= high; midi += STEP) {
    for (const vel of VELOCITIES) {
      const x = renderNote(instrument, midi, 2, vel);
      noteCount += 1;
      worst.notes += 1;

      if (!x.every(Number.isFinite)) {
        worst.nonFinite.push(`midi=${midi} vel=${vel}`);
        continue;
      }
      const peak = peakOf(x);
      if (peak < 1e-6) continue; // 소리가 안 나는 조합은 건너뛴다

      const tp = truePeakDbfs(x.subarray(0, Math.min(x.length, FS)));
      if (tp > worst.truePeakDbtp) {
        worst.truePeakDbtp = tp;
        worst.truePeakAt = `midi=${midi} vel=${vel}`;
      }
      const dc = dcDb(x);
      if (dc > worst.dcDb) worst.dcDb = dc;

      if (tonal) {
        const hz = midiToHz(midi);
        const cents = preciseCentsError(x, hz, FS, 65536);
        if (worst.pitchCents === null || Math.abs(cents) > Math.abs(worst.pitchCents)) {
          worst.pitchCents = cents;
          worst.pitchAt = `midi=${midi} vel=${vel}`;
        }
      }
    }
  }
  // **에일리어싱은 모달 악기에서만 이 방법으로 잴 수 있다.**
  //
  // 4배 표본율 기준과 견주는 방법은 "같은 소리가 나야 한다"를 전제한다. 모달 합성은
  // 감쇠 사인의 합이라 표본율이 바뀌어도 같은 소리가 난다 — 그래서 차이가 곧 접힘이다.
  //
  // 웨이브가이드와 버추얼 아날로그는 다르다. 딜레이 길이·루프 필터 계수·오실레이터
  // 위상이 표본율에 따라 달라져서 **악기 자체가 달라진다.** 그 차이를 접힘으로 읽으면
  // 멀쩡한 클라비넷이 +18dB(기본파보다 접힘이 크다는 물리적으로 불가능한 값)로 나온다.
  //
  // 그쪽은 **비선형 단계에서 직접 잰다** — 그게 접힘이 실제로 생기는 자리다:
  //   `dsp/src/oversample.rs`  report_actual_aliasing_margin
  //   `dsp/src/amp.rs`         report_distortion_aliasing_margin
  //   `dsp/src/synth.rs`       report_oscillator_aliasing_margin
  // **앰프가 붙으면 표본율 무관성이 깨진다.** 오버샘플러의 컷오프가 표본율에
  // 비례해서(48k 에서 12kHz, 192k 에서 48kHz), 같은 소리가 아니게 된다.
  // 월리처(드라이브 0.32)가 그 때문에 -39.9dB 로 읽혔다 — 접힘이 아니었다.
  // 앰프의 접힘은 Rust 에서 순음을 넣어 직접 잰다 (실측 -189dB)
  const amped = Number(params0.ampDrive ?? 0) > 0;
  const aliasingMeasurable = instrument.voice === 'modal' && !amped;
  if (aliasingMeasurable) {
    const probes = [high, Math.round((low + high * 3) / 4), Math.round((low + high) / 2)];
    for (const midi of [...new Set(probes)]) {
      const hz = midiToHz(midi);
      const lowRender = renderWith(wasm, FS, instrument, midi, 1.5, 1.0);
      const refRender = renderWith(wasmRef, REF_RATE, instrument, midi, 1.5, 1.0);
      noteCount += 2;
      // 어택 이후 정상 구간을 본다
      const from48 = Math.round(0.2 * FS);
      const fromRef = Math.round(0.2 * REF_RATE);
      const al = aliasingVsReferenceDb(
        lowRender.subarray(from48),
        FS,
        refRender.subarray(fromRef),
        REF_RATE,
        hz,
      );
      if (Number.isFinite(al) && (worst.aliasingDb === null || al > worst.aliasingDb)) {
        worst.aliasingDb = al;
        worst.aliasingAt = `midi=${midi} vel=1.0`;
      }
    }
  }

  // 마지막 음역은 반드시 포함한다 (STEP 때문에 빠지면 가장 어려운 곳을 놓친다)
  if ((high - low) % STEP !== 0 && tonal) {
    const x = renderNote(instrument, high, 2, 0.8);
    noteCount += 1;
    const cents = preciseCentsError(x, midiToHz(high), FS, 65536);
    if (worst.pitchCents === null || Math.abs(cents) > Math.abs(worst.pitchCents)) {
      worst.pitchCents = cents;
      worst.pitchAt = `midi=${high} vel=0.8 (최고음)`;
    }
  }
  results.push(worst);
  process.stderr.write(`\r측정 중… ${results.length}/${playableInstrumentIds().length} (${noteCount}음)`);
}
process.stderr.write('\r' + ' '.repeat(60) + '\r');

const idleNoise = idleNoiseFloor();

// --- 출력 --------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const numCol = (v, d, n = 10) =>
  (v === null || !Number.isFinite(v) ? '—' : v.toFixed(d)).padStart(n);

console.log('');
console.log(`전수 측정 — 악기 ${results.length}개 · ${noteCount}음 (${STEP}반음 간격 × 세기 3종)`);
console.log('='.repeat(100));
console.log(
  pad('악기', 24) +
    numCol('음정¢', 0) + '  ' + pad('등급', 6) +
    numCol('에일리어싱', 0) + '  ' + pad('등급', 6) +
    numCol('트루피크', 0) + '  ' + pad('등급', 6),
);
console.log('-'.repeat(100));

for (const r of results) {
  console.log(
    pad(r.instrument, 24) +
      numCol(r.pitchCents, 3) + '  ' + pad(grade('pitchCents', Math.abs(r.pitchCents ?? NaN)), 6) +
      numCol(r.aliasingDb, 1) + '  ' + pad(grade('aliasingDb', r.aliasingDb), 6) +
      numCol(r.truePeakDbtp, 2) + '  ' + pad(grade('truePeakDbtp', r.truePeakDbtp), 6),
  );
}

// --- 종합 --------------------------------------------------------------------

console.log('');
console.log('종합 — 가장 나쁜 값 기준 (최악의 한 음이 곧 제품의 수준이다)');
console.log('='.repeat(100));

const tonalRows = results.filter((r) => r.tonal && r.pitchCents !== null);
const worstPitch = tonalRows.reduce((a, b) => (Math.abs(a.pitchCents) > Math.abs(b.pitchCents) ? a : b));
const aliasRows = results.filter((r) => r.aliasingDb !== null);
const worstAlias = aliasRows.length
  ? aliasRows.reduce((a, b) => (a.aliasingDb > b.aliasingDb ? a : b))
  : { aliasingDb: null, instrument: '—', aliasingAt: '' };
const worstTp = results.reduce((a, b) => (a.truePeakDbtp > b.truePeakDbtp ? a : b));
const worstDc = results.reduce((a, b) => (a.dcDb > b.dcDb ? a : b));

const summary = [
  ['pitchCents', Math.abs(worstPitch.pitchCents), `${worstPitch.instrument} ${worstPitch.pitchAt}`],
  ['aliasingDb', worstAlias.aliasingDb, `${worstAlias.instrument} ${worstAlias.aliasingAt}`],
  ['truePeakDbtp', worstTp.truePeakDbtp, `${worstTp.instrument} ${worstTp.truePeakAt}`],
  ['dcDb', worstDc.dcDb, worstDc.instrument],
  ['noiseFloorDbfs', idleNoise, '음을 끈 상태'],
];

console.log(
  pad('항목', 18) + numCol('실측', 0, 10) + '  ' + pad('등급', 6) +
    pad('최상', 9) + pad('상', 9) + pad('중', 9) + '어디서',
);
console.log('-'.repeat(100));
for (const [key, value, where] of summary) {
  const t = TIERS[key];
  console.log(
    pad(t.name, 18) + numCol(value, 2, 10) + '  ' + pad(grade(key, value), 6) +
      pad(t.best, 9) + pad(t.good, 9) + pad(t.ok, 9) + where,
  );
}

console.log('');
console.log('에일리어싱은 모달 악기만 여기서 잰다 (표본율이 바뀌어도 같은 소리가 나므로).');
console.log('웨이브가이드·신스는 표본율에 따라 악기 자체가 달라져 이 방법이 성립하지 않는다 —');
console.log('접힘이 실제로 생기는 **비선형 단계**에서 직접 잰다:');
console.log('  cargo test --manifest-path dsp/Cargo.toml report_ -- --nocapture');
console.log('');
console.log('각 기준의 근거');
console.log('-'.repeat(100));
for (const key of Object.keys(TIERS)) {
  console.log(`  ${pad(TIERS[key].name, 18)} ${TIERS[key].why}`);
}

const broken = results.filter((r) => r.nonFinite.length);
if (broken.length) {
  console.log('');
  console.log('⚠ 유한하지 않은 출력 (NaN·발산) — 그 시점부터 트랙 전체가 무음이 된다');
  for (const r of broken) console.log(`  ${r.instrument}: ${r.nonFinite.join(', ')}`);
}

const grades = summary.map(([k, v]) => grade(k, v));
const worstGrade = grades.includes('미달')
  ? '미달'
  : grades.includes('중')
    ? '중'
    : grades.includes('상')
      ? '상'
      : '최상';
console.log('');
console.log(`종합 등급: **${worstGrade}** — 가장 낮은 항목을 따른다`);
if (worstGrade !== '최상') {
  console.log('');
  console.log('최상까지 남은 것:');
  for (const [key, value, where] of summary) {
    const g = grade(key, value);
    if (g !== '최상') {
      const t = TIERS[key];
      console.log(
        `  · ${t.name}: ${value.toFixed(2)}${t.unit} → 최상은 ${t.best}${t.unit} 이하 (${where})`,
      );
    }
  }
}

if (typeof args.get('json') === 'string') {
  await writeFile(
    args.get('json'),
    JSON.stringify({ sampleRate: FS, step: STEP, noteCount, idleNoise, results, TIERS }, null, 2),
  );
  console.log(`\nJSON: ${args.get('json')}`);
}

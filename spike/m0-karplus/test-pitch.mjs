/**
 * 음정 정확도 회귀 테스트 (sound.md 11-1)
 *
 *   실행: node spike/m0-karplus/test-pitch.mjs
 *
 * 브라우저에서 소리를 내는 것과 **같은 ks-string.js**를 오프라인으로 렌더해서
 * 기본 주파수를 재고, 목표 대비 센트 오차를 본다. 허용 오차 ±1센트.
 *
 * 이 테스트가 존재하는 이유: 웨이브가이드의 딜레이 길이는 정수 샘플인데 필요한
 * 주기는 소수점이다. 반올림하면 음정이 틀어지고 고음일수록 심해진다.
 * "음정이 정밀하다"는 제품 주장 전체가 여기 걸려 있다 (sound.md 6-2).
 *
 * 아래 리포트는 분수 딜레이를 껐을 때의 오차도 같이 찍는다 — 왜 타협 불가인지
 * 숫자로 남기기 위한 것.
 */

import { KSString } from './ks-string.js';

const FS = 48000;
const TOLERANCE_CENTS = 1.0;

// 재현 가능한 여진을 위해 Math.random 을 시드 있는 LCG로 교체.
// (여진은 노이즈지만 테스트 결과가 실행마다 흔들리면 회귀 테스트가 안 된다)
let seed = 0x2f6e2b1;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

// ---------------------------------------------------------------------------
// f0 측정 — 목표 주파수로 복조한 뒤 두 창의 위상 흐름으로 오차를 읽는다.
// FFT 피크 보간보다 훨씬 정확하다 (0.01센트 수준).
// ---------------------------------------------------------------------------

function demodPhase(x, start, len, fTarget) {
  const w = (2 * Math.PI * fTarget) / FS;
  let re = 0;
  let im = 0;
  for (let m = 0; m < len; m++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * m) / (len - 1));
    const s = x[start + m] * win;
    re += s * Math.cos(w * m);
    im -= s * Math.sin(w * m);
  }
  // 공통 시간 원점으로 되돌려야 두 창의 차이가 (실제-목표) 주파수에 비례한다
  return Math.atan2(im, re) - w * start;
}

function wrapPi(x) {
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/**
 * 신호가 실제로 살아 있는 구간을 찾는다.
 *
 * 고정된 구간을 쓰면 안 된다 — 고음은 수십~수백 ms 만에 -60dB로 떨어지므로
 * 창이 소멸 구간에 걸리면 노이즈의 위상을 재게 되고, 측정값이 통째로 거짓이 된다.
 * (이 함정 때문에 C8이 -53센트로 잘못 보고됐다)
 */
function analysisRegion(x, f) {
  const blk = Math.max(8, Math.round(FS / f)); // 한 주기
  const nBlocks = Math.floor(x.length / blk);
  const rms = new Float64Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    let s = 0;
    for (let i = 0; i < blk; i++) {
      const v = x[b * blk + i];
      s += v * v;
    }
    rms[b] = Math.sqrt(s / blk);
  }
  let peakB = 0;
  for (let b = 0; b < nBlocks; b++) if (rms[b] > rms[peakB]) peakB = b;

  const floorRms = rms[peakB] * 0.01; // -40 dB
  let endB = nBlocks;
  for (let b = peakB; b < nBlocks; b++) {
    if (rms[b] < floorRms) { endB = b; break; }
  }
  return { start: (peakB + 1) * blk, end: endB * blk, period: blk };
}

/**
 * fTarget 근처의 실제 주파수 측정. 창 간격이 넓을수록 정확하지만 위상이 감기면
 * (오차가 ±1/(2·간격) Hz 를 넘으면) 값이 거짓이 된다. 그래서 2패스로 간다:
 * 좁은 간격으로 대충 잡고, 그 값을 기준으로 넓은 간격으로 정밀 측정.
 */
function measureFreq(x, fTarget) {
  const { start, end, period } = analysisRegion(x, fTarget);
  const available = end - start;
  if (available < 12 * period) {
    throw new Error(`측정 구간 부족 (${(available / FS * 1000).toFixed(1)}ms, ${fTarget.toFixed(0)}Hz)`);
  }

  // 창 길이: 기본음과 2배음이 분리될 만큼(≥8주기), 최대 0.25초, 구간의 45% 이하
  const winLen = Math.max(
    4 * period,
    Math.min(Math.round(0.25 * FS), Math.max(8 * period, 256), Math.floor(available * 0.45))
  );

  const measure = (target, unambiguousCents) => {
    const halfRange = target * (Math.pow(2, unambiguousCents / 1200) - 1);
    const gap = Math.max(
      32,
      Math.min(Math.round(FS / (2 * halfRange)), available - winLen)
    );
    if (start + gap + winLen > x.length) throw new Error('렌더 길이 부족');
    const p1 = demodPhase(x, start, winLen, target);
    const p2 = demodPhase(x, start + gap, winLen, target);
    return target + wrapPi(p2 - p1) / (2 * Math.PI * (gap / FS));
  };

  const coarse = measure(fTarget, 600); // ±600센트까지 감기지 않게
  return measure(coarse, 30);           // 그 값 기준으로 정밀 측정
}

function cents(measured, target) {
  return 1200 * Math.log2(measured / target);
}

// ---------------------------------------------------------------------------
// 0단계: 측정기 자체를 먼저 검증한다.
// 측정기가 틀리면 아래 결과 전부가 거짓말이 된다.
// ---------------------------------------------------------------------------

function selfCheck() {
  const cases = [
    [55, 1.7], [440, 3.5], [1000, -2.2], [4186, 6.0], // [기준 Hz, 넣을 센트 오차]
  ];
  let worst = 0;
  for (const [base, offsetCents] of cases) {
    const actual = base * Math.pow(2, offsetCents / 1200);
    const n = Math.round(0.8 * FS);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-i / (0.5 * FS)); // 감쇠도 있는 상태로 테스트
      x[i] = env * (Math.sin((2 * Math.PI * actual * i) / FS)
        + 0.4 * Math.sin((2 * Math.PI * 2 * actual * i) / FS + 1)
        + 0.2 * Math.sin((2 * Math.PI * 3 * actual * i) / FS + 2));
    }
    const err = Math.abs(cents(measureFreq(x, base), base) - offsetCents);
    worst = Math.max(worst, err);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// 렌더
// ---------------------------------------------------------------------------

const BLOCK = 128; // AudioWorklet 블록 크기와 동일하게

function renderNote(freq, params) {
  const str = new KSString(FS);
  str.setParams({ ...params, sustainSec: 8 }); // 측정 구간까지 살아 있게
  str.pluck(freq, 1);

  const total = Math.round(0.8 * FS);
  const out = new Float32Array(total);
  const block = new Float32Array(BLOCK);
  for (let i = 0; i < total; i += BLOCK) {
    block.fill(0);
    str.process(block, BLOCK);
    out.set(block.subarray(0, Math.min(BLOCK, total - i)), i);
  }
  return out;
}

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

const SCALES = [
  { label: '우쿨렐레 347mm', scaleLengthMm: 347 },
  { label: '레스폴 628mm', scaleLengthMm: 628 },
  { label: '스트랫 648mm', scaleLengthMm: 648 },
  { label: '베이스 864mm', scaleLengthMm: 864 },
];

// C1(24) ~ C8(108) — 화면 건반(C1~C7)보다 넓게 잡아 양 끝 실패를 잡는다.
// 노출된 음역은 전부 자동 검증 대상이어야 한다 (sound.md 9-7).
const MIDI_FROM = 24;
const MIDI_TO = 108;

const selfErr = selfCheck();
console.log(`측정기 자체 검증: 최대 오차 ${selfErr.toFixed(4)} 센트 ${selfErr < 0.05 ? '✓' : '✗ (측정기가 부정확하다)'}`);
if (selfErr >= 0.05) process.exit(1);

console.log(`\n음정 정확도 — C1~C8 (${MIDI_TO - MIDI_FROM + 1}음) × 스케일 ${SCALES.length}종, 허용 ±${TOLERANCE_CENTS}센트\n`);

let failures = [];
let overallWorst = 0;

for (const scale of SCALES) {
  let worstFrac = { cents: 0, note: '' };
  let worstInt = { cents: 0, note: '' };

  for (let m = MIDI_FROM; m <= MIDI_TO; m++) {
    const f = midiToHz(m);

    const eFrac = cents(measureFreq(renderNote(f, { ...scale, fractionalDelay: true }), f), f);
    if (Math.abs(eFrac) > Math.abs(worstFrac.cents)) worstFrac = { cents: eFrac, note: midiName(m) };
    if (Math.abs(eFrac) > TOLERANCE_CENTS) {
      failures.push({ scale: scale.label, note: midiName(m), cents: eFrac });
    }

    const eInt = cents(measureFreq(renderNote(f, { ...scale, fractionalDelay: false }), f), f);
    if (Math.abs(eInt) > Math.abs(worstInt.cents)) worstInt = { cents: eInt, note: midiName(m) };
  }

  overallWorst = Math.max(overallWorst, Math.abs(worstFrac.cents));
  const mark = Math.abs(worstFrac.cents) <= TOLERANCE_CENTS ? '✓' : '✗';
  console.log(
    `${mark} ${scale.label.padEnd(16)}` +
    ` 분수 딜레이: 최대 ${worstFrac.cents >= 0 ? '+' : ''}${worstFrac.cents.toFixed(3)} 센트 (${worstFrac.note})` +
    `   │ 정수 반올림: 최대 ${worstInt.cents >= 0 ? '+' : ''}${worstInt.cents.toFixed(1)} 센트 (${worstInt.note})`
  );
}

console.log('');
if (failures.length === 0) {
  console.log(`통과 — 전 음역 최대 오차 ${overallWorst.toFixed(3)} 센트 (허용 ${TOLERANCE_CENTS})`);
} else {
  console.log(`실패 ${failures.length}건:`);
  for (const f of failures.slice(0, 20)) {
    console.log(`  ${f.scale} ${f.note}: ${f.cents.toFixed(3)} 센트`);
  }
  if (failures.length > 20) console.log(`  … 외 ${failures.length - 20}건`);
  process.exit(1);
}

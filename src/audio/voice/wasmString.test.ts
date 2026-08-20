/**
 * M1 검증: Rust DSP 코어.
 *
 * TS 구현과 **같은 측정기**(`analysis.ts`)로 잰다. 측정 코드가 하나이므로
 * 두 구현의 결과를 직접 비교할 수 있다.
 *
 * 확인하는 것:
 *  1. 음정 정확도 ±1센트 — 포팅하면서 M0 함정을 다시 밟지 않았는지
 *  2. **`sustainSec` 이 고음에서도 동작하는지** — M0 에서 미해결로 남긴 항목
 *  3. DC 가 남지 않는지
 *  4. TS 구현과 음정이 일치하는지 (교차 검증)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { WasmVoiceEngine } from './wasmEngine.ts';
import { WaveguideStringVoice } from './waveguideString.ts';
import { measureCentsError, measureFundamentalT60, seededRng } from '../analysis.ts';
import { loadAllInstruments, playableInstrumentIds } from '../../instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../../instruments/resolve.ts';
import type { ParamValue } from '../../instruments/types.ts';

const FS = 48000;
const BLOCK = 128;
const TOLERANCE_CENTS = 1;
const registry = await loadAllInstruments();

const wasmPath = fileURLToPath(new URL('../../generated/dsp.wasm', import.meta.url));

async function engine(): Promise<WasmVoiceEngine> {
  const bytes = await readFile(wasmPath);
  return WasmVoiceEngine.create(bytes, FS);
}

/** Rust 코어로 음 하나를 렌더한다 */
function renderWasm(
  wasm: WasmVoiceEngine,
  freqHz: number,
  params: Readonly<Record<string, ParamValue>>,
  seconds: number,
): Float32Array {
  wasm.allOff();
  const voice = wasm.noteOn(freqHz, 1, params);
  const total = Math.round(seconds * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    wasm.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
  }
  return Object.assign(out, { voice });
}

/** TS 구현으로 같은 음을 렌더한다 */
function renderTs(
  freqHz: number,
  params: Readonly<Record<string, ParamValue>>,
  seconds: number,
): Float32Array {
  const voice = new WaveguideStringVoice(FS, seededRng());
  voice.noteOn(freqHz, 1, params);
  const total = Math.round(seconds * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    voice.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
  }
  return out;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

test('Rust 코어가 로드되고 초기화된다', async () => {
  const wasm = await engine();
  assert.equal(wasm.sampleRate, FS);
});

test('Rust 코어의 음정이 전 음역에서 ±1센트 안이다', async () => {
  const wasm = await engine();
  const params = instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null);

  const failures: string[] = [];
  for (let midi = 24; midi <= 96; midi += 3) {
    const hz = midiToHz(midi);
    const pcm = renderWasm(wasm, hz, params, 2);
    const err = measureCentsError(pcm, hz, FS);
    if (Math.abs(err) > TOLERANCE_CENTS) failures.push(`midi=${midi}: ${err.toFixed(3)} 센트`);
  }
  assert.deepEqual(failures, [], `음정 오차 초과:\n${failures.join('\n')}`);
});

test('센트 미세조정이 Rust 코어에서도 정확하다', async () => {
  const wasm = await engine();
  const params = instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null);

  for (const cents of [-49, -14, -1, 1, 14, 49]) {
    const hz = midiToHz(57) * Math.pow(2, cents / 1200);
    const err = measureCentsError(renderWasm(wasm, hz, params, 2), hz, FS);
    assert.ok(Math.abs(err) <= TOLERANCE_CENTS, `${cents}센트 → 오차 ${err.toFixed(3)} 센트`);
  }
});

test('모든 내장 악기가 Rust 코어에서 음정이 맞는다', async () => {
  const wasm = await engine();
  const failures: string[] = [];

  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    // 이 파일은 줄 보이스를 검증한다. 다른 보이스 타입은 pipeline.test.ts 가
    // 종단으로 본다 — 여기서 섞으면 무엇을 재는지 흐려진다
    if (instrument.voice !== 'waveguide-string') continue;

    // **앰프를 끄고 잰다.** ±1센트 주장은 합성 엔진(줄)에 대한 것이다.
    // 왜곡은 상호변조 성분을 기본음 근처에 만들어 측정값을 당긴다 — 실제 디스토션
    // 기타에서도 일어나는 일이고, 아래 별도 테스트가 그 크기를 따로 묶는다
    const params = { ...instrumentParams(instrument, 'default', null), ampEnabled: 0 };
    for (const midi of [
      instrument.range.low,
      Math.round((instrument.range.low + instrument.range.high) / 2),
      instrument.range.high,
    ]) {
      const hz = midiToHz(midi);
      const err = measureCentsError(renderWasm(wasm, hz, params, 2), hz, FS);
      if (Math.abs(err) > TOLERANCE_CENTS) failures.push(`${id} midi=${midi}: ${err.toFixed(3)} 센트`);
    }
  }
  assert.deepEqual(failures, [], `음정 오차 초과:\n${failures.join('\n')}`);
});

test('sustainSec 이 고음에서도 동작한다 — M0 미해결 항목', async () => {
  // M0 의 TS 구현에서는 지정값의 6% (C8 에서 182ms) 밖에 안 나왔다.
  // Rust 쪽은 루프 필터를 기본음에서 단위 이득으로 정규화하고 DC 차단기를 넣어
  // 루프 이득만이 T60 을 정하게 만들었다.
  const wasm = await engine();
  const base = instrumentParams(resolveInstrument('electric-guitar', registry), 'default', null);
  const target = 3;
  const params = { ...base, sustainSec: target };

  const report: string[] = [];
  const failures: string[] = [];

  for (const midi of [40, 52, 64, 76, 88, 96]) {
    const hz = midiToHz(midi);
    const t60 = measureFundamentalT60(renderWasm(wasm, hz, params, target * 1.6), hz, FS);
    const ratio = t60 === Infinity ? Infinity : t60 / target;
    report.push(`midi=${midi} (${hz.toFixed(0)}Hz): ${(ratio * 100).toFixed(0)}%`);
    // 지정값의 70% 이상이면 파라미터가 "말한 대로" 동작한다고 본다.
    // 100% 를 요구하지 않는 이유: 고음이 조금 빨리 죽는 것 자체는 실제 줄과 같은 방향이다
    if (!(ratio >= 0.7)) failures.push(`midi=${midi}: 지정 ${target}s 중 ${(ratio * 100).toFixed(0)}%`);
  }

  assert.deepEqual(failures, [], `서스테인이 지정값을 못 따라간다:\n${report.join('\n')}`);
});

test('서스테인 값을 바꾸면 실제 감쇠가 따라 바뀐다', async () => {
  const wasm = await engine();
  const base = instrumentParams(resolveInstrument('electric-guitar', registry), 'default', null);
  const hz = midiToHz(76); // E6 — M0 에서 56% 밖에 안 나왔던 음역

  const short = measureFundamentalT60(renderWasm(wasm, hz, { ...base, sustainSec: 1 }, 4), hz, FS);
  const long = measureFundamentalT60(renderWasm(wasm, hz, { ...base, sustainSec: 4 }, 8), hz, FS);

  assert.ok(long > short * 2.5, `1s→${short.toFixed(2)}s, 4s→${long.toFixed(2)}s 로 비례하지 않는다`);
});

test('Rust 코어에 DC 가 남지 않는다', async () => {
  const wasm = await engine();
  const params = instrumentParams(resolveInstrument('electric-bass', registry), 'default', null);

  for (const midi of [28, 40, 55]) {
    const pcm = renderWasm(wasm, midiToHz(midi), params, 2);
    let sum = 0;
    let sq = 0;
    for (const v of pcm) { sum += v; sq += v * v; }
    const dc = Math.abs(sum / pcm.length);
    const rms = Math.sqrt(sq / pcm.length);
    assert.ok(dc < rms * 0.02, `midi=${midi}: DC ${dc.toExponential(2)} / RMS ${rms.toExponential(2)}`);
  }
});

test('TS 구현과 Rust 구현의 음정이 일치한다', async () => {
  // 포팅 검증. 파형이 비트 단위로 같을 필요는 없다 (여진 난수원이 다르다).
  // 음정이 어긋나면 포팅에서 무언가를 빠뜨린 것이다.
  //
  // **줄 모델만 비교한다.** TS 구현은 워크렛을 못 쓰는 환경의 폴백이라 줄만 있고
  // 몸통·2편광·연주 노이즈가 없다. 그것들을 켠 채로 비교하면 "포팅이 틀렸다"가
  // 아니라 "층이 다르다"를 재게 된다
  const wasm = await engine();
  const params = {
    ...instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null),
    bodyAmount: 0,
    polarizationMix: 0,
    playNoiseAmount: 0,
  };

  for (const midi of [40, 57, 76, 88]) {
    const hz = midiToHz(midi);
    const tsErr = measureCentsError(renderTs(hz, params, 2), hz, FS);
    const rustErr = measureCentsError(renderWasm(wasm, hz, params, 2), hz, FS);
    assert.ok(
      Math.abs(tsErr - rustErr) < 0.5,
      `midi=${midi}: TS ${tsErr.toFixed(3)} vs Rust ${rustErr.toFixed(3)} 센트`,
    );
  }
});

test('극단 파라미터에서 NaN·발산이 없다', async () => {
  const wasm = await engine();
  const extremes: Record<string, ParamValue>[] = [
    { scaleLengthMm: 300, stiffness: 0.05, damping: 0.25, sustainSec: 10, pluckPosition: 0.5, pluckHardness: 1 },
    { scaleLengthMm: 900, stiffness: 0, damping: 0, sustainSec: 0.3, pluckPosition: 0.02, pluckHardness: 0 },
    { scaleLengthMm: 300, stiffness: 0.05, damping: 0, sustainSec: 10, pluckPosition: 0.02, pluckHardness: 1 },
  ];

  for (const [i, params] of extremes.entries()) {
    for (const midi of [24, 60, 96]) {
      const pcm = renderWasm(wasm, midiToHz(midi), params, 3);
      assert.ok(pcm.every(Number.isFinite), `극단 ${i} midi=${midi}: 유한값이 아닌 샘플`);
      let peak = 0;
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
      assert.ok(peak < 4, `극단 ${i} midi=${midi}: 피크 ${peak.toFixed(2)} (발산 의심)`);
    }
  }
});

test('보이스 스틸링이 폴리포니 상한을 지키고 동시 발음이 합산된다', async () => {
  const wasm = await engine();
  const params = instrumentParams(resolveInstrument('harp', registry), 'default', null);

  wasm.allOff();
  for (let i = 0; i < 100; i++) wasm.noteOn(midiToHz(48 + (i % 24)), 0.8, params);

  const out = new Float32Array(BLOCK);
  const active = wasm.process(out, BLOCK);

  // `active` 에는 **페이드아웃 중인 것도 들어간다.** 폴리포니 상한은 살아 있는
  // 보이스에만 걸리므로 그 둘을 나눠서 봐야 한다 (`WORKPLAN.md` 2-4)
  assert.ok(active > 0, '아무 소리도 안 난다');
  assert.ok(active <= wasm.maxVoices, `울리는 보이스 ${active} 개 > 슬롯 ${wasm.maxVoices}`);
  assert.ok(
    wasm.liveVoices <= 32,
    `살아 있는 보이스 ${wasm.liveVoices} 개 (폴리포니 상한 32)`,
  );
  assert.ok(wasm.maxVoices > 32, '페이드아웃 전용 여유 슬롯이 없다 — 훔칠 때 클릭이 난다');
  assert.ok(out.every(Number.isFinite));
});

test('보이스를 뺏을 때 파형이 튀지 않는다 (클릭 없음)', async () => {
  // 즉시 리셋하면 울리던 파형이 한 샘플에 0 으로 점프하고 그게 클릭이다.
  // 페이드가 걸리면 인접 샘플 차가 파형 자체의 변화폭을 넘지 않는다
  const wasm = await engine();
  const params = instrumentParams(resolveInstrument('harp', registry), 'default', null);

  wasm.allOff();
  // 상한까지 채우고 잠깐 울린다
  for (let i = 0; i < 32; i++) wasm.noteOn(midiToHz(48 + (i % 24)), 0.8, params);
  const warm = new Float32Array(BLOCK);
  wasm.process(warm, BLOCK);

  let baseStep = 0;
  for (let i = 1; i < BLOCK; i++) baseStep = Math.max(baseStep, Math.abs(warm[i]! - warm[i - 1]!));

  // 이제 상한을 넘겨 뺏게 만든다
  for (let i = 0; i < 8; i++) wasm.noteOn(midiToHz(72 + i), 0.8, params);

  const after = new Float32Array(BLOCK);
  wasm.process(after, BLOCK);

  const boundary = Math.abs(after[0]! - warm[BLOCK - 1]!);
  let step = boundary;
  for (let i = 1; i < BLOCK; i++) step = Math.max(step, Math.abs(after[i]! - after[i - 1]!));

  // 새 음 8개가 들어와 파형이 바뀌므로 여유를 준다. 즉시 리셋이면 이 값이
  // 전체 진폭만큼(수 배) 튀었다
  assert.ok(
    step < baseStep * 6 + 0.05,
    `뺏는 순간 ${step.toFixed(4)} 만큼 튀었다 (평상시 ${baseStep.toFixed(4)})`,
  );
  assert.ok(after.every(Number.isFinite));
});

test('노트오프가 줄을 실제로 죽이고 보이스를 반환한다', async () => {
  // 이게 배선되기 전에는 노트 길이가 소리에 전혀 반영되지 않았다
  const wasm = await engine();
  const params = instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null);

  wasm.allOff();
  const voice = wasm.noteOn(midiToHz(57), 1, params);

  const warm = new Float32Array(BLOCK);
  wasm.process(warm, BLOCK);
  assert.ok(warm.some((v) => Math.abs(v) > 1e-3), '발음 자체가 안 됐다');

  const releaseMs = 50;
  wasm.noteOff(voice, releaseMs);

  // 릴리즈 뒤 충분히 지난 지점을 본다 — **앞쪽은 페이드 램프 자체라 소리가 있다.**
  // 블록 수를 상수로 박으면 BLOCK 이 바뀔 때 조용히 짧아진다 (한 번 헛짚었다)
  const blocks = Math.ceil(((releaseMs / 1000) * FS * 3) / BLOCK);
  const scratch = new Float32Array(BLOCK);
  for (let i = 0; i < blocks; i++) {
    scratch.fill(0);
    wasm.process(scratch, BLOCK);
  }
  let peak = 0;
  for (const v of scratch) peak = Math.max(peak, Math.abs(v));

  assert.ok(peak < 1e-3, `노트오프 뒤에도 ${peak.toFixed(5)} 만큼 울린다`);
  assert.equal(wasm.liveVoices, 0, '보이스를 반환하지 않았다 — 풀이 차면 소리가 끊긴다');
});

test('발음 중 파라미터를 바꿔도 음정이 유지된다 (M1.5 실시간 반영)', async () => {
  // 튜닝 도구는 소리를 내는 중에 파라미터를 돌린다. 그때 루프 계수만 갈아 끼우면
  // 딜레이 길이가 어긋나 음정이 틀어진다 — 현재 주파수로 루프를 다시 계산해야 한다
  const wasm = await engine();
  const base = instrumentParams(resolveInstrument('electric-guitar', registry), 'default', null);
  const hz = midiToHz(57);

  wasm.allOff();
  wasm.noteOn(hz, 1, base);

  const total = Math.round(2 * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    wasm.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
    // 렌더 중간에 강성·감쇠를 계속 움직인다
    if (at % (BLOCK * 40) === 0) {
      const t = at / total;
      wasm.setParamsLive({
        ...base,
        stiffness: 0.004 + t * 0.03,
        damping: 0.02 + t * 0.12,
        scaleLengthMm: 500 + t * 350,
      });
    }
  }

  assert.ok(out.every(Number.isFinite), '파라미터를 흔들자 NaN 이 났다');
  // 파라미터가 흔들리는 동안에도 음정은 그대로여야 한다
  const err = measureCentsError(out.subarray(0, Math.round(0.5 * FS)), hz, FS);
  assert.ok(Math.abs(err) <= TOLERANCE_CENTS, `음정 오차 ${err.toFixed(3)} 센트`);
});

test('발음 중이 아닐 때 파라미터 변경은 아무 일도 하지 않는다', async () => {
  const wasm = await engine();
  const base = instrumentParams(resolveInstrument('harp', registry), 'default', null);
  wasm.allOff();
  wasm.setParamsLive(base); // 울리는 보이스가 없다

  const out = new Float32Array(BLOCK);
  const active = wasm.process(out, BLOCK);
  assert.equal(active, 0);
  assert.ok(out.every((v) => v === 0), '무음이어야 한다');
});

test('발음 중 파라미터를 크게 바꿔도 클릭이 생기지 않는다 (sound.md 6-4)', async () => {
  // 스무딩이 없으면 계수가 한 샘플에서 점프하고 파형에 계단이 생긴다.
  // 그게 클릭이고, 그래서 재생 경로와 튜닝 경로를 나눠 둘 수밖에 없었다.
  const wasm = await engine();
  const base = instrumentParams(resolveInstrument('electric-guitar', registry), 'default', null);
  const hz = midiToHz(57);

  wasm.allOff();
  wasm.noteOn(hz, 1, base);

  const total = Math.round(1.5 * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  const switchAt = Math.round(0.5 * FS);

  for (let at = 0; at < total; at += BLOCK) {
    // 렌더 중간에 파라미터를 극단으로 한 번 바꾼다
    if (at >= switchAt && at < switchAt + BLOCK) {
      wasm.setParamsLive({ ...base, damping: 0.25, stiffness: 0.05, sustainSec: 0.5 });
    }
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    wasm.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
  }

  // 인접 샘플 차이의 최대값을 본다. 계단이 생기면 여기가 튄다
  const maxStep = (from: number, to: number) => {
    let worst = 0;
    for (let i = from + 1; i < to; i++) worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!));
    return worst;
  };

  // 전환 직전 구간을 기준으로 삼는다 (같은 신호의 정상 기울기)
  const before = maxStep(switchAt - Math.round(0.1 * FS), switchAt - 1);
  const across = maxStep(switchAt, switchAt + Math.round(0.02 * FS));

  assert.ok(out.every(Number.isFinite), '파라미터 전환에서 NaN');
  assert.ok(
    across < before * 3,
    `전환 지점 기울기 ${across.toExponential(2)} 가 평시 ${before.toExponential(2)} 의 3배를 넘는다 (클릭)`,
  );
});

test('앰프를 켜도 음정이 크게 밀리지 않는다', async () => {
  // 왜곡은 상호변조로 기본음 근처에 성분을 만들어 측정값을 당긴다.
  // 없앨 수는 없지만(실제 기타도 그렇다) 크기는 묶어 둔다
  const wasm = await engine();
  const lp = resolveInstrument('electric-guitar-lp', registry);
  const params = instrumentParams(lp, 'default', null);

  for (const midi of [40, 52, 64, 76, 88]) {
    const hz = midiToHz(midi);
    const err = measureCentsError(renderWasm(wasm, hz, params, 2), hz, FS);
    assert.ok(Math.abs(err) <= 2, `midi=${midi}: 앰프를 거쳐 ${err.toFixed(3)} 센트 밀렸다`);
  }
});

test('앰프 체인이 실제로 소리를 바꾼다 (M2)', async () => {
  // sound.md 5절: 사용자가 고르는 "클린/크런치/디스토션/퍼즈"는 앰프 단의 파라미터다.
  // 정의에 값을 넣었는데 소리가 안 바뀌면 배선이 끊긴 것이다.
  //
  // **왜곡 정도는 크레스트 팩터(피크/RMS)로 잰다.** 하모닉 비율로 재려다 실패했는데,
  // 심한 클리핑은 사각파에 가까워져 기본음도 같이 커지므로 비율이 오히려 떨어진다.
  // 압축 정도는 왜곡의 양을 단조롭게 반영한다.
  const wasm = await engine();
  const guitar = resolveInstrument('electric-guitar', registry);

  const crestFactor = (params: Record<string, ParamValue>) => {
    const out = renderWasm(wasm, midiToHz(52), params, 1);
    let peak = 0;
    let square = 0;
    for (const v of out) {
      peak = Math.max(peak, Math.abs(v));
      square += v * v;
    }
    assert.ok(out.every(Number.isFinite), '앰프에서 NaN');
    assert.ok(peak > 1e-4, '소리가 안 난다');
    return peak / Math.sqrt(square / out.length);
  };

  let previous = Infinity;
  for (const tone of ['클린', '크런치', '디스토션', '퍼즈']) {
    const crest = crestFactor(instrumentParams(guitar, tone, null));
    assert.ok(
      crest < previous,
      `${tone} 의 크레스트 ${crest.toFixed(2)} 가 이전 ${previous.toFixed(2)} 보다 작지 않다 (왜곡이 안 늘었다)`,
    );
    previous = crest;
  }
  assert.ok(previous < 2, `퍼즈가 충분히 압축되지 않았다: ${previous.toFixed(2)}`);
});

test('앰프가 꺼진 악기는 앰프를 거치지 않는다', async () => {
  // 어쿠스틱 기타에 앰프가 걸리면 소리가 완전히 달라진다
  const wasm = await engine();
  const acoustic = instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null);
  assert.equal(acoustic.ampEnabled, 0);

  wasm.allOff();
  wasm.noteOn(midiToHz(57), 1, acoustic);
  const out = new Float32Array(BLOCK);
  wasm.process(out, BLOCK);
  assert.ok(out.every(Number.isFinite));
  assert.ok(Math.max(...[...out].map(Math.abs)) > 1e-4, '소리가 안 난다');
});

test('블록 상한을 넘기면 조용히 자르지 않고 에러다', async () => {
  const wasm = await engine();
  assert.throws(() => wasm.process(new Float32Array(4096), 4096), /블록이 너무 크다/);
});

// --- 스테레오 배치 · 벨로시티 밝기 (ROADMAP.md S1) -------------------------

/**
 * 좌우를 따로 렌더한다. **엔진을 새로 만들어 쓴다.**
 *
 * 왜: 여진 노이즈가 보이스의 RNG 에서 나오고 그 RNG 는 발음마다 나아간다. 한 엔진으로
 * A 와 B 를 연달아 렌더하면 **파형이 애초에 다른 두 신호**를 비교하게 된다.
 * 실제로 그것 때문에 파워가 1.19배로 나와 멀쩡한 코드가 틀린 것처럼 보였다
 * (`HANDOFF.md`: 측정기를 먼저 검증하라).
 */
async function renderStereo(
  freqHz: number,
  params: Readonly<Record<string, ParamValue>>,
  seconds: number,
  velocity = 1,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const wasm = await engine();
  wasm.noteOn(freqHz, velocity, params);
  const total = Math.round(seconds * FS);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  const scratchL = new Float32Array(BLOCK);
  const scratchR = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratchL.fill(0);
    scratchR.fill(0);
    wasm.processStereo(scratchL, scratchR, frames);
    left.set(scratchL.subarray(0, frames), at);
    right.set(scratchR.subarray(0, frames), at);
  }
  return { left, right };
}

const rms = (x: Float32Array): number =>
  Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / Math.max(1, x.length));

/**
 * 스펙트럼 중심 — "밝기"의 수치다. 높을수록 밝다.
 *
 * **측정기를 먼저 검증한다** (`HANDOFF.md` 교훈). 정답을 아는 사인파로 확인한 뒤
 * 엔진을 재야 무엇이 틀렸는지 알 수 있다.
 */
function spectralCentroid(x: Float32Array, sampleRate: number): number {
  const n = Math.min(x.length, 8192);
  const bins = 256;
  const maxHz = 12000;
  let weighted = 0;
  let total = 0;
  for (let b = 1; b <= bins; b++) {
    const hz = (maxHz * b) / bins;
    const w = (2 * Math.PI * hz) / sampleRate;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      // 해닝 창 — 없으면 양 끝 불연속이 고역 성분으로 새어 들어와 밝기를 부풀린다
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const v = x[i]! * window;
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    const mag = Math.hypot(re, im);
    weighted += hz * mag;
    total += mag;
  }
  return total > 0 ? weighted / total : 0;
}

test('밝기 측정기 자체 검증 — 정답을 아는 신호로 먼저 잰다', () => {
  const tone = (hz: number) => {
    const x = new Float32Array(8192);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / FS);
    return x;
  };
  for (const hz of [1000, 4000, 8000]) {
    const measured = spectralCentroid(tone(hz), FS);
    assert.ok(
      Math.abs(measured - hz) < hz * 0.1,
      `${hz}Hz 사인파의 중심이 ${measured.toFixed(0)}Hz 로 나왔다 — 측정기가 틀렸다`,
    );
  }
});

test('좌우 퍼짐이 0이면 예전과 똑같이 모노다', async () => {
  // **이게 깨지면 이미 맞춰 둔 악기들의 소리가 전부 바뀐다.**
  const guitar = instrumentParams(resolveInstrument('electric-guitar', registry), 'default', null);
  assert.equal(guitar.stereoWidth, 0, '일렉기타는 앰프가 모노라 퍼뜨리지 않는다');

  const { left, right } = await renderStereo(midiToHz(52), guitar, 0.3);
  for (let i = 0; i < left.length; i++) {
    assert.equal(left[i], right[i], `${i}번 샘플에서 좌우가 갈라졌다`);
  }
  assert.ok(rms(left) > 1e-4, '소리가 안 난다');
});

test('퍼짐을 켜면 낮은 음은 왼쪽, 높은 음은 오른쪽에서 크다', async () => {
  const harp = instrumentParams(resolveInstrument('harp', registry), 'default', null);
  assert.ok((harp.stereoWidth as number) > 0, '하프는 퍼짐이 켜져 있어야 한다');

  const low = await renderStereo(midiToHz(36), harp, 0.3);
  const high = await renderStereo(midiToHz(84), harp, 0.3);
  assert.ok(rms(low.left) > rms(low.right) * 1.1, '낮은 음이 왼쪽으로 안 갔다');
  assert.ok(rms(high.right) > rms(high.left) * 1.1, '높은 음이 오른쪽으로 안 갔다');
});

test('퍼짐을 켜도 전체 음량이 유지된다', async () => {
  // 배치를 바꿨다고 곡이 조용해지면 안 된다
  const harp = resolveInstrument('harp', registry);
  const spread = instrumentParams(harp, 'default', null);
  const mono = { ...spread, stereoWidth: 0 };

  const withWidth = await renderStereo(midiToHz(40), spread, 0.3);
  const withoutWidth = await renderStereo(midiToHz(40), mono, 0.3);
  const power = (s: { left: Float32Array; right: Float32Array }) =>
    rms(s.left) ** 2 + rms(s.right) ** 2;
  const ratio = power(withWidth) / power(withoutWidth);
  assert.ok(Math.abs(ratio - 1) < 0.05, `파워가 ${ratio.toFixed(3)}배로 변했다`);
});

test('세게 치면 밝아진다 — 벨로시티가 음량만 바꾸지 않는다', async () => {
  // 이게 없으면 벨로시티 레인이 볼륨 오토메이션으로만 들린다 (ROADMAP.md S1-2)
  const guitar = instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null);
  assert.ok((guitar.velocityBrightness as number) > 0);

  const soft = (await renderStereo(midiToHz(52), guitar, 0.25, 0.2)).left;
  const hard = (await renderStereo(midiToHz(52), guitar, 0.25, 1.0)).left;
  const softCentroid = spectralCentroid(soft, FS);
  const hardCentroid = spectralCentroid(hard, FS);
  assert.ok(
    hardCentroid > softCentroid * 1.05,
    `세게 친 쪽이 더 밝지 않다 (약 ${softCentroid.toFixed(0)}Hz, 강 ${hardCentroid.toFixed(0)}Hz)`,
  );
});

test('세기→밝기를 끄면 음색이 그대로다', async () => {
  // 기본값은 꺼짐이다. 끈 악기는 예전과 같은 소리가 나야 한다
  const base = instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null);
  const off = { ...base, velocityBrightness: 0 };

  const soft = (await renderStereo(midiToHz(52), off, 0.25, 0.3)).left;
  const hard = (await renderStereo(midiToHz(52), off, 0.25, 1.0)).left;
  const ratio = spectralCentroid(hard, FS) / spectralCentroid(soft, FS);
  assert.ok(Math.abs(ratio - 1) < 0.02, `껐는데 밝기가 ${ratio.toFixed(3)}배 달라졌다`);
});

test('험버커가 싱글코일보다 어둡다', async () => {
  // 스트랫과 레스폴의 차이가 줄 길이 20mm 뿐이던 것을 고친 부분 (ROADMAP.md S1-3)
  const strat = instrumentParams(resolveInstrument('electric-guitar', registry), '클린', null);
  const lp = instrumentParams(resolveInstrument('electric-guitar-lp', registry), '클린', null);

  const stratOut = (await renderStereo(midiToHz(52), strat, 0.25)).left;
  const lpOut = (await renderStereo(midiToHz(52), lp, 0.25)).left;
  assert.ok(
    spectralCentroid(lpOut, FS) < spectralCentroid(stratOut, FS),
    '험버커가 더 어둡지 않다 — 코일 공진이 반영되지 않았다',
  );
});

// --- 보이싱을 데이터로 (ROADMAP.md S4 준비) --------------------------------

test('악기마다 몸통 구성이 실제로 다르게 들어간다', async () => {
  // 예전에는 모드 구성이 Rust 상수라 **통이 다른 악기가 같은 통으로 울렸다**.
  // 우쿨렐레는 기타 모드를 위로 옮긴 게 아니라 모드 개수·Q 자체가 다르다
  const guitar = resolveInstrument('acoustic-guitar', registry);
  const ukulele = resolveInstrument('ukulele-soprano', registry);
  assert.ok(guitar.bodyModes.length > 0, '기타에 몸통 구성이 없다');
  assert.notDeepEqual(guitar.bodyModes, ukulele.bodyModes, '두 악기의 통이 같다');
  assert.notDeepEqual(
    guitar.sympatheticSemitones, ukulele.sympatheticSemitones, '조율이 같다',
  );
});

test('몸통 구성을 바꾸면 소리가 바뀐다', async () => {
  const params = {
    ...instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null),
    bodyAmount: 0.8,
  };
  const render = async (modes: readonly { ratio: number; gain: number; q: number }[]) => {
    const wasm = await engine();
    wasm.setBodyModes(modes);
    wasm.noteOn(midiToHz(52), 1, params);
    const out = new Float32Array(BLOCK * 40);
    const scratch = new Float32Array(BLOCK);
    for (let at = 0; at < out.length; at += BLOCK) {
      scratch.fill(0);
      wasm.process(scratch, BLOCK);
      out.set(scratch, at);
    }
    return out;
  };

  const low = await render([{ ratio: 1, gain: 1, q: 12 }]);
  const high = await render([{ ratio: 4, gain: 1, q: 12 }]);
  let differs = 0;
  for (let i = 0; i < low.length; i++) if (low[i] !== high[i]) differs++;
  assert.ok(differs > low.length * 0.5, '모드를 바꿨는데 소리가 그대로다');
});

test('빈 구성을 주면 엔진 기본 모드로 돌아간다', async () => {
  // 조용히 무음이 되면 사용자가 원인을 못 찾는다
  const params = {
    ...instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null),
    bodyAmount: 0.8,
  };
  const wasm = await engine();
  wasm.setBodyModes([]);
  wasm.noteOn(midiToHz(52), 1, params);
  const out = new Float32Array(BLOCK * 20);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < out.length; at += BLOCK) {
    scratch.fill(0);
    wasm.process(scratch, BLOCK);
    out.set(scratch, at);
  }
  assert.ok(Math.max(...[...out].map(Math.abs)) > 1e-4, '빈 구성에서 소리가 사라졌다');
});

test('보이싱 파라미터가 0이면 예전과 같은 소리다', async () => {
  // **호환성 방어선.** 값을 안 준 악기와 옛 프로젝트가 흔들리면 안 된다
  const base = instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null);
  const explicitZero = {
    ...base,
    velocityReference: 0, panCenterHz: 0, panOctaveSpan: 0,
    variationGainDepth: 0, variationBrightDepth: 0, variationDecayDepth: 0,
    detuneRefHz: 0, detuneMinScale: 0, playNoiseMs: 0, playNoiseLevel: 0,
    stealFadeMs: 0, pickupCoilHz: 0, sympatheticT60Sec: 0, sympatheticDamping: 0, bodyMix: 0,
  };
  const render = async (p: Record<string, ParamValue>) => {
    const wasm = await engine();
    wasm.noteOn(midiToHz(52), 0.9, p);
    const out = new Float32Array(BLOCK * 30);
    const scratch = new Float32Array(BLOCK);
    for (let at = 0; at < out.length; at += BLOCK) {
      scratch.fill(0);
      wasm.process(scratch, BLOCK);
      out.set(scratch, at);
    }
    return out;
  };
  const a = await render(base);
  const b = await render(explicitZero);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`샘플 ${i} 가 다르다 — 0 이 기본값으로 안 떨어진다`);
  }
});

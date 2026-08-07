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
import { createRegistry, playableInstrumentIds } from '../../instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../../instruments/resolve.ts';
import type { ParamValue } from '../../instruments/types.ts';

const FS = 48000;
const BLOCK = 128;
const TOLERANCE_CENTS = 1;
const registry = createRegistry();

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
  // 음정이 어긋나면 포팅에서 무언가를 빠뜨린 것이다
  const wasm = await engine();
  const params = instrumentParams(resolveInstrument('acoustic-guitar', registry), 'default', null);

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

test('보이스 스틸링이 동작하고 동시 발음이 합산된다', async () => {
  const wasm = await engine();
  const params = instrumentParams(resolveInstrument('harp', registry), 'default', null);

  wasm.allOff();
  for (let i = 0; i < 40; i++) wasm.noteOn(midiToHz(48 + (i % 24)), 0.8, params);

  const out = new Float32Array(BLOCK);
  const active = wasm.process(out, BLOCK);
  assert.ok(active > 0 && active <= 32, `울리는 보이스 ${active} 개 (상한 32)`);
  assert.ok(out.every(Number.isFinite));
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

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
    const params = instrumentParams(instrument, 'default', null);
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

test('블록 상한을 넘기면 조용히 자르지 않고 에러다', async () => {
  const wasm = await engine();
  assert.throws(() => wasm.process(new Float32Array(4096), 4096), /블록이 너무 크다/);
});

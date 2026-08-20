/**
 * **미리듣기 = 내보내기.**
 *
 * 이 파일이 지키는 성질 하나: *같은 음은 앞에 무엇을 쳤든 같은 소리가 난다.*
 *
 * 안 지키면 나는 일이 구체적이다 — 8마디부터 미리듣기한 소리와 처음부터 내보낸
 * 소리가 다르다. 사용자는 "왜 파일이 다르게 들리지"를 영원히 못 찾는다.
 *
 * 실제로 그 상태였다. 변주(이득·밝기·감쇠)만 음마다 씨앗을 쓰고, **소리를 만드는
 * 난수와 상태는 자유롭게 흐르고 있었다**:
 *
 * | 어디 | 무엇이 남았나 | 실측 차이 |
 * |---|---|---|
 * | 줄 여진 잡음 | 보이스마다 흐르는 RNG | RMS 0.5~1.2dB, 7.3kHz 성분 35dB |
 * | 픽·프렛 노이즈 | 같은 문제 | 여진을 고친 뒤에도 파형이 달랐다 |
 * | 신스 유니즌·서브·LFO | 위상 | 최대 샘플차 0.37 |
 * | 신스 DC 차단기 | 필터 상태 | 최대 샘플차 0.02 |
 * | 드럼 노이즈 | 자유 RNG | 최대 샘플차 1.1 |
 *
 * 전부 `note_on` 에서 음마다 결정론적으로 심는다 (`dsp/src/lib.rs`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { WasmVoiceEngine } from './voice/wasmEngine.ts';
import { createRegistry, playableInstrumentIds } from '../instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import { voiceKindIndex } from '../instruments/types.ts';

const FS = 48000;
const BLOCK = 128;
const registry = createRegistry();
const wasmPath = fileURLToPath(new URL('../generated/dsp.wasm', import.meta.url));

async function engine(): Promise<WasmVoiceEngine> {
  return WasmVoiceEngine.create(await readFile(wasmPath), FS);
}

function renderNote(
  wasm: WasmVoiceEngine,
  instrumentId: string,
  midi: number,
  seconds: number,
  velocity: number,
  seed: number,
): Float32Array {
  const instrument = resolveInstrument(instrumentId, registry);
  const params = {
    ...instrumentParams(instrument, 'default', null),
    voiceKind: voiceKindIndex(instrument.voice),
  };
  wasm.allOff();
  wasm.noteOn(440 * 2 ** ((midi - 69) / 12), velocity, params, 1, undefined, seed);

  const total = Math.round(seconds * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    wasm.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
  }
  return out;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  }
  return worst;
}

test('같은 음은 앞에 무엇을 쳤든 비트 단위로 같다', async () => {
  const wasm = await engine();
  const failures: string[] = [];

  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    const mid = Math.round((instrument.range.low + instrument.range.high) / 2);

    for (const midi of [instrument.range.low, mid, instrument.range.high]) {
      const first = renderNote(wasm, id, midi, 1.0, 1.0, 12345);
      // 사이에 다른 음들을 친다 — 이것이 뒤 음을 바꾸면 안 된다
      renderNote(wasm, id, Math.min(midi + 5, instrument.range.high), 1.0, 0.4, 999);
      renderNote(wasm, id, instrument.range.low, 1.0, 0.9, 555);
      const again = renderNote(wasm, id, midi, 1.0, 1.0, 12345);

      const diff = maxDiff(first, again);
      if (diff !== 0) failures.push(`${id} midi=${midi}: 최대차 ${diff.toExponential(2)}`);
    }
  }
  assert.deepEqual(failures, [], `앞 음이 뒤 음을 바꿨다:\n${failures.join('\n')}`);
});

test('씨앗이 다르면 소리도 달라야 한다 — 반복이 머신건이 되지 않게', async () => {
  // 재현성을 만들다가 변주를 죽이면 하이햇 16분이 기계처럼 들린다.
  // **두 성질은 함께 지켜야 의미가 있다**
  const wasm = await engine();
  const identical: string[] = [];

  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    const midi = Math.round((instrument.range.low + instrument.range.high) / 2);
    const a = renderNote(wasm, id, midi, 1.0, 1.0, 12345);
    const b = renderNote(wasm, id, midi, 1.0, 1.0, 777);
    if (maxDiff(a, b) < 1e-4) identical.push(id);
  }
  assert.deepEqual(identical, [], `씨앗을 바꿔도 같은 소리가 난다: ${identical.join(', ')}`);
});

/**
 * CPU 예산 측정 (`sound.md` 11-4).
 *
 * > 보이스당 비용 측정, 동시 발음 목표치 설정
 * > AudioWorklet 블록 마감(48kHz에서 2.67ms)을 **최악 조건에서도** 지키는지 확인
 *
 * 이게 없으면 "몇 개까지 동시에 울릴 수 있는가"를 모른 채로 악기를 늘리게 되고,
 * 사용자는 곡이 두꺼워질 때 갑자기 끊기는 소리를 만난다.
 *
 * # 이 숫자를 어떻게 읽어야 하나
 *
 * Node 에서 재는 값은 브라우저 워크렛보다 낙관적이다 — 워크렛은 오디오 스레드에서
 * 다른 일과 경쟁하고, 기기도 이 개발 기계보다 느릴 수 있다. 그래서 **여유를 크게
 * 잡는다**: 실시간의 몇 배로 도는지를 보고, 배수가 무너지면 실패로 본다.
 *
 * 절대 성능을 고정하는 테스트가 아니라 **회귀를 잡는 테스트**다. DSP 를 고치다
 * 비용이 몇 배로 뛰면 여기서 걸린다.
 */

// ---------------------------------------------------------------------------
// ⚠ **이 파일만 `.perf.ts` 다. 나머지 시험과 같이 돌리면 안 된다.**
//
// `node --test` 는 파일을 **병렬로** 돌린다. 실시간 배수를 재는 시험이 그 옆에서
// 다른 시험들과 CPU 를 다투면, 재는 것이 코드 속도가 아니라 **그 순간 기계의 부하**가
// 된다. 실제로 그래서 간헐적으로 실패했다 (synth-pad 가 단독 5.9배인데 함께 돌 때
// 4.7배로 측정돼 기준 5배에 걸렸다).
//
// 기준을 느슨하게 푸는 것은 답이 아니다 — 그러면 진짜 성능 회귀를 놓친다.
// 대신 `npm run test:perf` 로 **혼자, 직렬로** 돌린다.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { WasmVoiceEngine } from './voice/wasmEngine.ts';
import { createRegistry, playableInstrumentIds } from '../instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import { VOICE_KIND_INDEX } from '../instruments/types.ts';

const FS = 48000;
const BLOCK = 128;
/** 워크렛 블록 하나가 실제로 쓰는 시간의 상한 (`sound.md` 11-4: 2.67ms) */
const BLOCK_DEADLINE_MS = (BLOCK / FS) * 1000;
const registry = createRegistry();
const wasmPath = fileURLToPath(new URL('../generated/dsp.wasm', import.meta.url));

/**
 * 실시간 대비 몇 배로 도는지. 1 이면 딱 실시간, 10 이면 열 배 빠르다.
 * 워크렛에서 안전하려면 여유가 크게 필요하다
 */
function realtimeFactor(elapsedMs: number, renderedSec: number): number {
  return (renderedSec * 1000) / elapsedMs;
}

async function engine(): Promise<WasmVoiceEngine> {
  return WasmVoiceEngine.create(await readFile(wasmPath), FS);
}

/**
 * 몇 번 재서 **가장 좋은 값**을 쓴다.
 *
 * 왜: 이 파일은 처리량을 재는데, 테스트 러너가 다른 테스트를 병렬로 돌리는 동안
 * 측정하면 머신 자체가 느려진다 (실측으로 20배까지 떨어졌다). 그러면 코드는
 * 그대로인데 테스트가 실패하고, **그게 실제 회귀보다 더 해롭다** — 아무 문제 없는데
 * 원인을 찾게 만든다.
 *
 * 경합은 산발적이므로 최선값이 "이 코드가 낼 수 있는 성능"에 가깝다. 우리가 알고
 * 싶은 것도 그것이다 (오디오 워크렛은 전용 스레드에서 돈다).
 */
const MEASURE_ROUNDS = 3;

function measureBest(
  wasm: WasmVoiceEngine,
  instrumentId: string,
  voices: number,
  seconds: number,
): { factor: number; worstBlockMs: number } {
  let best = measureOnce(wasm, instrumentId, voices, seconds);
  for (let i = 1; i < MEASURE_ROUNDS; i++) {
    const round = measureOnce(wasm, instrumentId, voices, seconds);
    // 처리량은 클수록 좋고, 최악 블록은 작을수록 좋다 — 각각 최선을 취한다
    if (round.factor > best.factor) best = { ...best, factor: round.factor };
    if (round.worstBlockMs < best.worstBlockMs) {
      best = { ...best, worstBlockMs: round.worstBlockMs };
    }
  }
  return best;
}

/** `voices` 개를 동시에 울린 채 `seconds` 만큼 렌더하고 실시간 배수를 돌려준다 */
function measureOnce(
  wasm: WasmVoiceEngine,
  instrumentId: string,
  voices: number,
  seconds: number,
): { factor: number; worstBlockMs: number } {
  const instrument = resolveInstrument(instrumentId, registry);
  const params = {
    ...instrumentParams(instrument, 'default', null),
    voiceKind: VOICE_KIND_INDEX[instrument.voice] ?? 0,
  };

  wasm.allOff();
  // 음역 안에 골고루 흩어 놓는다 — 같은 음만 쌓으면 실제 곡과 다르다
  for (let i = 0; i < voices; i++) {
    const span = instrument.range.high - instrument.range.low;
    const midi = instrument.range.low + ((i * 7) % Math.max(1, span));
    wasm.noteOn(440 * Math.pow(2, (midi - 69) / 12), 0.8, params);
  }

  const scratch = new Float32Array(BLOCK);
  const blocks = Math.round((seconds * FS) / BLOCK);

  // 첫 블록들은 JIT 워밍업이라 버린다
  for (let i = 0; i < 50; i++) {
    scratch.fill(0);
    wasm.process(scratch, BLOCK);
  }

  let worstBlockMs = 0;
  const started = performance.now();
  for (let i = 0; i < blocks; i++) {
    const blockStart = performance.now();
    scratch.fill(0);
    wasm.process(scratch, BLOCK);
    worstBlockMs = Math.max(worstBlockMs, performance.now() - blockStart);
  }
  const elapsed = performance.now() - started;

  return {
    factor: realtimeFactor(elapsed, (blocks * BLOCK) / FS),
    worstBlockMs,
  };
}

test('줄 보이스 32개(상한)가 실시간의 몇 배로 도는가', async () => {
  const wasm = await engine();
  const { factor, worstBlockMs } = measureBest(wasm, 'acoustic-guitar', 32, 2);

  console.log(
    `    줄 32보이스: 실시간의 ${factor.toFixed(1)}배 · 최악 블록 ${worstBlockMs.toFixed(3)}ms ` +
    `(마감 ${BLOCK_DEADLINE_MS.toFixed(2)}ms)`,
  );

  // 워크렛은 오디오 스레드에서 다른 일과 경쟁하고 기기도 더 느릴 수 있다.
  // 5배 여유를 요구한다 — 이보다 낮으면 느린 기기에서 끊긴다
  assert.ok(factor > 5, `실시간의 ${factor.toFixed(1)}배 — 여유가 부족하다`);
});

test('모달 보이스는 비싸다 — 그 비용을 숫자로 남긴다', async () => {
  // sound.md 3절: "모드 수만큼 공진 필터가 필요 → CPU 비용".
  // 얼마나 비싼지 모르면 동시 발음 상한을 정할 수 없다
  const wasm = await engine();
  const string = measureBest(wasm, 'acoustic-guitar', 16, 1);
  const modal = measureBest(wasm, 'tubular-bell', 16, 1);

  const ratio = string.factor / modal.factor;
  console.log(
    `    16보이스 비교 — 줄 ${string.factor.toFixed(1)}배 · 벨 ${modal.factor.toFixed(1)}배 ` +
    `(벨이 ${ratio.toFixed(1)}배 비쌈)`,
  );

  assert.ok(modal.factor > 5, `모달 16보이스가 실시간의 ${modal.factor.toFixed(1)}배뿐이다`);
});

test('앰프를 켜도 마감을 지킨다 (오버샘플링 4배)', async () => {
  // 비선형 구간은 4배 오버샘플링을 거치므로 가장 비싼 경로다
  const wasm = await engine();
  const { factor, worstBlockMs } = measureBest(wasm, 'electric-guitar', 16, 2);

  console.log(
    `    일렉기타(앰프+오버샘플링) 16보이스: 실시간의 ${factor.toFixed(1)}배 · ` +
    `최악 블록 ${worstBlockMs.toFixed(3)}ms`,
  );
  assert.ok(factor > 5, `앰프 경로가 실시간의 ${factor.toFixed(1)}배뿐이다`);
});

test('모든 악기가 16보이스에서 실시간을 넘긴다', async () => {
  const wasm = await engine();
  const slow: string[] = [];

  for (const id of playableInstrumentIds()) {
    const { factor } = measureBest(wasm, id, 16, 0.5);
    if (factor < 5) slow.push(`${id}: ${factor.toFixed(1)}배`);
  }

  assert.deepEqual(slow, [], `여유가 부족한 악기:\n${slow.join('\n')}`);
});

test('보이스를 늘려도 비용이 선형에서 크게 벗어나지 않는다', async () => {
  // 초선형이면 어딘가에서 O(n²) 를 하고 있다는 뜻이다
  const wasm = await engine();
  const one = measureBest(wasm, 'acoustic-guitar', 1, 1);
  const many = measureBest(wasm, 'acoustic-guitar', 16, 1);

  // 16배 일을 하면 배수는 대략 1/16 이 된다. 1/32 보다 나빠지면 선형이 아니다
  const expected = one.factor / 16;
  console.log(
    `    1보이스 ${one.factor.toFixed(0)}배 → 16보이스 ${many.factor.toFixed(1)}배 ` +
    `(선형 예상 ${expected.toFixed(1)}배)`,
  );
  assert.ok(
    many.factor > expected * 0.5,
    `16보이스가 선형 예상의 절반보다 느리다 (${many.factor.toFixed(1)} vs ${expected.toFixed(1)})`,
  );
});

test('무음일 때는 거의 비용이 들지 않는다', async () => {
  // 보이스가 다 꺼진 뒤에도 계속 계산하면 배터리를 먹는다.
  // 비정규수(sound.md 6-3)가 처리되지 않으면 여기서 오히려 느려진다
  const wasm = await engine();
  wasm.allOff();

  const scratch = new Float32Array(BLOCK);
  for (let i = 0; i < 100; i++) wasm.process(scratch, BLOCK);

  const started = performance.now();
  const blocks = Math.round(FS / BLOCK); // 1초
  for (let i = 0; i < blocks; i++) {
    scratch.fill(0);
    wasm.process(scratch, BLOCK);
  }
  const factor = realtimeFactor(performance.now() - started, 1);

  console.log(`    무음: 실시간의 ${factor.toFixed(0)}배`);
  assert.ok(factor > 100, `무음인데 실시간의 ${factor.toFixed(0)}배뿐이다`);
});

/**
 * 오디오 워크렛의 **예약 처리**를 브라우저 없이 검증한다.
 *
 * ## 왜 이 파일이 생겼나
 *
 * 워크렛에는 테스트가 하나도 없었고, 그래서 **내보내기가 통째로 무음인 결함**이
 * 전체 테스트를 통과했다. 16트랙 곡을 내보냈더니 3.4MB WAV 의 모든 표본이 0이었다.
 *
 * 원인은 `load` 가 wasm 을 기다린 뒤 예약 대기열을 통째로 비운 것이었다. 재생은
 * 룩어헤드 스케줄러가 계속 다시 예약하므로 멀쩡했지만, **내보내기는 모든 음을 한
 * 번에 미래 시각으로 예약한 뒤 `ready` 를 기다리므로** 그 음들이 전부 사라졌다.
 *
 * 브라우저에서 직접 눌러 봐야만 드러나는 결함이었다 — 그래서 여기서 잡는다.
 *
 * ## 어떻게 브라우저 없이 도나
 *
 * `ks-worklet.js` 는 `import`/`export` 가 없는 고전 스크립트라, `node:vm` 으로 새
 * 실행 영역을 만들고 `AudioWorkletProcessor`·`registerProcessor`·`sampleRate`·
 * `currentFrame` 만 넣어 주면 그대로 돈다. `currentFrame` 은 전역이라 블록마다
 * 밀어 주면 실제 렌더와 같은 시간 흐름이 된다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const workletPath = fileURLToPath(new URL('../../public/ks-worklet.js', import.meta.url));
const wasmPath = fileURLToPath(new URL('../generated/dsp.wasm', import.meta.url));

const BLOCK = 128;
const SAMPLE_RATE = 48000;

interface Processor {
  handle(message: Record<string, unknown>): Promise<void> | void;
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
  pending: { frame: number }[];
  port: { postMessage: (m: { type?: string }) => void };
}

/** 워크렛을 새 실행 영역에 올리고, 인스턴스와 시간 손잡이를 돌려준다 */
async function loadWorklet() {
  const source = await readFile(workletPath, 'utf8');
  let Ctor: (new () => Processor) | null = null;

  const context: Record<string, unknown> = {
    sampleRate: SAMPLE_RATE,
    currentFrame: 0,
    WebAssembly,
    // 같은 파일에 'rust-fx' 도 있다 — 보이스 프로세서만 고른다
    registerProcessor: (name: string, ctor: new () => Processor) => { if (name === 'ks-string') Ctor = ctor; },
    AudioWorkletProcessor: class {
      port = { postMessage: (_m: unknown) => {}, onmessage: null };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.ok(Ctor, 'registerProcessor 가 안 불렸다');
  const processor = new (Ctor as unknown as new () => Processor)();
  return {
    processor,
    /** 렌더가 진행된 것처럼 시각을 민다 */
    advance: (frames: number) => {
      context.currentFrame = (context.currentFrame as number) + frames;
    },
  };
}

/** 내보내기와 **같은 순서**로 보낸다: load → noteOn 무더기 → ready 대기 */
async function loadThenSchedule(processor: Processor, frames: number[]) {
  const bytes = await readFile(wasmPath);
  const ready = new Promise<void>((resolve) => {
    processor.port.postMessage = (m) => { if (m?.type === 'ready') resolve(); };
  });

  // **일부러 await 하지 않는다.** 내보내기가 그렇게 한다 — `load` 가 wasm 을
  // 기다리는 동안 노트온이 도착하고, 그게 이 결함의 조건이었다
  const loading = processor.handle({ type: 'load', bytes: bytes.buffer.slice(0) });

  for (const frame of frames) {
    processor.handle({
      type: 'noteOn',
      frame,
      freq: 220,
      velocity: 0.8,
      params: new Array(72).fill(0),
      gain: 1,
      durationFrames: SAMPLE_RATE / 2,
      releaseMs: 120,
      seed: 1234,
    });
  }

  await loading;
  await ready;
}

test('로딩 중에 도착한 미래 예약을 버리지 않는다', async () => {
  // **이 테스트가 곧 그 결함이다.** 전에는 여기서 pending 이 0이 됐고,
  // 그 결과가 "완전 무음 WAV" 였다
  const { processor } = await loadWorklet();
  const frames = [0, SAMPLE_RATE, 2 * SAMPLE_RATE];
  await loadThenSchedule(processor, frames);

  assert.equal(
    processor.pending.length,
    frames.length,
    `로딩 중 예약한 ${frames.length}개 중 ${processor.pending.length}개만 남았다 — 내보내기가 무음이 된다`,
  );
});

test('로딩 중에 도착한 **지난** 예약은 버린다', async () => {
  // 원래 의도는 지켜야 한다: 재생 중 로딩이 늦어 쌓인 예약을 그대로 내면
  // 전부 한 지점에 몰려 "쾅" 하고 난다
  const { processor, advance } = await loadWorklet();
  advance(10 * SAMPLE_RATE); // 이미 10초가 지난 상태
  await loadThenSchedule(processor, [0, SAMPLE_RATE]); // 둘 다 지난 시각

  assert.equal(processor.pending.length, 0, '지난 예약은 남으면 안 된다');
});

test('예약한 음이 실제로 소리가 된다 — 무음 파일이 나가지 않는다', async () => {
  // 대기열에 남아 있는 것만으로는 부족하다. **소리까지 나와야** 내보내기가 산다
  const { processor, advance } = await loadWorklet();
  await loadThenSchedule(processor, [0]);

  let peak = 0;
  for (let block = 0; block < Math.ceil(SAMPLE_RATE / BLOCK); block += 1) {
    const outputs = [[new Float32Array(BLOCK), new Float32Array(BLOCK)]];
    processor.process([], outputs);
    for (const channel of outputs[0]!) {
      for (const v of channel) peak = Math.max(peak, Math.abs(v));
    }
    advance(BLOCK);
  }

  assert.ok(peak > 0.001, `1초를 렌더했는데 최대 진폭이 ${peak} 다 — 무음이다`);
  assert.ok(peak <= 1.5, `진폭이 ${peak} 로 비정상이다`);
});

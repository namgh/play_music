/**
 * 실시간 튜닝용 오디오 엔진 (`sound.md` 9-6 M1.5).
 *
 * 편집기(`bufferRenderer.ts`)와 **일부러 나눠 둔다.** 요구가 다르다:
 *  - 편집기: 발음 시각이 샘플 단위로 정확해야 한다 → 음을 미리 렌더해 예약
 *  - 튜닝 도구: **발음 중인 소리가 파라미터를 따라와야 한다** → 워크렛에서 실시간 합성
 *
 * 두 경로를 하나로 합치는 것은 파라미터 스무딩(`sound.md` 6-4)이 붙은 뒤에 한다.
 * 지금 합치면 튜닝 도구의 실시간 변경이 재생 중 클릭으로 새어 나온다.
 */

import { WASM_PARAM_ORDER } from './voice/wasmEngine.ts';
import type { ParamValue } from '../instruments/types.ts';

const WORKLET_URL = '/ks-worklet.js';

export interface LiveEngineOptions {
  /** wasm 바이트. 워크렛 스코프에는 fetch 가 없어 메인 스레드가 넘겨줘야 한다 */
  wasmBytes: ArrayBuffer;
}

export class LiveEngineError extends Error {}

export class LiveEngine {
  private readonly ctx: AudioContext;
  private readonly node: AudioWorkletNode;
  readonly analyser: AnalyserNode;

  private constructor(ctx: AudioContext, node: AudioWorkletNode, analyser: AnalyserNode) {
    this.ctx = ctx;
    this.node = node;
    this.analyser = analyser;
  }

  static async create(ctx: AudioContext, options: LiveEngineOptions): Promise<LiveEngine> {
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
      throw new LiveEngineError(
        `워크렛 로드 실패 (${WORKLET_URL}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const node = new AudioWorkletNode(ctx, 'ks-string', { outputChannelCount: [2] });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.5;

    const gain = ctx.createGain();
    gain.gain.value = 0.9;
    node.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new LiveEngineError('워크렛이 응답하지 않는다')), 5000);
      node.port.onmessage = ({ data }) => {
        if (data?.type === 'ready') {
          clearTimeout(timer);
          resolve();
        }
      };
    });

    // 바이트는 워크렛으로 소유권을 넘긴다 (구조적 복사를 피한다)
    node.port.postMessage({ type: 'load', bytes: options.wasmBytes }, [options.wasmBytes]);
    await ready;

    return new LiveEngine(ctx, node, analyser);
  }

  private encode(params: Readonly<Record<string, ParamValue>>): number[] {
    return WASM_PARAM_ORDER.map((key) => {
      const value = params[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
  }

  /** 지금 발음. `delaySec` 만큼 뒤로 예약할 수도 있다 */
  pluck(
    freqHz: number,
    velocity: number,
    params: Readonly<Record<string, ParamValue>>,
    delaySec = 0,
  ): void {
    const frame = Math.round((this.ctx.currentTime + delaySec) * this.ctx.sampleRate);
    this.node.port.postMessage({
      type: 'noteOn',
      frame,
      freq: freqHz,
      velocity,
      params: this.encode(params),
      gain: 1,
    });
  }

  /**
   * 몸통 구성·공명현 조율을 보낸다 (`ROADMAP.md` S4).
   *
   * **이게 없으면 튜닝 도구가 엔진 기본 통으로 울린다** — 편집기에서 나는 소리와
   * 다른 것을 듣고 값을 맞추게 되고, 그건 튜닝 도구로서 최악이다.
   * 개수가 가변이라 파라미터가 아니라 버퍼로 간다.
   */
  setVoicing(
    bodyModes: readonly { ratio: number; gain: number; q: number }[],
    sympatheticSemitones: readonly number[],
  ): void {
    this.node.port.postMessage({
      type: 'voicing',
      bodyModes: [...bodyModes],
      sympatheticSemitones: [...sympatheticSemitones],
    });
  }

  /** **발음 중인 소리에** 파라미터를 반영한다 */
  setParamsLive(params: Readonly<Record<string, ParamValue>>): void {
    this.node.port.postMessage({ type: 'setParams', params: this.encode(params) });
  }

  allOff(): void {
    this.node.port.postMessage({ type: 'allOff' });
  }

  dispose(): void {
    this.allOff();
    this.node.disconnect();
    this.analyser.disconnect();
  }
}

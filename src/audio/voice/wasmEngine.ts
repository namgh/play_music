/**
 * Rust DSP 코어 바인딩 (`sound.md` 10절 M1).
 *
 * wasm-bindgen 글루가 없다. 숫자와 선형 메모리만 오가므로 브라우저·Node·나중의
 * 서버가 **같은 `.wasm` 을 그대로** 쓴다. 바이트를 어디서 읽어오는지는 호출자 몫이라
 * (브라우저는 fetch, Node 는 fs) 이 파일은 환경에 의존하지 않는다.
 *
 * 왜 Rust 인가: JS 가 느려서가 아니라 **GC 정지가 오디오 끊김을 만들기 때문**이고,
 * 같은 코드를 서버에서도 돌려 재현성을 확보하기 때문이다 (`plan.md` 5-2).
 */

import type { ParamValue } from '../../instruments/types.ts';

/** Rust 쪽 `PARAM_COUNT` 와 순서가 같아야 한다 */
export const WASM_PARAM_ORDER = [
  'scaleLengthMm',
  'stiffness',
  'damping',
  'sustainSec',
  'pluckPosition',
  'pluckHardness',
] as const;

const MAX_BLOCK = 2048;

interface WasmExports {
  memory: WebAssembly.Memory;
  init(sampleRate: number): void;
  param_buffer(): number;
  output_buffer(): number;
  note_on(freqHz: number, velocity: number, gain: number): number;
  set_params_live(voice: number): void;
  note_off(voice: number): void;
  all_off(): void;
  process(frames: number): number;
  voice_line_delay(voice: number): number;
  voice_loop_gain(voice: number): number;
  sample_rate(): number;
}

export class WasmEngineError extends Error {}

/**
 * Rust 보이스 풀. 보이스 관리가 wasm 안에 있으므로 JS 쪽은 발음 요청만 보낸다.
 * 오디오 경로에서 JS 가 메모리를 할당하지 않는다 — 할당자가 지연을 튀게 만든다.
 */
export class WasmVoiceEngine {
  private readonly exports: WasmExports;
  private viewBuffer: ArrayBuffer | null = null;
  private paramView!: Float32Array;
  private outputView!: Float32Array;

  readonly sampleRate: number;

  private constructor(exports: WasmExports) {
    this.exports = exports;
    this.sampleRate = exports.sample_rate();
    this.refreshViews();
  }

  /**
   * wasm 메모리가 자라면 기존 `ArrayBuffer` 가 detach 되고, 그 위에 만든 타입 배열은
   * **조용히 쓸 수 없게 된다** (읽으면 undefined 가 나와 NaN 으로 번진다).
   * Rust 쪽에서 오디오 경로의 할당을 없앴지만, 뷰를 캐시하는 쪽도 방어해 둔다.
   */
  private refreshViews(): void {
    const buffer = this.exports.memory.buffer;
    if (buffer === this.viewBuffer) return;
    this.viewBuffer = buffer;
    this.paramView = new Float32Array(buffer, this.exports.param_buffer(), WASM_PARAM_ORDER.length);
    this.outputView = new Float32Array(buffer, this.exports.output_buffer(), MAX_BLOCK);
  }

  static async create(bytes: BufferSource, sampleRate: number): Promise<WasmVoiceEngine> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports as unknown as WasmExports;
    for (const name of ['init', 'note_on', 'process', 'param_buffer', 'output_buffer'] as const) {
      if (typeof exports[name] !== 'function') {
        throw new WasmEngineError(`wasm 에 ${name} 이 없다 — 빌드가 오래됐을 수 있다`);
      }
    }
    exports.init(sampleRate);
    return new WasmVoiceEngine(exports);
  }

  /** 발음. 반환값은 쓰인 보이스 번호 */
  noteOn(
    freqHz: number,
    velocity: number,
    params: Readonly<Record<string, ParamValue>>,
    gain = 1,
  ): number {
    this.refreshViews();
    WASM_PARAM_ORDER.forEach((key, i) => {
      const value = params[key];
      this.paramView[i] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
    const voice = this.exports.note_on(freqHz, velocity, gain);
    this.refreshViews(); // note_on 안에서 자랐을 수 있다
    return voice;
  }

  /**
   * **발음 중인 보이스에** 파라미터를 반영한다 (`sound.md` 9-6 튜닝 도구).
   * 현재 주파수로 루프를 다시 계산하므로 음정은 유지된다. 단 큰 폭으로 움직이면
   * 클릭이 난다 — 파라미터 스무딩(`sound.md` 6-4)은 아직 없다.
   */
  setParamsLive(params: Readonly<Record<string, ParamValue>>, voice = 0xffffffff): void {
    this.refreshViews();
    WASM_PARAM_ORDER.forEach((key, i) => {
      const value = params[key];
      this.paramView[i] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
    this.exports.set_params_live(voice);
    this.refreshViews();
  }

  noteOff(voice: number): void {
    this.exports.note_off(voice);
  }

  allOff(): void {
    this.exports.all_off();
  }

  /**
   * 한 블록 렌더해서 `out` 에 **더한다**. 반환값은 아직 울리는 보이스 수.
   * 블록은 최대 2048 프레임이다 — 넘으면 호출자가 쪼개야 한다.
   */
  process(out: Float32Array, frames: number): number {
    if (frames > MAX_BLOCK) throw new WasmEngineError(`블록이 너무 크다: ${frames} > ${MAX_BLOCK}`);
    const active = this.exports.process(frames);
    this.refreshViews();
    for (let i = 0; i < frames; i++) out[i] = out[i]! + this.outputView[i]!;
    return active;
  }

  /** 검증·표시용 — 실제로 쓰인 루프 딜레이(샘플)와 루프 이득 */
  inspect(voice: number): { lineDelay: number; loopGain: number } {
    return {
      lineDelay: this.exports.voice_line_delay(voice),
      loopGain: this.exports.voice_loop_gain(voice),
    };
  }
}

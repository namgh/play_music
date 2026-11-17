/**
 * fx.wasm 을 워크렛 없이 돌리는 호스트 — 워크렛(`public/ks-worklet.js` 'rust-fx')과 **같은 순서**로
 * ABI 를 부른다. Node 테스트·측정과, 나중에 서버/버퍼 렌더러가 쓴다.
 */

import { RUST_EFFECT_SPECS, RUST_KIND, RUST_PARAM_SLOTS } from './rustEffects.ts';
import type { RustEffectType } from './rustEffects.ts';
import { rustParamValues } from './fxRuntime.ts';

interface FxExports {
  memory: WebAssembly.Memory;
  fx_params(): number;
  fx_in_l(): number;
  fx_in_r(): number;
  fx_meters(): number;
  fx_create(kind: number, sampleRate: number): number;
  fx_process(frames: number): void;
  fx_kind_count(): number;
  fx_kind_name(kind: number): number;
  fx_kind_name_len(kind: number): number;
}

const BLOCK = 128;

export class FxWasm {
  readonly latency: number;
  private readonly fx: FxExports;

  private constructor(fx: FxExports, latency: number) {
    this.fx = fx;
    this.latency = latency;
  }

  static async kindNames(module: WebAssembly.Module): Promise<string[]> {
    const fx = (await WebAssembly.instantiate(module, {})).exports as unknown as FxExports;
    const names: string[] = [];
    for (let k = 0; k < fx.fx_kind_count(); k++) {
      const bytes = new Uint8Array(fx.memory.buffer, fx.fx_kind_name(k), fx.fx_kind_name_len(k));
      names.push(new TextDecoder().decode(bytes));
    }
    return names;
  }

  static async create(module: WebAssembly.Module, type: RustEffectType, params: Record<string, number>, sampleRate: number): Promise<FxWasm> {
    const fx = (await WebAssembly.instantiate(module, {})).exports as unknown as FxExports;
    // 주소를 먼저 — 첫 호출이 메모리를 키우면 먼저 잡은 버퍼가 떨어져 나간다 (워크렛과 같은 함정)
    const at = fx.fx_params();
    new Float32Array(fx.memory.buffer, at, RUST_PARAM_SLOTS).set(rustParamValues(type, params));
    const latency = fx.fx_create(RUST_KIND[type], sampleRate);
    if (latency < 0) throw new Error(`fx.wasm 이 ${type} 를 모른다`);
    return new FxWasm(fx, latency);
  }

  /** 파라미터를 바꾼다 (다음 블록부터) */
  setParams(type: RustEffectType, params: Record<string, number>): void {
    const at = this.fx.fx_params();
    new Float32Array(this.fx.memory.buffer, at, RUST_PARAM_SLOTS).set(rustParamValues(type, params));
  }

  /** 스테레오를 128 블록으로 나눠 처리한 새 배열 */
  process(left: Float32Array, right: Float32Array): [Float32Array, Float32Array] {
    const outL = new Float32Array(left.length);
    const outR = new Float32Array(right.length);
    for (let at = 0; at < left.length; at += BLOCK) {
      const n = Math.min(BLOCK, left.length - at);
      const [pl, pr] = [this.fx.fx_in_l(), this.fx.fx_in_r()];
      const mem = this.fx.memory.buffer;
      new Float32Array(mem, pl, n).set(left.subarray(at, at + n));
      new Float32Array(mem, pr, n).set(right.subarray(at, at + n));
      this.fx.fx_process(n);
      const after = this.fx.memory.buffer;
      outL.set(new Float32Array(after, pl, n), at);
      outR.set(new Float32Array(after, pr, n), at);
    }
    return [outL, outR];
  }

  meters(): number[] {
    const at = this.fx.fx_meters();
    return Array.from(new Float32Array(this.fx.memory.buffer, at, 16));
  }
}

export function declaredLatency(type: RustEffectType): number {
  return (RUST_EFFECT_SPECS[type] as { latency?: number }).latency ?? 0;
}

/**
 * Rust 이펙트 실행 준비 (`EFFECTS_PLAN.md` 2절).
 *
 * - fx.wasm 바이트는 앱이 한 번 받아 `setFxBytes` 로 넘긴다 (Vite `?url` 은 Node 테스트에서 못 쓰므로
 *   이 파일은 URL 을 모른다).
 * - 컨텍스트마다 워크렛 모듈(`ks-worklet.js`, 'rust-fx' 프로세서 포함)을 올린 뒤 `markWorkletContext`.
 * - 바이트는 **컨텍스트당 첫 노드에만** 싣는다 — 워크렛이 컴파일한 모듈을 전역에 캐시한다.
 *
 * 워크렛이 없는 컨텍스트(버퍼 렌더러 예비 경로)에서는 노드를 만들지 않는다 → 통과. 한계로 문서에 적었다.
 */

import { RUST_EFFECT_SPECS, RUST_KIND, RUST_PARAM_SLOTS } from './rustEffects.ts';
import type { RustEffectType } from './rustEffects.ts';

let fxBytes: ArrayBuffer | null = null;

/** 컨텍스트마다 곡 0 초가 놓인 프레임과 템포 — 박자에 맞추는 이펙트용 */
interface Transport { anchor: number; bpm: number }
const transports = new WeakMap<BaseAudioContext, Transport>();
const liveNodes = new WeakMap<BaseAudioContext, Set<AudioWorkletNode>>();

/**
 * 재생 시작(곡 위치 기준 프레임)·템포가 바뀌면 부른다. 이미 있는 Rust 노드에 모두 알리고,
 * 새로 만드는 노드는 이 값으로 시작한다. 내보내기는 곡 0 초 = 프레임 0 이라 anchor 0.
 */
export function setTransport(ctx: BaseAudioContext, patch: Partial<Transport>): void {
  const next = { ...(transports.get(ctx) ?? { anchor: 0, bpm: 120 }), ...patch };
  transports.set(ctx, next);
  for (const node of liveNodes.get(ctx) ?? []) node.port.postMessage({ type: 'transport', ...next });
}
/** 몇 개를 실제 노드로 만들었고 몇 개가 통과로 떨어졌나 — 브라우저 점검이 본다 */
export const rustFxStats = { created: 0, passthrough: 0 };
(globalThis as { __rustFx?: typeof rustFxStats }).__rustFx = rustFxStats;
const workletContexts = new WeakSet<BaseAudioContext>();
const bytesSent = new WeakSet<BaseAudioContext>();

export function setFxBytes(bytes: ArrayBuffer | null): void {
  fxBytes = bytes;
}

export function markWorkletContext(ctx: BaseAudioContext): void {
  workletContexts.add(ctx);
}

export function rustFxAvailable(ctx: BaseAudioContext): boolean {
  return fxBytes !== null && workletContexts.has(ctx);
}

/** 선언 순서대로 p0… 에 들어갈 값 */
export function rustParamValues(type: RustEffectType, params: Record<string, number>): number[] {
  const values = new Array<number>(RUST_PARAM_SLOTS).fill(0);
  Object.keys(RUST_EFFECT_SPECS[type].params).forEach((key, i) => { values[i] = params[key] ?? 0; });
  return values;
}

export interface RustFxNode {
  node: AudioWorkletNode;
  /** 선언 순서 키 → AudioParam */
  params: Record<string, AudioParam>;
  latency: number;
  /** 가장 최근 미터 값 (미터가 없는 이펙트는 비어 있다) */
  meters: Float32Array;
  dispose(): void;
}

export function createRustFxNode(ctx: BaseAudioContext, type: RustEffectType, params: Record<string, number>): RustFxNode | null {
  if (!rustFxAvailable(ctx)) { rustFxStats.passthrough++; return null; }
  rustFxStats.created++;
  const decl = RUST_EFFECT_SPECS[type] as { latency?: number; meters?: unknown[] };
  const values = rustParamValues(type, params);
  const parameterData: Record<string, number> = {};
  values.forEach((v, i) => { parameterData[`p${i}`] = v; });
  const first = !bytesSent.has(ctx);
  const node = new AudioWorkletNode(ctx, 'rust-fx', {
    // 둘째 입력 = 사이드체인 감지 (이어져 있지 않으면 Rust 가 자기 소리로 감지)
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    parameterData,
    processorOptions: {
      kind: RUST_KIND[type],
      params: values,
      latency: decl.latency ?? 0,
      meters: (decl.meters?.length ?? 0) > 0,
      ...(transports.get(ctx) ?? { anchor: 0, bpm: 120 }),
      ...(first ? { bytes: fxBytes!.slice(0) } : {}),
    },
  });
  bytesSent.add(ctx);
  let live = liveNodes.get(ctx);
  if (!live) liveNodes.set(ctx, (live = new Set()));
  live.add(node);
  const meters = new Float32Array(16);
  node.port.onmessage = (event: MessageEvent<{ type: string; values?: number[]; message?: string }>) => {
    if (event.data.type === 'meters' && event.data.values) meters.set(event.data.values);
    else if (event.data.type === 'error') console.error(`Rust 이펙트 ${type}: ${event.data.message}`);
  };
  const map: Record<string, AudioParam> = {};
  Object.keys(RUST_EFFECT_SPECS[type].params).forEach((key, i) => {
    const p = node.parameters.get(`p${i}`);
    if (p) map[key] = p;
  });
  return {
    node,
    params: map,
    latency: decl.latency ?? 0,
    meters,
    dispose: () => {
      node.port.postMessage({ type: 'dispose' });
      live.delete(node);
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}

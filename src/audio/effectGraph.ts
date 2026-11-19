/**
 * 이펙트 스펙 → Web Audio 노드 그래프.
 *
 * 이 파일과 `bufferRenderer.ts` 만 Web Audio 를 안다 (`plan.md` 5-2).
 * 파라미터 계산은 `effects.ts` 의 순수 함수가 하고, 여기서는 배선만 한다 —
 * 그래야 계산을 브라우저 없이 테스트할 수 있다.
 *
 * `BaseAudioContext` 를 받는다: 실시간 `AudioContext` 와 내보내기용
 * `OfflineAudioContext` 가 **같은 코드로 같은 그래프**를 만들어야 한다.
 * 미리듣기와 결과물이 100% 일치해야 하기 때문이다.
 */

import type { EffectSpec } from '../model/project.ts';
import {
  EFFECT_SPECS, dbToGain, distortionCurve, isEffectType, spatialPosition, resolveEffectParams, reverbMixGains, synthesizeReverbIr,
} from './effects.ts';
import type { WebEffectType } from './effects.ts';
import { isRustEffect } from './rustEffects.ts';
import type { RustEffectType } from './rustEffects.ts';
import { createRustFxNode } from './fxRuntime.ts';

/** 오토메이션이 직접 움직일 수 있는 `AudioParam` 과, 파라미터의 실제 값 → 그 param 값 변환 */
export interface ParamBinding {
  param: AudioParam;
  map: (value: number) => number;
}

export interface EffectChain {
  input: AudioNode;
  output: AudioNode;
  dispose(): void;
  /**
   * 오토메이션 대상. 키는 이펙트 체인 전체에서 `${이펙트 순번}:${파라미터}` —
   * 순번은 **바이패스 포함** 원래 목록의 자리다 (`AutomationLane.target` 의 `fx:` 와 같다)
   */
  bindings?: Record<string, ParamBinding[]>;
  /** 처리 지연(샘플) — 지연 보정(PDC)이 쓴다. 없으면 0 */
  latency?: number;
  /** 이펙트 순번(바이패스 포함 원래 자리) → 최근 미터 값. Rust 이펙트 중 미터가 있는 것만 */
  meters?: Map<number, Float32Array>;
  /** 사이드체인을 원하는 칸 — 렌더러가 `source` 트랙 출력을 `node` 의 둘째 입력에 잇는다 */
  keyed?: { source: string; node: AudioNode }[];
}

const same = (v: number) => v;
const ms = (v: number) => v / 1000;

function buildEq(ctx: BaseAudioContext, params: Record<string, number>): EffectChain {
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 250;
  low.gain.value = params.lowGainDb!;

  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = params.midHz!;
  mid.Q.value = 0.9;
  mid.gain.value = params.midGainDb!;

  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 4000;
  high.gain.value = params.highGainDb!;

  low.connect(mid).connect(high);
  return {
    input: low,
    output: high,
    dispose: () => { low.disconnect(); mid.disconnect(); high.disconnect(); },
    bindings: {
      lowGainDb: [{ param: low.gain, map: same }],
      midGainDb: [{ param: mid.gain, map: same }],
      highGainDb: [{ param: high.gain, map: same }],
      midHz: [{ param: mid.frequency, map: same }],
    },
  };
}

function buildCompressor(ctx: BaseAudioContext, params: Record<string, number>): EffectChain {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = params.thresholdDb!;
  comp.ratio.value = params.ratio!;
  comp.attack.value = params.attackMs! / 1000;
  comp.release.value = params.releaseMs! / 1000;
  comp.knee.value = 6;

  const makeup = ctx.createGain();
  makeup.gain.value = dbToGain(params.makeupDb!);
  comp.connect(makeup);

  return {
    input: comp,
    output: makeup,
    dispose: () => { comp.disconnect(); makeup.disconnect(); },
    bindings: {
      thresholdDb: [{ param: comp.threshold, map: same }],
      ratio: [{ param: comp.ratio, map: same }],
      attackMs: [{ param: comp.attack, map: ms }],
      releaseMs: [{ param: comp.release, map: ms }],
      makeupDb: [{ param: makeup.gain, map: dbToGain }],
    },
  };
}

function buildReverb(ctx: BaseAudioContext, params: Record<string, number>): EffectChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  const convolver = ctx.createConvolver();
  const ir = synthesizeReverbIr(ctx.sampleRate, params.decaySec!, params.dampingHz!);
  const buffer = ctx.createBuffer(2, ir[0]!.length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) buffer.getChannelData(ch).set(ir[ch]!);
  convolver.buffer = buffer;
  convolver.normalize = false; // IR 을 이미 정규화했다

  const { dry, wet } = reverbMixGains(params.mix!);
  const dryGain = ctx.createGain();
  dryGain.gain.value = dry;
  const wetGain = ctx.createGain();
  wetGain.gain.value = wet;

  input.connect(dryGain).connect(output);
  input.connect(convolver).connect(wetGain).connect(output);

  return {
    input,
    output,
    dispose: () => {
      input.disconnect(); output.disconnect();
      convolver.disconnect(); dryGain.disconnect(); wetGain.disconnect();
    },
    // 길이·감쇠는 IR 을 새로 만들어야 해서 오토메이션 대상이 아니다 (Logic 도 리버브 크기는 안 움직인다)
    bindings: mixBindings(dryGain, wetGain),
  };
}

/**
 * 딜레이 — "이 시대 사운드의 기본"인데 없던 이펙트(`SONGCRAFT.md`).
 *
 * 피드백 루프 안에 저역통과를 건다. 안 걸면 반복될수록 원본과 똑같은 밝기로
 * 계속 쌓여 하이스러운 잡음처럼 들린다 — 실제 테이프 딜레이는 반복마다 고역이
 * 죽는데, 그 특성이 "따뜻하게 흐려진다"는 느낌을 만든다.
 */
function buildDelay(ctx: BaseAudioContext, params: Record<string, number>): EffectChain {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // 최대 지연은 파라미터 상한(1.5초)보다 넉넉히 잡는다 — 나중에 파라미터
  // 상한을 늘려도 여기부터 다시 볼 필요가 없게
  const delayNode = ctx.createDelay(2);
  delayNode.delayTime.value = params.timeMs! / 1000;

  const feedbackFilter = ctx.createBiquadFilter();
  feedbackFilter.type = 'lowpass';
  feedbackFilter.frequency.value = params.dampingHz!;

  const feedbackGain = ctx.createGain();
  feedbackGain.gain.value = params.feedback!;

  delayNode.connect(feedbackFilter).connect(feedbackGain).connect(delayNode);

  // 등가 파워 크로스페이드 — 리버브와 같은 함수를 그대로 쓴다(이름은 리버브지만
  // 계산 자체는 dry/wet 믹스 전체에 통하는 일반식이다)
  const { dry, wet } = reverbMixGains(params.mix!);
  const dryGain = ctx.createGain();
  dryGain.gain.value = dry;
  const wetGain = ctx.createGain();
  wetGain.gain.value = wet;

  input.connect(dryGain).connect(output);
  input.connect(delayNode).connect(wetGain).connect(output);

  return {
    input,
    output,
    dispose: () => {
      input.disconnect(); output.disconnect(); delayNode.disconnect();
      feedbackFilter.disconnect(); feedbackGain.disconnect(); dryGain.disconnect(); wetGain.disconnect();
    },
    bindings: {
      ...mixBindings(dryGain, wetGain),
      timeMs: [{ param: delayNode.delayTime, map: ms }],
      feedback: [{ param: feedbackGain.gain, map: same }],
      dampingHz: [{ param: feedbackFilter.frequency, map: same }],
    },
  };
}

// ---------------------------------------------------------------------------
// 2026-11-17 추가 이펙트 (LOGIC_PARITY 1-12)
//
// LFO 를 쓰는 것(코러스·플랜저·페이저·트레몰로·오토 필터)은 오실레이터를 컨텍스트
// 시각 0 에 시작한다. 내보내기는 언제나 0초부터라 같은 결과가 나오고, 실시간
// 재생은 LFO 위상만 다를 수 있다 — 소리 판정에 영향이 없는 차이다.
// ---------------------------------------------------------------------------

function lfo(ctx: BaseAudioContext, rateHz: number, type: OscillatorType = 'sine'): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = rateHz;
  osc.start(0);
  return osc;
}

/** 드라이/웨트 틀 — 입력을 두 갈래로, 웨트 쪽은 `wetIn`→…→`wetOut` 을 호출자가 채운다 */
function dryWet(ctx: BaseAudioContext, mix: number) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const { dry, wet } = reverbMixGains(mix);
  const dryGain = ctx.createGain();
  dryGain.gain.value = dry;
  const wetGain = ctx.createGain();
  wetGain.gain.value = wet;
  input.connect(dryGain).connect(output);
  wetGain.connect(output);
  return { input, output, dryGain, wetGain };
}

function buildLimiter(ctx: BaseAudioContext, p: Record<string, number>): EffectChain {
  const pre = ctx.createGain();
  pre.gain.value = dbToGain(p.inputDb!);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = p.ceilingDb!;
  comp.knee.value = 0;
  comp.ratio.value = 20;
  comp.attack.value = 0.001;
  comp.release.value = p.releaseMs! / 1000;
  pre.connect(comp);
  return {
    input: pre, output: comp,
    dispose: () => { pre.disconnect(); comp.disconnect(); },
    bindings: {
      inputDb: [{ param: pre.gain, map: dbToGain }],
      ceilingDb: [{ param: comp.threshold, map: same }],
      releaseMs: [{ param: comp.release, map: ms }],
    },
  };
}

function buildHighpass(ctx: BaseAudioContext, p: Record<string, number>): EffectChain {
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = p.cutoffHz!;
  f.Q.value = 0.707;
  return { input: f, output: f, dispose: () => f.disconnect(), bindings: { cutoffHz: [{ param: f.frequency, map: same }] } };
}

function buildAutofilter(ctx: BaseAudioContext, p: Record<string, number>): EffectChain {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = p.cutoffHz!;
  f.Q.value = p.resonance!;
  // LFO 는 **옥타브 단위**로 흔든다 — detune(센트)을 움직이면 낮은 차단에서도 같은 폭으로 들린다
  const osc = lfo(ctx, p.lfoRateHz!);
  const depth = ctx.createGain();
  depth.gain.value = p.lfoDepth! * 2400;
  osc.connect(depth).connect(f.detune);
  return {
    input: f, output: f,
    dispose: () => { osc.stop(); osc.disconnect(); depth.disconnect(); f.disconnect(); },
    bindings: {
      cutoffHz: [{ param: f.frequency, map: same }],
      resonance: [{ param: f.Q, map: same }],
      lfoRateHz: [{ param: osc.frequency, map: same }],
      lfoDepth: [{ param: depth.gain, map: (v) => v * 2400 }],
    },
  };
}

/**
 * 디스토션 — **4배 오버샘플링 필수** (`CLAUDE.md` 절대 타협 불가: 비선형 단계 오버샘플링).
 * 웨이브셰이퍼의 `oversample = '4x'` 가 그 일을 한다. 앞에 고역을 조금 깎아
 * 에일리어싱 재료를 줄이고, 뒤에 톤 필터로 쏘는 고역을 다듬는다.
 */
function buildDistortion(ctx: BaseAudioContext, p: Record<string, number>): EffectChain {
  const dw = dryWet(ctx, p.mix!);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distortionCurve(p.driveDb!) as Float32Array<ArrayBuffer>;
  shaper.oversample = '4x';
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = p.toneHz!;
  const out = ctx.createGain();
  out.gain.value = dbToGain(p.outputDb!);
  dw.input.connect(shaper).connect(tone).connect(dw.wetGain);
  dw.output.connect(out);
  return {
    input: dw.input, output: out,
    dispose: () => { dw.input.disconnect(); shaper.disconnect(); tone.disconnect(); dw.dryGain.disconnect(); dw.wetGain.disconnect(); dw.output.disconnect(); out.disconnect(); },
    bindings: {
      ...mixBindings(dw.dryGain, dw.wetGain),
      toneHz: [{ param: tone.frequency, map: same }],
      outputDb: [{ param: out.gain, map: dbToGain }],
    },
  };
}

/** 코러스·플랜저 — LFO 가 흔드는 짧은 딜레이. 플랜저는 더 짧고 피드백이 있다 */
function buildModDelay(ctx: BaseAudioContext, p: Record<string, number>, baseMs: number, withFeedback: boolean): EffectChain {
  const dw = dryWet(ctx, p.mix!);
  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = baseMs / 1000;
  const osc = lfo(ctx, p.rateHz!);
  const depth = ctx.createGain();
  depth.gain.value = p.depthMs! / 1000;
  osc.connect(depth).connect(delay.delayTime);
  const fb = ctx.createGain();
  fb.gain.value = withFeedback ? p.feedback! : 0;
  dw.input.connect(delay).connect(dw.wetGain);
  delay.connect(fb).connect(delay);
  return {
    input: dw.input, output: dw.output,
    dispose: () => { osc.stop(); osc.disconnect(); depth.disconnect(); delay.disconnect(); fb.disconnect(); dw.input.disconnect(); dw.dryGain.disconnect(); dw.wetGain.disconnect(); },
    bindings: {
      ...mixBindings(dw.dryGain, dw.wetGain),
      rateHz: [{ param: osc.frequency, map: same }],
      depthMs: [{ param: depth.gain, map: ms }],
      ...(withFeedback ? { feedback: [{ param: fb.gain, map: same }] } : {}),
    },
  };
}

/** 페이저 — 올패스 4단을 LFO 로 쓸고 피드백 */
function buildPhaser(ctx: BaseAudioContext, p: Record<string, number>): EffectChain {
  const dw = dryWet(ctx, p.mix!);
  const stages = [0, 1, 2, 3].map(() => {
    const f = ctx.createBiquadFilter();
    f.type = 'allpass';
    f.frequency.value = 900;
    f.Q.value = 0.6;
    return f;
  });
  const osc = lfo(ctx, p.rateHz!);
  const depth = ctx.createGain();
  depth.gain.value = p.depth! * 2400;
  for (const s of stages) osc.connect(depth).connect(s.detune);
  const fb = ctx.createGain();
  fb.gain.value = p.feedback!;
  let tail: AudioNode = dw.input;
  for (const s of stages) { tail.connect(s); tail = s; }
  tail.connect(dw.wetGain);
  tail.connect(fb).connect(stages[0]!);
  return {
    input: dw.input, output: dw.output,
    dispose: () => { osc.stop(); osc.disconnect(); depth.disconnect(); fb.disconnect(); for (const s of stages) s.disconnect(); dw.input.disconnect(); dw.dryGain.disconnect(); dw.wetGain.disconnect(); },
    bindings: {
      ...mixBindings(dw.dryGain, dw.wetGain),
      rateHz: [{ param: osc.frequency, map: same }],
      depth: [{ param: depth.gain, map: (v) => v * 2400 }],
      feedback: [{ param: fb.gain, map: same }],
    },
  };
}

/** 트레몰로 — 게인을 LFO 로. 깊이 d 면 게인이 1−d … 1 사이를 오간다 */
function buildTremolo(ctx: BaseAudioContext, p: Record<string, number>): EffectChain {
  const amp = ctx.createGain();
  amp.gain.value = 1 - p.depth! / 2;
  const osc = lfo(ctx, p.rateHz!);
  const depth = ctx.createGain();
  depth.gain.value = p.depth! / 2;
  osc.connect(depth).connect(amp.gain);
  return {
    input: amp, output: amp,
    dispose: () => { osc.stop(); osc.disconnect(); depth.disconnect(); amp.disconnect(); },
    bindings: {
      rateHz: [{ param: osc.frequency, map: same }],
      depth: [{ param: depth.gain, map: (v) => v / 2 }, { param: amp.gain, map: (v) => 1 - v / 2 }],
    },
  };
}

/** 스테레오 폭 — 미드/사이드. 사이드에 폭을 곱한다 (0 = 모노, 2 = 두 배) */
function buildWidth(ctx: BaseAudioContext, p: Record<string, number>): EffectChain {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const g = (v: number) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  // L' = M + w·S, R' = M − w·S,  M = (L+R)/2, S = (L−R)/2
  const w = p.width!;
  const lToL = g(0.5 + w / 2); const rToL = g(0.5 - w / 2);
  const lToR = g(0.5 - w / 2); const rToR = g(0.5 + w / 2);
  input.connect(split);
  split.connect(lToL, 0).connect(merge, 0, 0);
  split.connect(rToL, 1).connect(merge, 0, 0);
  split.connect(lToR, 0).connect(merge, 0, 1);
  split.connect(rToR, 1).connect(merge, 0, 1);
  const same2 = (v: number) => 0.5 + v / 2;
  const opp2 = (v: number) => 0.5 - v / 2;
  return {
    input, output: merge,
    dispose: () => { for (const n of [input, split, merge, lToL, rToL, lToR, rToR]) n.disconnect(); },
    bindings: {
      width: [
        { param: lToL.gain, map: same2 }, { param: rToR.gain, map: same2 },
        { param: rToL.gain, map: opp2 }, { param: lToR.gain, map: opp2 },
      ],
    },
  };
}

/**
 * 3D 패너 — HRTF. 거리는 역제곱이 아니라 완만한 'inverse' 모델로 (가까이 1m 기준) —
 * 실제처럼 줄이면 몇 m 만 떨어져도 거의 안 들려 믹스에 못 쓴다.
 */
function buildSpatial(ctx: BaseAudioContext, p: Record<string, number>): EffectChain {
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1;
  panner.rolloffFactor = 0.6;
  const pos = spatialPosition(p.azimuth!, p.elevation!, p.distance!);
  panner.positionX.value = pos.x;
  panner.positionY.value = pos.y;
  panner.positionZ.value = pos.z;
  // 방향 오토메이션: 지금 높이·거리를 고정하고 방향만 돈다 (원을 그리는 움직임)
  const at = (az: number) => spatialPosition(az, p.elevation!, p.distance!);
  return {
    input: panner, output: panner,
    dispose: () => panner.disconnect(),
    bindings: {
      azimuth: [
        { param: panner.positionX, map: (v) => at(v).x },
        { param: panner.positionZ, map: (v) => at(v).z },
      ],
      elevation: [{ param: panner.positionY, map: (v) => spatialPosition(p.azimuth!, v, p.distance!).y }],
    },
  };
}

/**
 * Rust 이펙트 (`EFFECTS_PLAN.md`) — 워크렛 노드 하나. 파라미터마다 AudioParam 이 있어 오토메이션이
 * 값 그대로 움직인다. 워크렛이 없는 컨텍스트에서는 통과(게인 하나)로 떨어진다.
 */
function buildRust(ctx: BaseAudioContext, type: RustEffectType, p: Record<string, number>): EffectChain & { meterValues?: Float32Array } {
  const fx = createRustFxNode(ctx, type, p);
  if (!fx) {
    const pass = ctx.createGain();
    return { input: pass, output: pass, dispose: () => pass.disconnect() };
  }
  const bindings: Record<string, ParamBinding[]> = {};
  for (const [key, param] of Object.entries(fx.params)) bindings[key] = [{ param, map: same }];
  return { input: fx.node, output: fx.node, dispose: fx.dispose, bindings, latency: fx.latency, meterValues: fx.meters };
}

const BUILDERS: Record<WebEffectType, (ctx: BaseAudioContext, p: Record<string, number>) => EffectChain> = {
  eq: buildEq,
  compressor: buildCompressor,
  reverb: buildReverb,
  delay: buildDelay,
  limiter: buildLimiter,
  highpass: buildHighpass,
  autofilter: buildAutofilter,
  distortion: buildDistortion,
  chorus: (ctx, p) => buildModDelay(ctx, p, 15, false),
  flanger: (ctx, p) => buildModDelay(ctx, p, 3, true),
  phaser: buildPhaser,
  tremolo: buildTremolo,
  width: buildWidth,
  spatial: buildSpatial,
};

/** 섞기(mix) 하나가 드라이·웨트 두 게인을 함께 움직인다 */
function mixBindings(dryGain: GainNode, wetGain: GainNode): Record<string, ParamBinding[]> {
  return {
    mix: [
      { param: dryGain.gain, map: (v) => reverbMixGains(v).dry },
      { param: wetGain.gain, map: (v) => reverbMixGains(v).wet },
    ],
  };
}

/** 다시 쓸 수 있는 이펙트 한 칸 */
interface Part {
  key: string;
  chain: EffectChain & { meterValues?: Float32Array };
}

/**
 * 같은 칸으로 다시 쓸 수 있는지 가르는 열쇠.
 * - Web Audio 이펙트: 파라미터 전부 (IR 등 노드를 새로 만들어야 하는 값이 섞여 있다)
 * - Rust 이펙트: 종류 + **오토메이션 대상이 아닌** 파라미터만 — 나머지는 AudioParam 값만 바꾸면 된다.
 *   손잡이를 돌려도 노드를 새로 만들지 않으니 리버브 꼬리가 끊기지 않고 wasm 인스턴스가 쌓이지 않는다
 */
function partKey(spec: EffectSpec, params: Record<string, number>): string {
  if (!isRustEffect(spec.type)) return `${spec.type}|${JSON.stringify(params)}`;
  const decl = EFFECT_SPECS[spec.type].params;
  const fixed = Object.keys(decl).filter((k) => decl[k]!.automatable === false).map((k) => params[k]);
  return `${spec.type}|${JSON.stringify(fixed)}`;
}

type ChainWithParts = EffectChain & { parts?: Part[] };

/**
 * 이펙트 목록을 직렬로 이어 붙인다. 목록이 비었거나 전부 바이패스면
 * 통과용 게인 하나만 만든다 — 호출자가 분기하지 않아도 되게.
 */
export function buildEffectChain(ctx: BaseAudioContext, specs: readonly EffectSpec[]): EffectChain {
  return updateEffectChain(ctx, null, specs);
}

/**
 * 앞 체인을 고쳐 새 목록에 맞춘다 — **바뀐 칸만 새로 만든다.** 입력 노드는 그대로라 앞쪽 연결이 살아 있고,
 * 출력은 바뀔 수 있으니 호출자가 다시 잇는다(같은 노드에 두 번 이어도 괜찮다).
 * 예전 체인의 `dispose()` 는 부르지 않는다 — 여기서 안 쓰는 칸만 버린다.
 *
 * 이게 없을 때: 이펙트를 하나 넣을 때마다 체인 전체를 새로 지어, 84종을 한 트랙에 넣는 동안
 * Rust 노드(= wasm 인스턴스)가 2,772 개 생기고 브라우저 오디오가 멎었다 (2026-11-19).
 */
export function updateEffectChain(ctx: BaseAudioContext, previous: EffectChain | null, specs: readonly EffectSpec[]): EffectChain {
  const prev = previous as ChainWithParts | null;
  const passthrough = (prev?.input as GainNode | undefined) ?? ctx.createGain();
  const pool = [...(prev?.parts ?? [])];
  passthrough.disconnect();
  for (const part of pool) part.chain.output.disconnect();

  const parts: Part[] = [];
  let tail: AudioNode = passthrough;
  const bindings: Record<string, ParamBinding[]> = {};
  const meters = new Map<number, Float32Array>();
  const keyed: { source: string; node: AudioNode }[] = [];
  let latency = 0;
  for (const [index, spec] of specs.entries()) {
    if (spec.bypass) continue;
    if (!isEffectType(spec.type)) {
      // 조용히 건너뛰면 "이펙트를 켰는데 아무 일도 안 난다"가 된다
      throw new Error(`알 수 없는 이펙트: ${spec.type}`);
    }
    const params = resolveEffectParams(spec);
    const key = partKey(spec, params);
    const at = pool.findIndex((p) => p.key === key);
    let part: Part;
    if (at >= 0) {
      part = pool.splice(at, 1)[0]!;
      // Rust 이펙트: 값만 새로 (오토메이션이 걸린 파라미터는 재생할 때 오토메이션이 다시 덮는다)
      if (isRustEffect(spec.type)) {
        for (const [name, list] of Object.entries(part.chain.bindings ?? {})) {
          const v = params[name];
          if (typeof v === 'number') for (const b of list) b.param.value = b.map(v);
        }
      }
    } else {
      const chain = isRustEffect(spec.type)
        ? buildRust(ctx, spec.type, params)
        : BUILDERS[spec.type as WebEffectType](ctx, params);
      part = { key, chain };
    }
    tail.connect(part.chain.input);
    tail = part.chain.output;
    parts.push(part);
    latency += part.chain.latency ?? 0;
    if (part.chain.meterValues) meters.set(index, part.chain.meterValues);
    if (spec.sidechain && isRustEffect(spec.type) && typeof AudioWorkletNode !== 'undefined' && part.chain.input instanceof AudioWorkletNode) keyed.push({ source: spec.sidechain, node: part.chain.input });
    for (const [name, list] of Object.entries(part.chain.bindings ?? {})) bindings[`${index}:${name}`] = list;
  }
  for (const unused of pool) unused.chain.dispose();

  const chain: ChainWithParts = {
    input: passthrough,
    output: tail,
    bindings,
    latency,
    meters,
    keyed,
    parts,
    dispose: () => {
      passthrough.disconnect();
      for (const p of parts) p.chain.dispose();
    },
  };
  return chain;
}

/** 사이드체인 연결 하나 — 끊을 때 쓴다 */
export interface KeyConnection { from: AudioNode; to: AudioNode }

/**
 * 사이드체인을 다시 잇는다 (`PARITY_ROUND2.md` 7). 앞서 이은 것을 모두 끊고, 체인들이 원하는 감지 소스
 * (트랙 끝 = 페이더·이펙트 뒤)를 각 Rust 노드의 **둘째 입력**에 잇는다. 자기 자신이 소스면 잇지 않는다.
 * 두 트랙이 서로를 감지하면 지연 없는 고리가 되어 브라우저가 둘 다 무음으로 만든다 — 그런 짝은 건너뛴다.
 */
export function wireSidechains(
  owners: { owner: string; chain: EffectChain }[],
  sourceOf: (trackId: string) => AudioNode | undefined,
  previous: readonly KeyConnection[],
): KeyConnection[] {
  for (const c of previous) {
    try { c.from.disconnect(c.to, 0, 1); } catch { /* 이미 끊겼다 */ }
  }
  const wants = owners.flatMap(({ owner, chain }) => (chain.keyed ?? []).map((k) => ({ owner, ...k })));
  const pairs = new Set(wants.map((w) => `${w.source}>${w.owner}`));
  const out: KeyConnection[] = [];
  for (const w of wants) {
    if (w.source === w.owner || pairs.has(`${w.owner}>${w.source}`)) continue;
    const from = sourceOf(w.source);
    if (!from) continue;
    from.connect(w.node, 0, 1);
    out.push({ from, to: w.node });
  }
  return out;
}

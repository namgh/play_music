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
  dbToGain, distortionCurve, isEffectType, spatialPosition, resolveEffectParams, reverbMixGains, synthesizeReverbIr,
} from './effects.ts';
import type { EffectType } from './effects.ts';

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

const BUILDERS: Record<EffectType, (ctx: BaseAudioContext, p: Record<string, number>) => EffectChain> = {
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

/**
 * 이펙트 목록을 직렬로 이어 붙인다. 목록이 비었거나 전부 바이패스면
 * 통과용 게인 하나만 만든다 — 호출자가 분기하지 않아도 되게.
 */
export function buildEffectChain(ctx: BaseAudioContext, specs: readonly EffectSpec[]): EffectChain {
  const passthrough = ctx.createGain();
  const built: EffectChain[] = [];

  let tail: AudioNode = passthrough;
  const bindings: Record<string, ParamBinding[]> = {};
  for (const [index, spec] of specs.entries()) {
    if (spec.bypass) continue;
    if (!isEffectType(spec.type)) {
      // 조용히 건너뛰면 "이펙트를 켰는데 아무 일도 안 난다"가 된다
      throw new Error(`알 수 없는 이펙트: ${spec.type}`);
    }
    const params = resolveEffectParams(spec);
    const chain = BUILDERS[spec.type](ctx, params);
    tail.connect(chain.input);
    tail = chain.output;
    built.push(chain);
    for (const [name, list] of Object.entries(chain.bindings ?? {})) bindings[`${index}:${name}`] = list;
  }

  return {
    input: passthrough,
    output: tail,
    bindings,
    dispose: () => {
      passthrough.disconnect();
      for (const chain of built) chain.dispose();
    },
  };
}

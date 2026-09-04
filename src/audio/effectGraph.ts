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
  dbToGain, isEffectType, resolveEffectParams, reverbMixGains, synthesizeReverbIr,
} from './effects.ts';

export interface EffectChain {
  input: AudioNode;
  output: AudioNode;
  dispose(): void;
}

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
  for (const spec of specs) {
    if (spec.bypass) continue;
    if (!isEffectType(spec.type)) {
      // 조용히 건너뛰면 "이펙트를 켰는데 아무 일도 안 난다"가 된다
      throw new Error(`알 수 없는 이펙트: ${spec.type}`);
    }
    const params = resolveEffectParams(spec);
    const chain =
      spec.type === 'eq' ? buildEq(ctx, params)
        : spec.type === 'compressor' ? buildCompressor(ctx, params)
          : spec.type === 'reverb' ? buildReverb(ctx, params)
            : buildDelay(ctx, params);
    tail.connect(chain.input);
    tail = chain.output;
    built.push(chain);
  }

  return {
    input: passthrough,
    output: tail,
    dispose: () => {
      passthrough.disconnect();
      for (const chain of built) chain.dispose();
    },
  };
}

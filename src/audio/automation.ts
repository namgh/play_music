/**
 * 오토메이션 — 점 목록을 값으로, 값을 `AudioParam` 예약으로.
 *
 * `ROADMAP.md` 제품 레인 다음 순서, `SONGCRAFT.md` 1번("오토메이션이 없다 · 가장
 * 크다")이 지목한 것이다. 볼륨 페이드·사이드체인 덕킹이 전부 이 하나의 표현으로
 * 풀린다 — 사이드체인도 결국 "값이 시간에 따라 눌렸다 돌아오는" 곡선이다
 * (`src/editor/edits.ts` 의 `applySidechainDuck` 이 그 곡선을 만든다).
 *
 * 이 파일은 순수 계산만 한다. `AudioParam` 을 실제로 건드리는 것은
 * `scheduleGainAutomation` 하나뿐이고, 나머지는 브라우저 없이 테스트된다.
 */

import type { AutomationLane, AutomationPoint, AutomationTarget, Track } from '../model/project.ts';
import { EFFECT_SPECS, isEffectType, resolveEffectParams } from './effects.ts';
import type { EffectParamSpec, EffectType } from './effects.ts';
import type { Tempo, Ticks } from '../model/time.ts';
import { ticksToSeconds } from '../model/time.ts';

export function volumeLane(track: Track): AutomationLane | undefined {
  return track.automation.find((lane) => lane.target === 'volume');
}

/**
 * 특정 틱에서의 값. 점 사이는 직선 보간, 양 끝 밖은 마지막 값을 유지한다.
 * 점이 없으면 1(변화 없음) — 오토메이션이 없는 트랙은 예전과 똑같이 울려야 한다.
 */
export function automationValueAtTick(points: readonly AutomationPoint[], tick: Ticks): number {
  if (points.length === 0) return 1;
  const first = points[0]!;
  if (tick <= first.tick) return first.value;
  const last = points[points.length - 1]!;
  if (tick >= last.tick) return last.value;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (tick <= b.tick) {
      const a = points[i - 1]!;
      const span = b.tick - a.tick;
      const frac = span <= 0 ? 0 : (tick - a.tick) / span;
      return a.value + (b.value - a.value) * frac;
    }
  }
  return last.value;
}

/**
 * `anchorTick` 이 재생 헤드의 지금 위치이고, 그 순간의 오디오 클럭이
 * `anchorTimeSec` 다 — 재생·되감기가 그 둘을 정한다.
 *
 * **루프 구간 밖에서만 정확하다.** 루프가 켜져 있으면 오토메이션은 곡 절대
 * 시각을 그대로 따라가고 감기지 않는다 — 그 처리는 나중 스코프다.
 */
export function scheduleGainAutomation(
  param: AudioParam,
  points: readonly AutomationPoint[],
  tempo: Tempo,
  baseScalar: number,
  anchorTick: Ticks,
  anchorTimeSec: number,
): void {
  param.cancelScheduledValues(anchorTimeSec);
  const startValue = baseScalar * automationValueAtTick(points, anchorTick);
  param.setValueAtTime(startValue, anchorTimeSec);
  if (points.length === 0) return;

  const anchorSeconds = ticksToSeconds(anchorTick, tempo);
  for (const point of points) {
    if (point.tick <= anchorTick) continue;
    const atSec = anchorTimeSec + (ticksToSeconds(point.tick, tempo) - anchorSeconds);
    param.linearRampToValueAtTime(baseScalar * point.value, atSec);
  }
}

// ---------------------------------------------------------------------------
// 모든 대상 — 볼륨 · 팬 · 이펙트 파라미터 (`LOGIC_PARITY.md` 1-9)
// ---------------------------------------------------------------------------

/** 0~1 저장값 → 이펙트 파라미터 실제 값. `log` 곡선이면 지수 보간 (주파수 같은 것) */
export function denormalizeParam(spec: EffectParamSpec, value01: number): number {
  const v = Math.max(0, Math.min(1, value01));
  if (spec.curve === 'log' && spec.min > 0) return spec.min * Math.pow(spec.max / spec.min, v);
  return spec.min + (spec.max - spec.min) * v;
}

/** 실제 값 → 0~1 (곡선 편집기가 지금 값을 첫 점으로 놓을 때) */
export function normalizeParam(spec: EffectParamSpec, value: number): number {
  if (spec.curve === 'log' && spec.min > 0) return Math.log(value / spec.min) / Math.log(spec.max / spec.min);
  return (value - spec.min) / (spec.max - spec.min);
}

export interface TargetInfo {
  label: string;
  /** 0~1 → 표시 문자열 */
  format: (value01: number) => string;
  /** 오토메이션이 없을 때의 0~1 값 — 곡선 첫 점의 기본 */
  current: number;
}

/** 이 트랙에서 고를 수 있는 오토메이션 대상 전부 */
export function automationTargets(track: Track): { target: AutomationTarget; info: TargetInfo }[] {
  const out: { target: AutomationTarget; info: TargetInfo }[] = [
    { target: 'volume', info: { label: '볼륨', format: (v) => `${Math.round(v * 100)}%`, current: 1 } },
    {
      target: 'pan',
      info: {
        label: '팬',
        format: (v) => { const p = Math.round((v * 2 - 1) * 100); return p === 0 ? 'C' : p < 0 ? `L${-p}` : `R${p}`; },
        current: (track.pan + 1) / 2,
      },
    },
  ];
  track.effects.forEach((effect, index) => {
    if (!isEffectType(effect.type)) return;
    const specs = EFFECT_SPECS[effect.type];
    const resolved = resolveEffectParams(effect);
    for (const [name, spec] of Object.entries(specs.params)) {
      if (!AUTOMATABLE[effect.type].includes(name)) continue;
      out.push({
        target: `fx:${index}:${name}`,
        info: {
          label: `${specs.label} ${spec.label}`,
          format: (v) => { const real = denormalizeParam(spec, v); return `${real >= 100 ? Math.round(real) : Math.round(real * 100) / 100}${spec.unit ?? ''}`; },
          current: Math.max(0, Math.min(1, normalizeParam(spec, resolved[name] ?? spec.default))),
        },
      });
    }
  });
  return out;
}

/** 렌더러가 `AudioParam` 으로 바로 움직일 수 있는 파라미터 (`effectGraph.ts` bindings 와 짝) */
const AUTOMATABLE: Record<EffectType, string[]> = {
  eq: ['lowGainDb', 'midGainDb', 'highGainDb', 'midHz'],
  compressor: ['thresholdDb', 'ratio', 'attackMs', 'releaseMs', 'makeupDb'],
  reverb: ['mix'],
  delay: ['mix', 'timeMs', 'feedback', 'dampingHz'],
  limiter: ['inputDb', 'ceilingDb', 'releaseMs'],
  highpass: ['cutoffHz'],
  autofilter: ['cutoffHz', 'resonance', 'lfoRateHz', 'lfoDepth'],
  distortion: ['toneHz', 'mix', 'outputDb'],
  chorus: ['rateHz', 'depthMs', 'mix'],
  flanger: ['rateHz', 'depthMs', 'feedback', 'mix'],
  phaser: ['rateHz', 'depth', 'feedback', 'mix'],
  tremolo: ['rateHz', 'depth'],
  width: ['width'],
  spatial: ['azimuth', 'elevation'],
};

/**
 * 곡선을 임의의 `AudioParam` 에 예약한다. 점 사이는 **저장값(0~1) 공간에서 직선** —
 * 실제 값 공간에서 잇지 않는다 (로그 주파수가 곡선 편집기에서 본 모양대로 움직이게).
 * 그래서 점 사이를 잘게(1/32박) 쪼개 예약한다.
 */
export function scheduleMappedAutomation(
  param: AudioParam,
  points: readonly AutomationPoint[],
  tempo: Tempo,
  map: (value01: number) => number,
  anchorTick: Ticks,
  anchorTimeSec: number,
): void {
  param.cancelScheduledValues(anchorTimeSec);
  if (points.length === 0) return;
  param.setValueAtTime(map(automationValueAtTick(points, anchorTick)), anchorTimeSec);
  const anchorSeconds = ticksToSeconds(anchorTick, tempo);
  const step = 30; // 틱 — 1/32 박
  const last = points[points.length - 1]!.tick;
  for (let tick = Math.ceil((anchorTick + 1) / step) * step; tick <= last + step; tick += step) {
    const atSec = anchorTimeSec + (ticksToSeconds(tick, tempo) - anchorSeconds);
    param.linearRampToValueAtTime(map(automationValueAtTick(points, tick)), atSec);
  }
}

export interface TrackAutomationNodes {
  automationGain: GainNode;
  panNode: StereoPannerNode;
  bindings: Record<string, { param: AudioParam; map: (value: number) => number }[]> | undefined;
}

/** 트랙의 모든 레인을 예약한다 — 세 렌더러(워크렛·버퍼·내보내기)가 같은 함수를 쓴다 */
export function scheduleTrackLanes(
  track: Track,
  nodes: TrackAutomationNodes,
  tempo: Tempo,
  anchorTick: Ticks,
  anchorTimeSec: number,
): void {
  for (const lane of track.automation) {
    if (lane.target === 'volume') {
      // 이펙트 뒤 게인이라 배율은 1 — 정적 트랙 게인은 이미 `gainNode` 가 담당한다
      scheduleGainAutomation(nodes.automationGain.gain, lane.points, tempo, 1, anchorTick, anchorTimeSec);
    } else if (lane.target === 'pan') {
      if (lane.points.length === 0) continue;
      scheduleMappedAutomation(nodes.panNode.pan, lane.points, tempo, (v) => v * 2 - 1, anchorTick, anchorTimeSec);
    } else {
      const [, index, name] = lane.target.split(':');
      const effect = track.effects[Number(index)];
      if (!effect || effect.bypass || !isEffectType(effect.type)) continue;
      const spec = EFFECT_SPECS[effect.type].params[name!];
      const bindings = nodes.bindings?.[`${index}:${name}`];
      if (!spec || !bindings) continue;
      for (const binding of bindings) {
        scheduleMappedAutomation(binding.param, lane.points, tempo, (v) => binding.map(denormalizeParam(spec, v)), anchorTick, anchorTimeSec);
      }
    }
  }
}

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
import type { EffectParamSpec, EffectType, WebEffectType } from './effects.ts';
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

/** 악기 파라미터 선언 (악기 쪽 `ParamSpec` 과 같은 모양 — 오디오 층이 악기 층을 import 하지 않게 여기서 최소로) */
export interface InstrumentParamSpec {
  type: 'float' | 'int' | 'enum';
  min?: number;
  max?: number;
  default: number | string;
  label: string;
  unit?: string;
  curve?: 'linear' | 'log';
}

/** 0~1 → 악기 파라미터 값 (정수면 반올림). 선언에 범위가 없으면 null */
export function instrumentParamValue(spec: InstrumentParamSpec, value01: number): number | null {
  if (spec.type === 'enum' || spec.min === undefined || spec.max === undefined) return null;
  const v = Math.max(0, Math.min(1, value01));
  const real = spec.curve === 'log' && spec.min > 0 ? spec.min * Math.pow(spec.max / spec.min, v) : spec.min + (spec.max - spec.min) * v;
  return spec.type === 'int' ? Math.round(real) : real;
}

/**
 * 악기 파라미터 오토메이션을 반영한 파라미터 — 음 하나가 시작하는 자리(`tick`)의 곡선 값.
 * 음 안에서 계속 움직이지는 않는다(보이스 파라미터는 발음할 때 정해진다) — 재생·내보내기가 같은 함수를 쓴다
 */
export function paramsWithAutomation<T extends Record<string, number | string>>(
  track: Pick<Track, 'automation'>,
  params: T,
  specs: Record<string, InstrumentParamSpec> | undefined,
  tick: Ticks,
): T {
  let out: T | null = null;
  for (const lane of track.automation) {
    if (!lane.target.startsWith('inst:') || lane.points.length === 0) continue;
    const name = lane.target.slice(5);
    const spec = specs?.[name];
    if (!spec) continue;
    const v = instrumentParamValue(spec, automationValueAtTick(lane.points, tick));
    if (v === null) continue;
    out ??= { ...params };
    (out as Record<string, number | string>)[name] = v;
  }
  return out ?? params;
}

/** 이 트랙에서 고를 수 있는 오토메이션 대상 전부 (악기 선언을 주면 악기 파라미터도) */
export function automationTargets(track: Track, instrumentSpecs?: Record<string, InstrumentParamSpec> | null, currentParams?: Record<string, number | string>): { target: AutomationTarget; info: TargetInfo }[] {
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
  for (const [name, spec] of Object.entries(instrumentSpecs ?? {})) {
    if (spec.type === 'enum' || spec.min === undefined || spec.max === undefined || spec.max <= spec.min) continue;
    const cur = Number(currentParams?.[name] ?? spec.default);
    const cur01 = spec.curve === 'log' && spec.min > 0 ? Math.log(cur / spec.min) / Math.log(spec.max / spec.min) : (cur - spec.min) / (spec.max - spec.min);
    out.push({
      target: `inst:${name}`,
      info: {
        label: `악기 ${spec.label}`,
        format: (v) => { const r = instrumentParamValue(spec, v) ?? 0; return `${Math.abs(r) >= 100 ? Math.round(r) : Math.round(r * 100) / 100}${spec.unit ?? ''}`; },
        current: Number.isFinite(cur01) ? Math.max(0, Math.min(1, cur01)) : 0.5,
      },
    });
  }
  track.effects.forEach((effect, index) => {
    if (!isEffectType(effect.type)) return;
    const specs = EFFECT_SPECS[effect.type];
    const resolved = resolveEffectParams(effect);
    for (const [name, spec] of Object.entries(specs.params)) {
      if (!automatable(effect.type, name)) continue;
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

/**
 * 렌더러가 `AudioParam` 으로 바로 움직일 수 있는 파라미터 (`effectGraph.ts` bindings 와 짝).
 * Rust 이펙트는 파라미터마다 AudioParam(p0…) 이 있어 **전부** 대상이다 — 선언에 `automatable: false` 만 뺀다
 */
function automatable(type: EffectType, name: string): boolean {
  if (type in WEB_AUTOMATABLE) return WEB_AUTOMATABLE[type as WebEffectType].includes(name);
  return EFFECT_SPECS[type].params[name]?.automatable !== false;
}

const WEB_AUTOMATABLE: Record<WebEffectType, string[]> = {
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

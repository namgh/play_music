/**
 * 오토메이션 편집 — 모든 대상(볼륨·팬·이펙트 파라미터)의 점 찍기·옮기기·지우기,
 * 모드, 재생 중 기록 (Logic Automation, `LOGIC_PARITY.md` 1-9).
 *
 * 값은 전부 0~1 (`AutomationTarget` 주석). 순수 함수, 입력을 바꾸지 않는다.
 */

import type { AutomationLane, AutomationMode, AutomationPoint, AutomationTarget, Project, TrackId } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { EditError } from './edits.ts';
import { automationValueAtTick } from '../audio/automation.ts';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const byTick = (a: AutomationPoint, b: AutomationPoint) => a.tick - b.tick;

function mapLane(
  project: Project,
  trackId: TrackId,
  target: AutomationTarget,
  fn: (points: AutomationPoint[]) => AutomationPoint[],
): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`트랙 ${trackId} 없음`);
  const existing = track.automation.find((l) => l.target === target);
  const points = fn(existing ? [...existing.points] : []).sort(byTick);
  // 점이 다 없어지면 레인도 지운다 — 빈 레인이 남으면 "오토메이션 있음" 표시가 거짓말을 한다
  const automation: AutomationLane[] = points.length === 0
    ? track.automation.filter((l) => l.target !== target)
    : existing
      ? track.automation.map((l) => (l.target === target ? { ...l, points } : l))
      : [...track.automation, { target, points }];
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, automation } : t)) };
}

export function lanePoints(project: Project, trackId: TrackId, target: AutomationTarget): AutomationPoint[] {
  return project.tracks.find((t) => t.id === trackId)?.automation.find((l) => l.target === target)?.points ?? [];
}

/** 점을 놓는다. 같은 틱에 이미 있으면 값을 바꾼다 */
export function addAutomationPoint(project: Project, trackId: TrackId, target: AutomationTarget, tick: Ticks, value: number): Project {
  const t = Math.max(0, Math.round(tick));
  return mapLane(project, trackId, target, (points) => [...points.filter((p) => p.tick !== t), { tick: t, value: clamp01(value) }]);
}

/** `index` 번째 점을 옮긴다 — 이웃 점을 넘어가지 못한다 (순서가 바뀌면 끌던 점이 바뀐다) */
export function moveAutomationPoint(
  project: Project, trackId: TrackId, target: AutomationTarget, index: number, tick: Ticks, value: number,
): Project {
  return mapLane(project, trackId, target, (points) => {
    const point = points[index];
    if (!point) throw new EditError('점이 없다');
    const lo = index > 0 ? points[index - 1]!.tick + 1 : 0;
    const hi = index < points.length - 1 ? points[index + 1]!.tick - 1 : Number.MAX_SAFE_INTEGER;
    points[index] = { tick: Math.max(lo, Math.min(hi, Math.round(tick))), value: clamp01(value) };
    return points;
  });
}

export function deleteAutomationPoint(project: Project, trackId: TrackId, target: AutomationTarget, index: number): Project {
  return mapLane(project, trackId, target, (points) => points.filter((_, i) => i !== index));
}

export function clearAutomationLane(project: Project, trackId: TrackId, target: AutomationTarget): Project {
  return mapLane(project, trackId, target, () => []);
}

export function setAutomationMode(project: Project, trackId: TrackId, mode: AutomationMode): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const next = { ...t };
      if (mode === 'read') delete next.automationMode;
      else next.automationMode = mode;
      return next;
    }),
  };
}

/**
 * 재생 중 기록 한 걸음 — 손잡이를 `fromTick` 부터 `toTick` 까지 `value` 로 잡고 있었다.
 * 그 사이의 옛 점을 지우고 새 점을 놓는다 (Logic 터치·래치·쓰기가 공통으로 하는 일).
 * 모드의 차이는 **언제 이 함수를 부르나**에 있다 — `recorderStep`.
 */
export function writeAutomation(
  project: Project,
  trackId: TrackId,
  target: AutomationTarget,
  range: { fromTick: Ticks; toTick: Ticks },
  value: number,
): Project {
  const from = Math.round(Math.min(range.fromTick, range.toTick));
  const to = Math.round(Math.max(range.fromTick, range.toTick));
  return mapLane(project, trackId, target, (points) => {
    const kept = points.filter((p) => p.tick < from || p.tick > to);
    const atFrom = points.find((p) => p.tick === from);
    // 구간 시작에 점이 없으면 하나 놓는다 — 안 놓으면 이전 점부터 비스듬히 미끄러져 들어온다
    const head = atFrom ? [atFrom] : from < to ? [{ tick: from, value: clamp01(value) }] : [];
    return [...kept, ...head, { tick: to, value: clamp01(value) }];
  });
}

/** 레인 점을 통째로 바꾼다 (트림 기록이 잡기 시작한 순간의 곡선으로 되돌릴 때) */
export function withLanePoints(project: Project, trackId: TrackId, target: AutomationTarget, points: readonly AutomationPoint[]): Project {
  return mapLane(project, trackId, target, () => [...points]);
}

/**
 * 트림 (Logic Trim) — 있는 곡선의 **모양을 지키며** 구간을 배율만큼 올리거나 내린다.
 * 구간 양 끝에 원래 값의 점을 먼저 박아 구간 밖은 그대로 두고, 안쪽 점(과 끝점)만 곱한다.
 */
export function trimAutomation(
  project: Project,
  trackId: TrackId,
  target: AutomationTarget,
  range: { fromTick: Ticks; toTick: Ticks },
  factor: number,
): Project {
  const from = Math.round(Math.min(range.fromTick, range.toTick));
  const to = Math.round(Math.max(range.fromTick, range.toTick));
  return mapLane(project, trackId, target, (points) => {
    const base = (t: number) => (points.length ? automationValueAtTick(points, t) : 1);
    const outside = points.filter((p) => p.tick < from || p.tick > to);
    const inside = points.filter((p) => p.tick > from && p.tick < to);
    // 구간 바로 밖에 원래 값의 점 — 없으면 구간 밖 점에서 구간 끝까지 비스듬히 미끄러진다
    const before = from > 0 && outside.some((p) => p.tick < from) ? [{ tick: from - 1, value: base(from - 1) }] : [];
    const after = outside.some((p) => p.tick > to) ? [{ tick: to + 1, value: base(to + 1) }] : [];
    const edges = [
      ...before,
      { tick: from, value: clamp01(base(from) * factor) },
      ...inside.map((p) => ({ ...p, value: clamp01(p.value * factor) })),
      ...(to > from ? [{ tick: to, value: clamp01(base(to) * factor) }] : []),
      ...after,
    ];
    return [...outside, ...edges].sort((a, b) => a.tick - b.tick);
  });
}

/**
 * 기록 상태기계 — 화면이 재생 중 프레임마다 부른다. 상태를 값으로 주고받아 순수하게 둔다.
 *  - 터치: 손잡이를 잡고 있는 동안만 쓴다
 *  - 래치: 한 번 잡은 뒤로는 재생이 멈출 때까지 마지막 값으로 계속 쓴다
 *  - 쓰기: 재생 내내 쓴다 (안 만져도 지금 값으로 덮는다)
 * 돌려준 `write` 가 있으면 그 구간을 `writeAutomation` 으로 쓴다.
 */
export function recorderStep(
  mode: AutomationMode,
  state: { lastTick: Ticks | null; latched: boolean },
  frame: { tick: Ticks; touching: boolean },
): { next: { lastTick: Ticks | null; latched: boolean }; write: { fromTick: Ticks; toTick: Ticks } | null } {
  const latched = state.latched || (mode === 'latch' && frame.touching);
  // 트림은 터치처럼 잡는 동안만 — 쓰는 방식(곱하기)이 다를 뿐
  const active = mode === 'write' || ((mode === 'touch' || mode === 'trim') && frame.touching) || (mode === 'latch' && latched);
  if (!active) return { next: { lastTick: null, latched }, write: null };
  const fromTick = state.lastTick ?? frame.tick;
  return { next: { lastTick: frame.tick, latched }, write: { fromTick, toTick: frame.tick } };
}

/**
 * 곡선 다듬기 — 이웃 둘을 이은 직선에서 `tolerance` 안에 드는 점을 지운다.
 * 재생 중 기록은 프레임마다 점을 찍어 1초에 60개가 생긴다. 소리는 같고
 * 편집만 어려워지니, 기록이 끝날 때 한 번 정리한다.
 */
export function simplifyLane(project: Project, trackId: TrackId, target: AutomationTarget, tolerance = 0.004): Project {
  return mapLane(project, trackId, target, (points) => {
    if (points.length <= 2) return points;
    const out: AutomationPoint[] = [points[0]!];
    for (let i = 1; i < points.length - 1; i++) {
      const a = out[out.length - 1]!;
      const p = points[i]!;
      const b = points[i + 1]!;
      const span = b.tick - a.tick;
      const expected = span <= 0 ? a.value : a.value + (b.value - a.value) * ((p.tick - a.tick) / span);
      if (Math.abs(expected - p.value) > tolerance) out.push(p);
    }
    out.push(points[points.length - 1]!);
    return out;
  });
}

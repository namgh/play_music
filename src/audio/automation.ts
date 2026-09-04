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

import type { AutomationLane, AutomationPoint, Track } from '../model/project.ts';
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

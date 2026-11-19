/**
 * 스마트 컨트롤 매핑 계산 (`PARITY_ROUND2.md` 15) — 순수 함수.
 * 손잡이 위치 x(0~1) → 대상 값 y(0~1): 곡선(거듭제곱) → 범위 → 거꾸로. 거꾸로 계산도 있다(손잡이 위치를 대상 값에서).
 */

import type { SmartMap } from '../model/project.ts';

const exponent = (curve: number) => Math.pow(2, Math.max(-1, Math.min(1, curve)) * 2);

export function mapKnob(x: number, map: SmartMap | undefined): number {
  const c = Math.max(0, Math.min(1, x));
  const shaped = Math.pow(c, exponent(map?.curve ?? 0));
  const lo = map?.min ?? 0;
  const hi = map?.max ?? 1;
  const y = lo + (hi - lo) * shaped;
  return map?.invert ? 1 - y : y;
}

/** 대상 값(0~1) → 손잡이 위치. 범위 밖이면 끝에 붙인다 */
export function unmapKnob(y: number, map: SmartMap | undefined): number {
  const raw = map?.invert ? 1 - y : y;
  const lo = map?.min ?? 0;
  const hi = map?.max ?? 1;
  if (hi === lo) return 0;
  const shaped = Math.max(0, Math.min(1, (raw - lo) / (hi - lo)));
  return Math.pow(shaped, 1 / exponent(map?.curve ?? 0));
}

export function isIdentity(map: SmartMap | undefined): boolean {
  return !map || ((map.curve ?? 0) === 0 && (map.min ?? 0) === 0 && (map.max ?? 1) === 1 && !map.invert && !(map.extra?.length));
}

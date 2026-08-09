/**
 * 음정 곡선 평가 — **`dsp/src/curve.rs` 의 `cents_at` 을 그대로 옮긴 것**이다.
 *
 * 왜 두 곳에 같은 식이 있나: 소리는 Rust 가 만들고, **화면에 그리는 것은 TS 다.**
 * 그래프가 실제 소리와 다르면 편집 도구로서 최악이다 — 사용자가 그린 모양과
 * 들리는 것이 어긋난다.
 *
 * 그래서 두 구현이 갈라지지 않는 것을 테스트로 고정한다:
 *  - `curve.test.ts` — Rust 쪽 단위 테스트와 같은 성질을 확인한다
 *  - `audio/pitchCurve.test.ts` — **실제 렌더한 파형의 음정 추적치**와 이 함수의
 *    예측을 대조한다. 이쪽이 진짜 방어선이다
 *
 * 자유곡선(`points`)은 **엔진이 지원한다** (`ROADMAP.md` S1-4, `curve_buffer` ABI).
 * 점이 있으면 **글라이드·비브라토를 대신한다** — `plan.md` 5-4 가 "사용자가 그리면
 * `points` 가 우선"이라고 정한 그대로다. 섞으면 그린 모양과 들리는 음정이 달라진다.
 *
 * 정규화 시간을 초로 되돌리려면 **음 길이**가 필요하므로 `durationSec` 을 받는다.
 * 안 주면 자유곡선을 그릴 수 없어 글라이드·비브라토로 떨어진다.
 */

import type { PitchCurve } from './project.ts';

/** 글라이드 시간상수. `glideMs` 에서 약 95% 도달하도록 3으로 나눈다 */
const GLIDE_TAU_DIVISOR = 3;

/**
 * 노트 시작 후 `tSec` 초에서의 음정 오프셋 (센트).
 *
 * 글라이드는 지수적으로 수렴한다 — 손가락이 미끄러져 자리를 잡는 움직임에 가깝고,
 * 선형 램프는 도착 지점에 각이 생겨 기계적으로 들린다.
 */
export function curveCentsAt(
  curve: PitchCurve | null,
  tSec: number,
  durationSec = 0,
): number {
  if (curve === null) return 0;
  if (usesPoints(curve, durationSec)) return pointsCentsAt(curve.points!, tSec, durationSec);
  let cents = 0;

  const glide = curve.glide;
  if (glide && glide.cents !== 0 && glide.ms > 0) {
    const tau = glide.ms / 1000 / GLIDE_TAU_DIVISOR;
    cents += glide.cents * Math.exp(-tSec / tau);
  }

  const vibrato = curve.vibrato;
  if (vibrato && vibrato.cents !== 0 && vibrato.hz > 0) {
    const delay = vibrato.delayMs / 1000;
    if (tSec >= delay) {
      // 위상 0에서 시작하므로 sin(0)=0 → 지연 지점에서 값이 튀지 않는다
      cents += vibrato.cents * Math.sin(2 * Math.PI * vibrato.hz * (tSec - delay));
    }
  }

  return cents;
}

/** 자유곡선이 실제로 쓰이는가. 엔진의 `uses_points` 와 같은 판정이어야 한다 */
export function usesPoints(curve: PitchCurve | null, durationSec: number): boolean {
  return curve !== null && (curve.points?.length ?? 0) > 0 && durationSec > 0;
}

/**
 * 자유곡선을 선형 보간해 읽는다 — 엔진의 `points_cents_at` 과 같아야 한다.
 * 첫 점 앞과 마지막 점 뒤는 **끝점 값을 유지한다** (0 으로 떨어뜨리면 음이 끝에서 튄다).
 */
function pointsCentsAt(
  points: readonly { tNorm: number; cents: number }[],
  tSec: number,
  durationSec: number,
): number {
  // 엔진은 오름차순이 아닌 점을 버린다. 여기서도 같은 순서를 봐야 화면과 소리가 맞는다
  const sorted = [...points].sort((a, b) => a.tNorm - b.tNorm);
  const tNorm = Math.min(1, Math.max(0, tSec / durationSec));
  const first = sorted[0]!;
  if (tNorm <= first.tNorm) return first.cents;

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (tNorm <= b.tNorm) {
      const span = b.tNorm - a.tNorm;
      if (span <= 0) return b.cents;
      return a.cents + (b.cents - a.cents) * ((tNorm - a.tNorm) / span);
    }
  }
  return sorted[sorted.length - 1]!.cents;
}

/** 곡선이 아무 일도 하지 않는가. 엔진의 `is_flat` 과 같은 판정이어야 한다 */
export function isCurveFlat(curve: PitchCurve | null, durationSec = 0): boolean {
  if (curve === null) return true;
  if (usesPoints(curve, durationSec)) return curve.points!.every((p) => p.cents === 0);
  const glideActive = curve.glide !== null && curve.glide.cents !== 0 && curve.glide.ms > 0;
  const vibratoActive = curve.vibrato !== null && curve.vibrato.cents !== 0 && curve.vibrato.hz > 0;
  return !glideActive && !vibratoActive;
}

/** 곡선이 만들 수 있는 최대 편차 (센트). 그래프의 y 축 범위를 잡는 데 쓴다 */
export function curveMaxDeviationCents(curve: PitchCurve | null, durationSec = 0): number {
  if (curve === null) return 0;
  if (usesPoints(curve, durationSec)) {
    return curve.points!.reduce((max, p) => Math.max(max, Math.abs(p.cents)), 0);
  }
  return Math.abs(curve.glide?.cents ?? 0) + Math.abs(curve.vibrato?.cents ?? 0);
}

/**
 * 그래프용 표본. `count` 개를 균일하게 뜬다.
 * 비브라토가 빠를 때 표본이 적으면 에일리어싱된 모양이 보이므로 넉넉히 뜬다.
 */
export function sampleCurve(
  curve: PitchCurve | null,
  durationSec: number,
  count: number,
): { tSec: number; cents: number }[] {
  const out: { tSec: number; cents: number }[] = [];
  const n = Math.max(2, Math.round(count));
  for (let i = 0; i < n; i++) {
    const tSec = (durationSec * i) / (n - 1);
    // 길이를 함께 넘긴다 — 안 넘기면 자유곡선이 그래프에서 조용히 빠진다
    out.push({ tSec, cents: curveCentsAt(curve, tSec, durationSec) });
  }
  return out;
}

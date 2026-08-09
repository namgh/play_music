/**
 * 음정 곡선 평가 회귀 테스트.
 *
 * 이 파일이 지키는 것은 **화면과 소리가 갈라지지 않는 것**이다.
 * `curve.ts` 는 `dsp/src/curve.rs` 의 `cents_at` 을 옮긴 것이고, 아래 성질들은
 * Rust 쪽 단위 테스트(`curve.rs` 의 `mod tests`)와 **같은 것을 확인한다.**
 *
 * 파형과의 대조는 `audio/pitchCurve.test.ts` 가 한다 — 그쪽이 진짜 방어선이다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { curveCentsAt, curveMaxDeviationCents, isCurveFlat, sampleCurve } from './curve.ts';
import type { PitchCurve } from './project.ts';

const curve = (partial: Partial<PitchCurve>): PitchCurve => ({
  glide: null, vibrato: null, points: null, ...partial,
});

test('빈 곡선은 평평하다', () => {
  assert.equal(isCurveFlat(null), true);
  assert.equal(curveCentsAt(null, 0.5), 0);
  assert.equal(isCurveFlat(curve({})), true);
});

test('시간이 0 인 글라이드는 아무 일도 하지 않는다', () => {
  // Rust 의 `is_flat` 과 같은 판정이어야 한다. 어긋나면 화면은 곡선을 그리는데
  // 엔진은 검증된 올패스 경로로 가서 소리에 아무 변화가 없다
  const c = curve({ glide: { cents: 30, ms: 0 } });
  assert.equal(isCurveFlat(c), true);
  assert.equal(curveCentsAt(c, 0), 0);
});

test('폭이 0 인 비브라토도 평평하다', () => {
  assert.equal(isCurveFlat(curve({ vibrato: { cents: 0, hz: 5, delayMs: 0 } })), true);
  assert.equal(isCurveFlat(curve({ vibrato: { cents: 20, hz: 0, delayMs: 0 } })), true);
});

test('글라이드는 시작에서 오프셋이고 지정 시간에 95% 도달한다', () => {
  const c = curve({ glide: { cents: -24, ms: 60 } });
  assert.ok(Math.abs(curveCentsAt(c, 0) - -24) < 1e-9, '시작이 오프셋이 아니다');

  // 시간상수를 ms/3 으로 두므로 ms 에서 약 95% 도달 → 남은 편차가 5% 안쪽
  const left = Math.abs(curveCentsAt(c, 0.06));
  assert.ok(left < 24 * 0.06, `60ms 에서 아직 ${left} 센트 남았다`);
  assert.ok(Math.abs(curveCentsAt(c, 1)) < 1e-6, '1초 뒤에도 안 수렴했다');
});

test('글라이드는 단조 수렴한다 — 도착 지점에 각이 없다', () => {
  const c = curve({ glide: { cents: -200, ms: 120 } });
  let previous = curveCentsAt(c, 0);
  for (let t = 0.005; t <= 0.5; t += 0.005) {
    const now = curveCentsAt(c, t);
    assert.ok(now > previous - 1e-12, `t=${t} 에서 되돌아갔다`);
    previous = now;
  }
});

test('비브라토는 지연 지점에서 이어진다 — 값이 튀면 클릭이다', () => {
  const c = curve({ vibrato: { cents: 20, hz: 5, delayMs: 120 } });
  assert.equal(curveCentsAt(c, 0.119), 0);
  assert.ok(Math.abs(curveCentsAt(c, 0.12)) < 1e-9);
  // 4분의 1주기 뒤 최대
  assert.ok(Math.abs(curveCentsAt(c, 0.12 + 1 / (4 * 5)) - 20) < 1e-6);
});

test('글라이드와 비브라토는 더해진다', () => {
  const c = curve({
    glide: { cents: -20, ms: 50 },
    vibrato: { cents: 10, hz: 5, delayMs: 0 },
  });
  // t=0: 글라이드 -20, 비브라토 sin(0)=0
  assert.ok(Math.abs(curveCentsAt(c, 0) - -20) < 1e-9);
  assert.equal(curveMaxDeviationCents(c), 30);
});

test('온음(200센트) 글라이드가 된다 — "도에서 래까지"', () => {
  // 차별점 ①의 실제 요구. FL Studio 는 10센트 단위, Cubase 는 센트 입력 자체가 없다
  const c = curve({ glide: { cents: 200, ms: 150 } });
  assert.equal(isCurveFlat(c), false);
  assert.ok(Math.abs(curveCentsAt(c, 0) - 200) < 1e-9, '시작이 온음 위가 아니다');
  assert.ok(Math.abs(curveCentsAt(c, 0.6)) < 1, '목표 음정에 도달하지 않았다');
});

test('자유곡선(points)은 무시한다 — 엔진이 아직 지원하지 않는다', () => {
  // 지원하는 척하면 화면에는 그려지고 소리에는 없는 상태가 된다
  const c = curve({ points: [{ tNorm: 0, cents: 300 }, { tNorm: 1, cents: 0 }] });
  assert.equal(isCurveFlat(c), true);
  assert.equal(curveCentsAt(c, 0), 0);
});

test('표본은 양 끝을 포함하고 개수가 맞는다', () => {
  const c = curve({ glide: { cents: 100, ms: 100 } });
  const s = sampleCurve(c, 0.5, 5);
  assert.equal(s.length, 5);
  assert.equal(s[0]!.tSec, 0);
  assert.ok(Math.abs(s[4]!.tSec - 0.5) < 1e-12, '마지막 표본이 끝에 없다');
  assert.ok(Math.abs(s[0]!.cents - 100) < 1e-9);
});

test('표본 개수가 2 미만이면 2 로 올린다 — 선을 못 그린다', () => {
  assert.equal(sampleCurve(null, 1, 0).length, 2);
  assert.equal(sampleCurve(null, 1, 1).length, 2);
});

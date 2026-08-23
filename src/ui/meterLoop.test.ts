/**
 * 미터 눈금.
 *
 * 여기가 틀리면 증상이 조용하다 — 막대는 움직이지만 **엉뚱한 자리**를 가리키고,
 * 사용자는 그걸 믿고 페이더를 잡는다. 소리가 아니라 눈금이 거짓말하는 쪽이라
 * 알아채기 더 어렵다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { METER_FLOOR_DB, meterPosition } from './meterLoop.ts';

const db = (value: number) => Math.pow(10, value / 20);

test('0 dBFS 가 꼭대기, 바닥 아래는 0', () => {
  assert.equal(meterPosition(1), 1);
  assert.equal(meterPosition(db(METER_FLOOR_DB)), 0);
  assert.equal(meterPosition(db(METER_FLOOR_DB - 20)), 0);
  assert.equal(meterPosition(0), 0);
});

test('넘쳐도 꼭대기를 벗어나지 않는다', () => {
  // 막대가 칸 밖으로 나가면 레이아웃이 밀린다. 넘쳤다는 사실은 빨간 점이 알린다
  assert.equal(meterPosition(2), 1);
  assert.equal(meterPosition(40), 1);
});

test('dB 로 편다 — 선형이 아니다', () => {
  // **이게 이 파일에서 가장 중요한 시험이다.** 선형으로 그리면 판단해야 하는
  // -20~-6dB 구간이 막대 아래쪽 10%에 뭉쳐서, 정작 볼 것을 못 본다
  const half = meterPosition(db(METER_FLOOR_DB / 2)); // -30dB = 눈금 한가운데
  assert.ok(Math.abs(half - 0.5) < 1e-9, `-30dB 가 ${half} 에 있다`);

  const linear = 0.5; // 진폭 절반 = -6dB
  assert.ok(
    meterPosition(linear) > 0.85,
    `-6dB 가 ${meterPosition(linear).toFixed(3)} — 선형이면 0.5 근처였을 것이다`,
  );
});

test('커질수록 단조증가한다', () => {
  let previous = -1;
  for (const amplitude of [0, 0.0005, 0.001, 0.01, 0.05, 0.2, 0.5, 0.9, 1]) {
    const at = meterPosition(amplitude);
    assert.ok(at >= previous, `${amplitude} 에서 눈금이 거꾸로 갔다`);
    previous = at;
  }
});

test('이상한 값에도 눈금 안에 머문다', () => {
  // 분석 노드가 NaN 을 줄 일은 없어야 하지만, 미터가 레이아웃을 깨뜨리면 안 된다
  for (const bad of [Number.NaN, -1, -Infinity, Infinity]) {
    const at = meterPosition(bad);
    assert.ok(at >= 0 && at <= 1, `${bad} → ${at}`);
  }
});

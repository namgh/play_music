/**
 * 음악적 시간 회귀 테스트.
 *
 * 핵심 확인: **BPM 을 바꿔도 틱이 변하지 않는다.** 초로 저장했다면 여기서 깨진다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PPQ, quantize, secondsToTicks, ticksPerBar, ticksPerBeat, ticksToBarBeat, ticksToSeconds,
} from './time.ts';

test('4/4 한 마디 = 4분음표 4개', () => {
  const ts = { num: 4, den: 4 };
  assert.equal(ticksPerBeat(ts), PPQ);
  assert.equal(ticksPerBar(ts), PPQ * 4);
});

test('6/8 은 8분음표가 한 박', () => {
  const ts = { num: 6, den: 8 };
  assert.equal(ticksPerBeat(ts), PPQ / 2);
  assert.equal(ticksPerBar(ts), PPQ * 3);
});

test('PPQ 가 셋잇단과 이진 분할을 모두 정수로 나눈다', () => {
  // 이 값을 고른 이유. 여기서 소수가 나오면 퀀타이즈가 어긋난다
  for (const div of [2, 3, 4, 5, 6, 8, 12, 16, 32, 64]) {
    assert.equal(PPQ % div, 0, `PPQ 가 ${div} 로 나누어지지 않는다`);
  }
});

test('BPM 을 바꿔도 틱은 그대로, 초만 변한다', () => {
  const oneBar = ticksPerBar({ num: 4, den: 4 });
  assert.equal(ticksToSeconds(oneBar, { bpm: 120 }), 2);
  assert.equal(ticksToSeconds(oneBar, { bpm: 60 }), 4);
  assert.equal(ticksToSeconds(oneBar, { bpm: 240 }), 1);
  // 틱 값 자체는 BPM 과 무관하다 — 초로 저장하면 이 성질이 없다
  assert.equal(oneBar, PPQ * 4);
});

test('틱 ↔ 초 왕복', () => {
  for (const bpm of [60, 92, 120, 174]) {
    for (const ticks of [0, 1, PPQ, PPQ * 7 + 13, 123457]) {
      const round = secondsToTicks(ticksToSeconds(ticks, { bpm }), { bpm });
      assert.ok(Math.abs(round - ticks) < 1e-9, `${bpm}BPM ${ticks}틱 왕복 오차`);
    }
  }
});

test('마디·박 표시는 1부터 센다', () => {
  const ts = { num: 4, den: 4 };
  assert.deepEqual(ticksToBarBeat(0, ts), { bar: 1, beat: 1, fraction: 0 });
  assert.deepEqual(ticksToBarBeat(PPQ, ts), { bar: 1, beat: 2, fraction: 0 });
  assert.deepEqual(ticksToBarBeat(PPQ * 4, ts), { bar: 2, beat: 1, fraction: 0 });
  assert.deepEqual(ticksToBarBeat(PPQ * 4.5, ts), { bar: 2, beat: 1, fraction: 0.5 });
});

test('퀀타이즈', () => {
  const sixteenth = PPQ / 4;
  assert.equal(quantize(0, sixteenth), 0);
  assert.equal(quantize(sixteenth - 1, sixteenth), sixteenth);
  assert.equal(quantize(sixteenth / 2 - 1, sixteenth), 0);
  // 그리드 0 은 아무것도 하지 않는다 (퀀타이즈 끈 상태)
  assert.equal(quantize(1234, 0), 1234);
});

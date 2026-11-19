/**
 * 음악적 시간 회귀 테스트.
 *
 * 핵심 확인: **BPM 을 바꿔도 틱이 변하지 않는다.** 초로 저장했다면 여기서 깨진다.
 */

import type { Tempo } from './time.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PPQ, quantize, secondsToTicks, tempoSegments, ticksPerBar, ticksPerBeat, ticksToBarBeat, ticksToSeconds } from './time.ts';

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

// --- 템포 변화 (ROADMAP.md P2) ----------------------------------------------

const withChanges: Tempo = { bpm: 120, changes: [{ tick: 4 * PPQ, bpm: 60 }] };

test('템포 변화가 없으면 예전과 똑같다', () => {
  const flat: Tempo = { bpm: 90 };
  for (const ticks of [0, PPQ, 7 * PPQ, 123]) {
    assert.equal(ticksToSeconds(ticks, flat), (ticks / PPQ) * (60 / 90));
  }
});

test('템포가 바뀌면 그 지점부터 다른 속도로 흐른다', () => {
  // 120BPM 4박 = 2초, 그 뒤 60BPM 4박 = 4초
  assert.ok(Math.abs(ticksToSeconds(4 * PPQ, withChanges) - 2) < 1e-9);
  assert.ok(Math.abs(ticksToSeconds(8 * PPQ, withChanges) - 6) < 1e-9);
});

test('마지막 템포만 쓰면 앞부분이 밀린다 — 그러지 않는다', () => {
  // 60BPM 만 썼다면 8박이 8초다. 누적하면 6초가 맞다
  const naive = (8 * PPQ / PPQ) * (60 / 60);
  assert.notEqual(ticksToSeconds(8 * PPQ, withChanges), naive);
});

test('초↔틱이 왕복한다', () => {
  for (const ticks of [0, PPQ, 4 * PPQ, 6 * PPQ, 10 * PPQ, 1234]) {
    const back = secondsToTicks(ticksToSeconds(ticks, withChanges), withChanges);
    assert.ok(Math.abs(back - ticks) < 1e-6, `${ticks} → ${back}`);
  }
});

test('구간을 정리한다 — 순서·음수·0BPM', () => {
  const messy: Tempo = {
    bpm: 100,
    changes: [
      { tick: 8 * PPQ, bpm: 80 },
      { tick: 2 * PPQ, bpm: 140 },
      { tick: -5, bpm: 200 },      // 음수 틱은 버린다
      { tick: 4 * PPQ, bpm: 0 },   // 0 BPM 은 시간이 안 흐른다
    ],
  };
  const segments = tempoSegments(messy);
  assert.deepEqual(segments.map((s) => s.tick), [0, 2 * PPQ, 8 * PPQ]);
  assert.deepEqual(segments.map((s) => s.bpm), [100, 140, 80]);
});

test('같은 틱에 두 번 바뀌면 뒤엣것만 남는다', () => {
  const dup: Tempo = { bpm: 100, changes: [{ tick: PPQ, bpm: 90 }, { tick: PPQ, bpm: 70 }] };
  const segments = tempoSegments(dup);
  assert.equal(segments.length, 2);
  assert.equal(segments[1]!.bpm, 70);
});

test('템포 램프 — 적분한 시간, 왕복, 가운데 BPM', async () => {
  const { ticksToSeconds, secondsToTicks, bpmAt, PPQ } = await import('./time.ts');
  // 0~4박 120 → 4박에서 60 으로 서서히 → 이후 60
  const tempo = { bpm: 120, changes: [{ tick: PPQ * 4, bpm: 60, ramp: true }] };
  // 4박 램프 = (60/PPQ)·L/(b1−b0)·ln(b1/b0) = 60·4/(−60)·ln(0.5) = 2.7726초
  assert.ok(Math.abs(ticksToSeconds(PPQ * 4, tempo) - 4 * Math.log(2)) < 1e-9);
  // 그 뒤는 60 BPM — 1박 = 1초
  assert.ok(Math.abs(ticksToSeconds(PPQ * 5, tempo) - (4 * Math.log(2) + 1)) < 1e-9);
  for (const t of [0, 100, PPQ, PPQ * 2.5, PPQ * 4, PPQ * 7]) {
    assert.ok(Math.abs(secondsToTicks(ticksToSeconds(t, tempo), tempo) - t) < 1e-6, `왕복 ${t}`);
  }
  assert.equal(bpmAt(PPQ * 2, tempo), 90);
  assert.equal(bpmAt(PPQ * 6, tempo), 60);
});

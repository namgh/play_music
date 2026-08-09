import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampRange, hiddenNoteCount, isPlayable, MIDI_MAX, MIDI_MIN, midiAfterRowShift, MIN_SPAN,
  rangeOfNotes, rowIndexOf, visibleRows,
} from './noteRange.ts';

test('정상 범위는 그대로 둔다', () => {
  assert.deepEqual(clampRange({ low: 36, high: 72 }), { low: 36, high: 72 });
});

test('뒤집힌 입력을 정렬한다', () => {
  // 사용자가 위아래를 거꾸로 고를 수 있다
  assert.deepEqual(clampRange({ low: 72, high: 36 }), { low: 36, high: 72 });
});

test('MIDI 범위를 벗어나지 않는다', () => {
  const low = clampRange({ low: -30, high: 20 });
  assert.ok(low.low >= MIDI_MIN);
  const high = clampRange({ low: 100, high: 400 });
  assert.ok(high.high <= MIDI_MAX);
});

test('너무 좁으면 최소 폭을 확보한다', () => {
  const r = clampRange({ low: 60, high: 62 });
  assert.ok(r.high - r.low >= MIN_SPAN, `폭이 ${r.high - r.low} 밖에 안 된다`);
});

test('방금 만진 쪽을 존중하고 반대쪽을 민다', () => {
  // 사용자가 아래를 60 으로 올렸으면 60 이 유지돼야 한다. 튕겨 나가면 조작이
  // 안 먹히는 것처럼 느껴진다
  const movedLow = clampRange({ low: 60, high: 62 }, 'low');
  assert.equal(movedLow.low, 60);
  assert.equal(movedLow.high, 60 + MIN_SPAN);

  const movedHigh = clampRange({ low: 60, high: 62 }, 'high');
  assert.equal(movedHigh.high, 62);
  assert.equal(movedHigh.low, 62 - MIN_SPAN);
});

test('천장·바닥에서는 반대쪽으로 민다', () => {
  const top = clampRange({ low: MIDI_MAX - 2, high: MIDI_MAX }, 'low');
  assert.equal(top.high, MIDI_MAX);
  assert.equal(top.high - top.low, MIN_SPAN);

  const bottom = clampRange({ low: MIDI_MIN, high: MIDI_MIN + 2 }, 'high');
  assert.equal(bottom.low, MIDI_MIN);
  assert.equal(bottom.high - bottom.low, MIN_SPAN);
});

test('음에 맞추면 위아래로 여유가 생긴다', () => {
  // 음이 맨 끝 줄에 붙어 있으면 위로 옮길 자리가 없다
  const r = rangeOfNotes([60, 64, 67], { low: 0, high: 127 }, 2);
  assert.equal(r.low, 58);
  assert.ok(r.high >= 69);
});

test('음이 없으면 기본값을 쓴다', () => {
  assert.deepEqual(rangeOfNotes([], { low: 40, high: 80 }), { low: 40, high: 80 });
});

test('한 음만 있어도 최소 폭을 지킨다', () => {
  const r = rangeOfNotes([60], { low: 0, high: 127 });
  assert.ok(r.high - r.low >= MIN_SPAN);
  assert.ok(r.low <= 60 && r.high >= 60, '그 음이 안 보인다');
});

test('안 보이는 음을 센다', () => {
  // 음역을 좁혔을 때 음이 조용히 사라지면 사용자가 원인을 못 찾는다
  const midis = [40, 60, 64, 90];
  assert.equal(hiddenNoteCount(midis, { low: 48, high: 72 }), 2);
  assert.equal(hiddenNoteCount(midis, { low: 0, high: 127 }), 0);
});

test('악기가 낼 수 있는 범위는 표시 음역과 다른 개념이다', () => {
  // 베이스 트랙의 표시 음역을 넓혀도 베이스가 C8 을 내지는 못한다
  const bass = { low: 28, high: 67 };
  assert.equal(isPlayable(40, bass), true);
  assert.equal(isPlayable(100, bass), false);
});

// ---------------------------------------------------------------------------
// 접기
// ---------------------------------------------------------------------------

const RANGE = { low: 60, high: 72 };

test('접지 않으면 범위 전체가 높은 음부터 나온다', () => {
  const rows = visibleRows(RANGE, 'off', [], null);
  assert.equal(rows.length, 13);
  assert.equal(rows[0], 72, '높은 음이 먼저 와야 한다');
  assert.equal(rows.at(-1), 60);
});

test('음이 있는 줄만 접는다', () => {
  const rows = visibleRows(RANGE, 'notes', [60, 64, 67], null);
  assert.deepEqual(rows, [67, 64, 60]);
});

test('범위 밖의 음은 줄을 만들지 않는다', () => {
  const rows = visibleRows(RANGE, 'notes', [40, 64, 100], null);
  assert.deepEqual(rows, [64]);
});

test('접을 음이 없으면 전체로 되돌린다 — 편집기가 잠기면 안 된다', () => {
  // 빈 클립에서 접으면 줄이 하나도 없어 음을 추가할 곳이 사라진다
  assert.equal(visibleRows(RANGE, 'notes', [], null).length, 13);
  assert.equal(visibleRows(RANGE, 'notes', [200], null).length, 13);
});

test('스케일로 접으면 조성 음만 남는다', () => {
  const rows = visibleRows(RANGE, 'scale', [], { tonic: 'C', mode: 'major' });
  // C4~C5 의 흰 건반 = C D E F G A B C
  assert.deepEqual(rows, [72, 71, 69, 67, 65, 64, 62, 60]);
});

test('스케일 밖이지만 음이 있는 줄은 남긴다', () => {
  // 감추면 그 음을 고칠 방법이 없어진다 (Ableton 과 같은 규칙)
  const rows = visibleRows(RANGE, 'scale', [61, 66], { tonic: 'C', mode: 'major' });
  assert.ok(rows.includes(61), 'C# 음이 있는데 줄이 감춰졌다');
  assert.ok(rows.includes(66), 'F# 음이 있는데 줄이 감춰졌다');
  assert.ok(!rows.includes(63), '음도 없고 스케일도 아닌 줄이 남았다');
});

test('조성이 없으면 스케일 접기는 아무것도 안 한다', () => {
  assert.equal(visibleRows(RANGE, 'scale', [], null).length, 13);
});

test('줄 인덱스를 찾는다', () => {
  const rows = visibleRows(RANGE, 'notes', [60, 64, 67], null);
  assert.equal(rowIndexOf(rows, 67), 0);
  assert.equal(rowIndexOf(rows, 60), 2);
  assert.equal(rowIndexOf(rows, 62), -1, '안 보이는 줄이 인덱스를 받았다');
});

test('접힌 상태의 세로 이동은 보이는 줄 단위다', () => {
  // 반음으로 계산하면 안 보이는 줄로 음이 사라진다
  const rows = visibleRows(RANGE, 'notes', [60, 64, 67], null); // [67, 64, 60]
  assert.equal(midiAfterRowShift(rows, 60, -1), 64, '한 줄 위가 64 여야 한다');
  assert.equal(midiAfterRowShift(rows, 64, -1), 67);
  assert.equal(midiAfterRowShift(rows, 67, 2), 60);
});

test('세로 이동은 목록 양 끝에서 멈춘다', () => {
  const rows = visibleRows(RANGE, 'notes', [60, 64, 67], null);
  assert.equal(midiAfterRowShift(rows, 67, -5), 67, '위로 넘어갔다');
  assert.equal(midiAfterRowShift(rows, 60, 5), 60, '아래로 넘어갔다');
});

test('접지 않은 상태에서는 한 줄이 한 반음이다', () => {
  const rows = visibleRows(RANGE, 'off', [], null);
  assert.equal(midiAfterRowShift(rows, 64, -1), 65);
  assert.equal(midiAfterRowShift(rows, 64, 3), 61);
});

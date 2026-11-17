/**
 * 자판 연주 배치 (`LOGIC_PARITY.md` 1-6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyLabelFor, typingAction } from './musicalTyping.ts';

test('가운데 줄이 흰 건반, 윗줄이 검은 건반 — 옥타브 4 의 A 는 C4(60)', () => {
  assert.deepEqual(typingAction('KeyA', 4), { kind: 'note', midi: 60 });
  assert.deepEqual(typingAction('KeyW', 4), { kind: 'note', midi: 61 });
  assert.deepEqual(typingAction('KeyK', 4), { kind: 'note', midi: 72 });
  assert.deepEqual(typingAction('KeyZ', 4), { kind: 'octave', delta: -1 });
  assert.deepEqual(typingAction('KeyV', 4), { kind: 'velocity', delta: 1 });
  assert.equal(typingAction('KeyQ', 4), null, '배치에 없는 키는 아무 일도 안 한다');
  assert.equal(typingAction('Quote', 9), null, 'MIDI 범위 밖');
});

test('건반 위 글자', () => {
  assert.equal(keyLabelFor(60, 4), 'A');
  assert.equal(keyLabelFor(76, 4), ';');
  assert.equal(keyLabelFor(59, 4), null);
});

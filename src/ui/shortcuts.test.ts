/**
 * 단축키 (`LOGIC_PARITY.md` 1-16).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultBindings, findConflicts, formatBinding, rebind, resolveCommand } from './shortcuts.ts';
import { diffBindings } from './settings.ts';

const ev = (code: string, mods: Partial<{ metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }> = {}) =>
  ({ code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

test('기본 단축키 — 위치(code)로 맞춘다, 한글 입력 상태와 상관없음', () => {
  const b = defaultBindings();
  assert.equal(resolveCommand(b, ev('KeyS', { metaKey: true })), 'save');
  assert.equal(resolveCommand(b, ev('KeyS', { ctrlKey: true })), 'save', 'Ctrl 도 ⌘ 로 본다 (윈도우)');
  assert.equal(resolveCommand(b, ev('KeyZ', { metaKey: true, shiftKey: true })), 'redo');
  assert.equal(resolveCommand(b, ev('KeyZ', { metaKey: true })), 'undo');
  assert.equal(resolveCommand(b, ev('ArrowUp', { shiftKey: true })), 'octaveUp');
  assert.equal(resolveCommand(b, ev('Delete')), 'delete');
  assert.equal(resolveCommand(b, ev('ShiftLeft', { shiftKey: true })), null);
  assert.equal(resolveCommand(b, ev('KeyQ')), null);
});

test('기본값에 겹치는 키가 없다', () => {
  assert.deepEqual(findConflicts(defaultBindings()), []);
});

test('바꾸기 — 같은 키를 쓰던 명령에서는 빠지고, 저장은 바뀐 것만', () => {
  let b = rebind(defaultBindings(), 'metronome', { code: 'Space' });
  assert.equal(resolveCommand(b, ev('Space')), 'metronome');
  assert.deepEqual(b.play, [], '재생에서 Space 가 빠졌다');
  assert.deepEqual(findConflicts(b), []);
  assert.deepEqual(Object.keys(diffBindings(b)).sort(), ['metronome', 'play']);
  b = rebind(b, 'play', { code: 'Enter' });
  assert.equal(formatBinding({ code: 'KeyZ', meta: true, shift: true }), '⌘⇧Z');
  assert.equal(formatBinding({ code: 'Comma', alt: true }), '⌥,');
});

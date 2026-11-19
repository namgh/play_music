import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseScreensets, screensetSlot } from './screensets.ts';

test('스크린셋 — 칸 번호·읽기(이상한 값은 버린다)', () => {
  assert.equal(screensetSlot('Digit3'), 3);
  assert.equal(screensetSlot('Digit0'), null);
  assert.equal(screensetSlot('KeyA'), null);
  const sets = parseScreensets({ 1: { view: 'mixer', editorView: 'score', sideTab: 'browse', playOpen: true }, 2: { view: 'nope' }, 12: { view: 'editor' }, 3: { view: 'editor', editorView: 'x' } });
  assert.deepEqual(Object.keys(sets), ['1', '3']);
  assert.equal(sets[1]!.editorView, 'score');
  assert.equal(sets[3]!.editorView, 'roll');
});

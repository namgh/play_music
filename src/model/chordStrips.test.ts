import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bassNote, diatonicChords, voiceChord } from './chords.ts';

test('코드 스트립 — 조성의 1~7도', () => {
  assert.deepEqual(diatonicChords({ tonic: 'C', mode: 'major' }).map((c) => c.label), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
  assert.deepEqual(diatonicChords({ tonic: 'A', mode: 'minor' }).map((c) => c.label), ['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
  assert.deepEqual(diatonicChords({ tonic: 'C', mode: 'major' }, true).slice(0, 5).map((c) => c.label), ['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7']);
  assert.equal(diatonicChords({ tonic: 'C', mode: 'major' })[1]!.degree, 'ii');
});

test('보이싱 — 구성음이 가운데 한 옥타브 안, 베이스는 낮게', () => {
  const g = voiceChord(7, 'maj'); // G = G B D
  assert.deepEqual(g.map((m) => m % 12).sort((a, b) => a - b), [2, 7, 11]);
  assert.ok(Math.max(...g) - Math.min(...g) < 12);
  assert.ok(g.every((m) => m >= 54 && m < 66));
  assert.equal(bassNote(7), 43);
});

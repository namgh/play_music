import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isIdentity, mapKnob, unmapKnob } from './smartMap.ts';
import { roundTrip } from '../model/persistence.ts';
import { createEmptyProject, createTrack } from '../model/factory.ts';

test('매핑 — 곧게·곡선·범위·거꾸로, 되돌리기', () => {
  assert.equal(mapKnob(0.5, undefined), 0.5);
  assert.ok(mapKnob(0.5, { curve: 1 }) < 0.1, '끝에서 빨리');
  assert.ok(mapKnob(0.5, { curve: -1 }) > 0.8, '처음에 빨리');
  assert.equal(mapKnob(1, { min: 0.2, max: 0.6 }), 0.6);
  assert.equal(mapKnob(0, { invert: true }), 1);
  for (const m of [{ curve: 0.7, min: 0.1, max: 0.9 }, { curve: -0.4, invert: true }]) {
    for (const x of [0, 0.3, 0.77, 1]) assert.ok(Math.abs(unmapKnob(mapKnob(x, m), m) - x) < 1e-9);
  }
  assert.equal(isIdentity({}), true);
  assert.equal(isIdentity({ extra: ['pan'] }), false);
});

test('매핑 저장', () => {
  const p = createEmptyProject('m');
  const t = createTrack({ name: 'a', instrumentId: 'kick' });
  t.smartControls = ['volume'];
  t.smartMaps = [{ curve: 0.5, min: 0.1, invert: true, extra: ['pan', 'fx:0:mix'] }];
  p.tracks.push(t);
  assert.deepEqual(roundTrip(p).tracks[0]!.smartMaps, [{ curve: 0.5, min: 0.1, invert: true, extra: ['pan', 'fx:0:mix'] }]);
});

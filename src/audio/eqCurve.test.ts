import { test } from 'node:test';
import assert from 'node:assert/strict';

import { eqCurveDb } from './eqCurve.ts';
import { createEffect, resolveEffectParams } from './effects.ts';

const at = (c: { hz: number[]; db: number[] }, f: number) => {
  let best = 0;
  for (let i = 0; i < c.hz.length; i++) if (Math.abs(Math.log(c.hz[i]! / f)) < Math.abs(Math.log(c.hz[best]! / f))) best = i;
  return c.db[best]!;
};

test('EQ 곡선 — 꺼진 채널 EQ 는 평탄, 피크는 그 자리에서 그만큼', () => {
  const flat = eqCurveDb('channeleq', resolveEffectParams(createEffect('channeleq')));
  assert.ok(flat.db.every((v) => Math.abs(v) < 0.01));
  const p = { ...resolveEffectParams(createEffect('channeleq')), p2Db: 6 };
  const c = eqCurveDb('channeleq', p, 400);
  assert.ok(Math.abs(at(c, 800) - 6) < 0.3, `${at(c, 800)}`);
  const cut = eqCurveDb('channeleq', { ...p, lowCutHz: 200 }, 400);
  assert.ok(at(cut, 40) < -20);
});

test('틸트 EQ 곡선 — 양 끝이 반대로', () => {
  const c = eqCurveDb('tilteq', { centerHz: 800, tiltDb: 6, outputDb: 0 });
  assert.ok(c.db[0]! < -2.5 && c.db[c.db.length - 1]! > 2.5);
});

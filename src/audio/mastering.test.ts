/**
 * 마스터링 도우미 (`LOGIC_PARITY.md` 1-12) — 잰 값 → 규칙.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeMix, suggestMaster } from './mastering.ts';

const SR = 48000;
function tone(freqs: [number, number][], sec = 4): Float32Array {
  const x = new Float32Array(SR * sec);
  for (let i = 0; i < x.length; i++) for (const [f, a] of freqs) x[i]! += a * Math.sin((2 * Math.PI * f * i) / SR);
  return x;
}

test('저역이 무거운 믹스 — 낮은 선반을 깎자고 한다, 고역 없으면 올리자고 한다', () => {
  const heavy = tone([[60, 0.5], [500, 0.05]]);
  const a = analyzeMix([heavy, heavy], SR);
  assert.ok(a.lowVsMid > 10, String(a.lowVsMid));
  const s = suggestMaster(a, 'streaming');
  assert.ok((s.effects[0]!.params.lowGainDb as number) < 0);
  assert.ok((s.effects[0]!.params.highGainDb as number) > 0);
  assert.deepEqual(s.effects.map((e) => e.type), ['eq', 'compressor', 'limiter']);
  assert.equal(s.effects[2]!.params.ceilingDb, -1);
});

test('조용한 믹스는 리미터로 목표까지 민다, 큰 믹스는 밀지 않는다', () => {
  const quiet = tone([[220, 0.02], [880, 0.01]]);
  const q = suggestMaster(analyzeMix([quiet, quiet], SR), 'streaming');
  assert.ok((q.effects[2]!.params.inputDb as number) > 6);
  const loud = tone([[220, 0.9]]);
  const l = suggestMaster(analyzeMix([loud, loud], SR), 'streaming');
  assert.equal(l.effects[2]!.params.inputDb, 0);
  assert.ok(l.reasons.some((r) => r.includes('이미 목표보다')));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { expressionParams, muteParams } from './articulation.ts';

test('mute 0 이면 원래 값 그대로다 — 예전과 같은 소리', () => {
  const p = muteParams(0, 0.05, 3);
  assert.equal(p.damping, 0.05);
  assert.equal(p.sustainSec, 3);
});

test('mute 1 이면 뮤트 목표값에 도달한다', () => {
  const p = muteParams(1, 0.05, 3);
  assert.ok(Math.abs(p.damping - 0.22) < 1e-9);
  assert.ok(Math.abs(p.sustainSec - 0.35) < 1e-9);
});

test('중간값은 선형 보간된다', () => {
  const p = muteParams(0.5, 0.05, 3);
  assert.ok(Math.abs(p.damping - (0.05 + (0.22 - 0.05) * 0.5)) < 1e-9);
  assert.ok(Math.abs(p.sustainSec - (3 + (0.35 - 3) * 0.5)) < 1e-9);
});

test('범위 밖 mute 값은 0~1 로 잘린다', () => {
  assert.deepEqual(muteParams(-1, 0.05, 3), muteParams(0, 0.05, 3));
  assert.deepEqual(muteParams(5, 0.05, 3), muteParams(1, 0.05, 3));
});

test('악기 기본값이 이미 뮤트 목표보다 어둡거나 짧으면 되레 풀어 주지 않는다', () => {
  const p = muteParams(1, 0.24, 0.32); // 이미 damping·sustainSec 둘 다 목표를 넘어섬
  assert.equal(p.damping, 0.24);
  assert.equal(p.sustainSec, 0.32);
});

test('expressionParams — waveguide-string 이 아니면 신스의 damping 을 안 건드린다', () => {
  assert.deepEqual(
    expressionParams('virtual-analog', { mute: 1 }, { damping: 0.8, sustainSec: 1200 }),
    {},
  );
});

test('expressionParams — mute 가 없거나 0 이면 빈 객체', () => {
  assert.deepEqual(expressionParams('waveguide-string', null, { damping: 0.05 }), {});
  assert.deepEqual(expressionParams('waveguide-string', { mute: 0 }, { damping: 0.05 }), {});
});

test('expressionParams — waveguide-string + mute 면 damping·sustainSec 을 돌려준다', () => {
  const p = expressionParams('waveguide-string', { mute: 1 }, { damping: 0.05, sustainSec: 3 });
  assert.ok(Math.abs(p.damping! - 0.22) < 1e-9);
  assert.ok(Math.abs(p.sustainSec! - 0.35) < 1e-9);
});

test('expressionParams — 기본 params 에 damping·sustainSec 이 없으면 상식적인 기본값을 쓴다', () => {
  const p = expressionParams('waveguide-string', { mute: 1 }, {});
  assert.ok(Number.isFinite(p.damping));
  assert.ok(Number.isFinite(p.sustainSec));
});

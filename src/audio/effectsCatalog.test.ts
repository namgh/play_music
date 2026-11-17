/**
 * 이펙트 목록 — 선언·빌더·오토메이션 대상이 서로 맞는가 (`LOGIC_PARITY.md` 1-12).
 * 노드를 만드는 부분은 브라우저에서만 돌아서 `npm run check:browser` 가 본다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEffect, distortionCurve, EFFECT_SPECS, resolveEffectParams } from './effects.ts';
import type { EffectType } from './effects.ts';
import { automationTargets } from './automation.ts';
import { createTrack } from '../model/factory.ts';

const TYPES = Object.keys(EFFECT_SPECS) as EffectType[];

test('이펙트 13종 — 기본값이 범위 안이고 그대로 해석된다', () => {
  assert.equal(TYPES.length, 13);
  for (const type of TYPES) {
    const fx = createEffect(type);
    const resolved = resolveEffectParams(fx);
    for (const [key, spec] of Object.entries(EFFECT_SPECS[type].params)) {
      assert.ok(spec.min <= spec.default && spec.default <= spec.max, `${type}.${key} 기본값이 범위 밖`);
      assert.equal(resolved[key], spec.default);
      if (spec.curve === 'log') assert.ok(spec.min > 0, `${type}.${key} 로그 곡선은 0 보다 커야 한다`);
    }
  }
});

test('오토메이션 대상은 선언된 파라미터만', () => {
  const track = createTrack({ name: 't', instrumentId: 'kick' });
  track.effects = TYPES.map((type) => createEffect(type));
  const targets = automationTargets(track).map((t) => t.target).filter((t) => t.startsWith('fx:'));
  assert.ok(targets.length >= 30);
  for (const target of targets) {
    const [, index, name] = target.split(':');
    const type = track.effects[Number(index)]!.type as EffectType;
    assert.ok(name! in EFFECT_SPECS[type].params, `${target} 는 ${type} 에 없는 파라미터`);
  }
});

test('디스토션 곡선 — ±1 안, 0 은 0, 단조 증가, 드라이브를 올리면 더 일찍 포화', () => {
  for (const drive of [0, 12, 40]) {
    const c = distortionCurve(drive, 1025);
    assert.ok(Math.abs(c[512]!) < 1e-6, '가운데(입력 0)는 출력 0');
    for (let i = 1; i < c.length; i++) assert.ok(c[i]! >= c[i - 1]! - 1e-9, '단조 증가');
    assert.ok(Math.max(...c) <= 1 + 1e-6 && Math.min(...c) >= -1 - 1e-6, '±1 안');
  }
  const soft = distortionCurve(0, 1025)[640]!;
  const hard = distortionCurve(24, 1025)[640]!;
  assert.ok(hard > soft, '같은 입력에서 드라이브가 크면 더 크게');
});

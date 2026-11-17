/**
 * Rust 이펙트 — TS 선언과 fx.wasm 이 서로 맞는가, 그리고 wasm 이 실제로 소리를 바꾸는가.
 * (`npm run build:fx` 가 먼저 돌아 있어야 한다 — `npm test` 가 그렇게 한다)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RUST_EFFECT_SPECS, RUST_PARAM_SLOTS } from './rustEffects.ts';
import type { RustEffectType } from './rustEffects.ts';
import { createEffect, EFFECT_SPECS, resolveEffectParams } from './effects.ts';
import { declaredLatency, FxWasm } from './fxWasm.ts';

const module = new WebAssembly.Module(readFileSync(new URL('../generated/fx.wasm', import.meta.url)));
const TYPES = Object.keys(RUST_EFFECT_SPECS) as RustEffectType[];
const SR = 48000;

const sine = (freq: number, n: number, amp: number) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR));
const peak = (x: Float32Array, from = 0) => { let m = 0; for (let i = from; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!)); return m; };

test('Rust 목록 = TS 목록 (순서까지)', async () => {
  assert.deepEqual(await FxWasm.kindNames(module), TYPES);
});

test('선언 — 슬롯 수 안, 기본값이 범위 안, 고르기는 정수 범위', () => {
  for (const type of TYPES) {
    const params = Object.entries(EFFECT_SPECS[type].params);
    assert.ok(params.length <= RUST_PARAM_SLOTS, `${type} 파라미터가 ${RUST_PARAM_SLOTS} 개를 넘는다`);
    for (const [key, spec] of params) {
      assert.ok(spec.min <= spec.default && spec.default <= spec.max, `${type}.${key}`);
      if (spec.options) assert.equal(spec.max, spec.options.length - 1, `${type}.${key} 고르기 범위`);
    }
  }
});

test('지연 — 선언한 값 = Rust 가 보고한 값 (지연 보정이 이 값을 믿는다)', async () => {
  for (const type of TYPES) {
    const fx = await FxWasm.create(module, type, resolveEffectParams(createEffect(type)), SR);
    assert.equal(fx.latency, declaredLatency(type), type);
  }
});

test('기본값으로 — 모든 이펙트가 유한한 소리를 낸다', async () => {
  for (const type of TYPES) {
    const fx = await FxWasm.create(module, type, resolveEffectParams(createEffect(type)), SR);
    const x = sine(330, SR / 2, 0.5);
    const [l, r] = fx.process(x, x);
    assert.ok(l.every(Number.isFinite) && r.every(Number.isFinite), type);
    assert.ok(peak(l) < 8, `${type} 너무 크다 ${peak(l)}`);
  }
});

test('게이트 — 작은 소리는 닫고 미터가 게인 감소를 보인다', async () => {
  const params = { ...resolveEffectParams(createEffect('gate')), thresholdDb: -30 };
  const fx = await FxWasm.create(module, 'gate', params, SR);
  const [l] = fx.process(sine(440, SR / 4, 0.003), sine(440, SR / 4, 0.003));
  assert.ok(peak(l, SR / 8) < 0.0002);
  assert.ok(fx.meters()[0]! < -40, `게인 감소 ${fx.meters()[0]}`);
});

test('스페이스 디자이너 — 꼬리가 남고, 지연만큼 드라이가 늦다', async () => {
  const params = { ...resolveEffectParams(createEffect('spacedesigner')), mix: 0.5 };
  const fx = await FxWasm.create(module, 'spacedesigner', params, SR);
  const x = new Float32Array(SR);
  x[0] = 1;
  const [l] = fx.process(x, x);
  const first = l.findIndex((v) => Math.abs(v) > 0.3);
  assert.equal(first, fx.latency);
  assert.ok(peak(l, fx.latency + SR / 2) > 1e-4, '0.5초 뒤에도 꼬리');
});

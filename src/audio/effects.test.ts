import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEffect, dbToGain, EFFECT_SPECS, isEffectType, resolveEffectParams, reverbMixGains,
  synthesizeReverbIr,
} from './effects.ts';

const FS = 48000;

test('기본값으로 이펙트를 만들면 선언 범위 안이다', () => {
  for (const type of Object.keys(EFFECT_SPECS) as (keyof typeof EFFECT_SPECS)[]) {
    const effect = createEffect(type);
    assert.equal(effect.type, type);
    assert.equal(effect.bypass, false);
    for (const [key, spec] of Object.entries(EFFECT_SPECS[type].params)) {
      const value = effect.params[key];
      assert.equal(typeof value, 'number', `${type}.${key} 가 숫자가 아니다`);
      assert.ok(
        (value as number) >= spec.min && (value as number) <= spec.max,
        `${type}.${key} = ${value} 가 범위 밖`,
      );
    }
  }
});

test('범위 밖 값과 빠진 값이 안전하게 채워진다', () => {
  // 범위 밖 값을 그대로 넣으면 Web Audio 노드가 예외를 던지거나 발산한다
  const resolved = resolveEffectParams({
    type: 'compressor',
    bypass: false,
    params: { thresholdDb: -999, ratio: 1e9, attackMs: 'fast' },
  });
  assert.equal(resolved.thresholdDb, -60);
  assert.equal(resolved.ratio, 20);
  assert.equal(resolved.attackMs, EFFECT_SPECS.compressor.params.attackMs!.default);
  assert.equal(resolved.releaseMs, EFFECT_SPECS.compressor.params.releaseMs!.default);
});

test('알 수 없는 이펙트는 조용히 통과시키지 않는다', () => {
  assert.equal(isEffectType('eq'), true);
  assert.equal(isEffectType('플랜저'), false);
  assert.throws(
    () => resolveEffectParams({ type: '플랜저', bypass: false, params: {} }),
    /알 수 없는 이펙트/,
  );
});

test('dB → 게인', () => {
  assert.ok(Math.abs(dbToGain(0) - 1) < 1e-12);
  assert.ok(Math.abs(dbToGain(-6) - 0.5012) < 1e-3);
  assert.ok(Math.abs(dbToGain(20) - 10) < 1e-9);
});

test('리버브 mix 가 등가 파워 크로스페이드다', () => {
  // 선형으로 섞으면 중간(0.5)에서 전체 파워가 떨어져 소리가 작아진다
  const dry0 = reverbMixGains(0);
  assert.ok(Math.abs(dry0.dry - 1) < 1e-9);
  assert.ok(Math.abs(dry0.wet) < 1e-9);

  const wet1 = reverbMixGains(1);
  assert.ok(Math.abs(wet1.wet - 1) < 1e-9);
  assert.ok(Math.abs(wet1.dry) < 1e-9);

  for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
    const { dry, wet } = reverbMixGains(mix);
    assert.ok(Math.abs(dry * dry + wet * wet - 1) < 1e-9, `mix=${mix} 파워가 유지되지 않는다`);
  }

  // 범위 밖도 안전
  assert.ok(Math.abs(reverbMixGains(-5).dry - 1) < 1e-9);
  assert.ok(Math.abs(reverbMixGains(9).wet - 1) < 1e-9);
});

test('리버브 IR 이 감쇠하고 유한하다', () => {
  const [left, right] = synthesizeReverbIr(FS, 1.5, 4000);
  assert.ok(left && right);
  assert.equal(left!.length, Math.round(1.5 * FS));
  assert.ok(left!.every(Number.isFinite), '유한하지 않은 샘플이 있다');

  // 뒤로 갈수록 작아진다
  const rms = (data: Float32Array, from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += data[i]! * data[i]!;
    return Math.sqrt(sum / (to - from));
  };
  const early = rms(left!, Math.round(0.05 * FS), Math.round(0.15 * FS));
  const late = rms(left!, Math.round(1.2 * FS), Math.round(1.4 * FS));
  assert.ok(late < early * 0.2, `감쇠하지 않는다: ${early.toExponential(2)} → ${late.toExponential(2)}`);

  // 시작부가 눌려 있다 (프리딜레이) — 없으면 소리가 시작부터 뭉개진다
  assert.ok(Math.abs(left![0]!) < 1e-4, `첫 샘플이 ${left![0]}`);
});

test('IR 은 좌우가 다르고 길이는 파라미터를 따른다', () => {
  const [left, right] = synthesizeReverbIr(FS, 1.0, 4000);
  let same = 0;
  for (let i = 0; i < left!.length; i++) if (left![i] === right![i]) same++;
  assert.ok(same < left!.length * 0.1, '좌우가 같으면 스테레오 리버브가 아니다');

  const short = synthesizeReverbIr(FS, 0.3, 4000)[0]!;
  const long = synthesizeReverbIr(FS, 4.0, 4000)[0]!;
  assert.ok(long.length > short.length * 10);
});

test('IR 이 결정론적이다', () => {
  // 미리듣기와 내보내기가 같아야 한다 (plan.md 5-2)
  const a = synthesizeReverbIr(FS, 1.0, 4000)[0]!;
  const b = synthesizeReverbIr(FS, 1.0, 4000)[0]!;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`샘플 ${i} 가 다르다`);
  }
});

test('고역 감쇠가 실제로 고역을 줄인다', () => {
  const bright = synthesizeReverbIr(FS, 1.0, 12000)[0]!;
  const dark = synthesizeReverbIr(FS, 1.0, 800)[0]!;

  // 인접 샘플 차이의 크기로 고역 에너지를 근사한다
  const highEnergy = (data: Float32Array) => {
    let sum = 0;
    for (let i = 1; i < data.length; i++) {
      const d = data[i]! - data[i - 1]!;
      sum += d * d;
    }
    return Math.sqrt(sum / data.length);
  };
  assert.ok(
    highEnergy(dark) < highEnergy(bright) * 0.6,
    `고역이 줄지 않는다: ${highEnergy(bright).toExponential(2)} vs ${highEnergy(dark).toExponential(2)}`,
  );
});

test('초기 반사가 또렷하게 존재한다', () => {
  // 공간감은 꼬리가 아니라 **처음 몇 번 튀어 돌아오는 소리**가 만든다.
  // 확산 노이즈만 있으면 방이 아니라 안개로 들린다 (ROADMAP.md S2-6)
  const [left, right] = synthesizeReverbIr(FS, 2.0, 4000);

  // 초기 구간의 최대값이 그 주변 확산 성분보다 확실히 크다 = 개별 반사가 살아 있다
  const peakIn = (data: Float32Array, fromMs: number, toMs: number) => {
    let peak = 0;
    for (let i = Math.round(fromMs * 0.001 * FS); i < Math.round(toMs * 0.001 * FS); i++) {
      peak = Math.max(peak, Math.abs(data[i]!));
    }
    return peak;
  };
  const earlyPeak = peakIn(left!, 5, 90);
  const diffusePeak = peakIn(left!, 200, 400);
  assert.ok(
    earlyPeak > diffusePeak * 3,
    `초기 반사가 확산에 묻혔다: ${earlyPeak.toExponential(2)} vs ${diffusePeak.toExponential(2)}`,
  );

  // 좌우 반사 시각이 다르다 — 같으면 리버브가 가운데 뭉쳐 스테레오가 죽는다
  const argmax = (data: Float32Array, toMs: number) => {
    let best = 0;
    let at = 0;
    for (let i = 0; i < Math.round(toMs * 0.001 * FS); i++) {
      if (Math.abs(data[i]!) > best) { best = Math.abs(data[i]!); at = i; }
    }
    return at;
  };
  assert.notEqual(argmax(left!, 90), argmax(right!, 90), '좌우 첫 반사가 같은 시각이다');
});

test('초기 반사가 프리딜레이를 침범하지 않는다', () => {
  // 첫 반사보다 앞에 소리가 있으면 원음보다 잔향이 먼저 오는 셈이다
  const [left] = synthesizeReverbIr(FS, 2.0, 4000);
  const firstTapMs = 11;
  let peakBefore = 0;
  for (let i = 0; i < Math.round((firstTapMs - 1) * 0.001 * FS); i++) {
    peakBefore = Math.max(peakBefore, Math.abs(left![i]!));
  }
  assert.ok(peakBefore < 0.05, `첫 반사 앞에 ${peakBefore.toExponential(2)} 가 있다`);
});

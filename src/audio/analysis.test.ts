/**
 * 측정기 자체의 회귀 테스트.
 *
 * 측정기가 틀리면 음정 테스트 전부가 거짓말이 된다. 그래서 합성 신호로
 * 측정기를 먼저 검증한다 — 정답을 아는 신호에서 그 값이 나오는지.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { centsBetween, measureCentsError, measureCentsErrorInContext, measureFreq } from './analysis.ts';

const FS = 48000;

interface Component {
  hz: number;
  amp: number;
  /** 진폭이 1/e 로 줄어드는 시간 */
  tauSec: number;
  phase?: number;
  /** 하모닉을 몇 개 실을지 */
  harmonics?: number;
}

function synth(components: Component[], lengthSec: number): Float32Array {
  const n = Math.round(lengthSec * FS);
  const x = new Float32Array(n);
  for (const c of components) {
    const harmonics = c.harmonics ?? 3;
    for (let h = 1; h <= harmonics; h++) {
      const w = (2 * Math.PI * c.hz * h) / FS;
      const amp = c.amp / h;
      const phase = (c.phase ?? 0) + h * 0.7;
      for (let i = 0; i < n; i++) {
        x[i] = x[i]! + amp * Math.exp(-i / (c.tauSec * FS)) * Math.cos(w * i + phase);
      }
    }
  }
  return x;
}

const centsToHz = (baseHz: number, cents: number) => baseHz * Math.pow(2, cents / 1200);

test('단일 성분은 단순 복조로 정확히 측정된다', () => {
  for (const [baseHz, cents] of [[55, 1.7], [220, -14], [440, 3.5], [4186, 6]] as const) {
    const x = synth([{ hz: centsToHz(baseHz, cents), amp: 1, tauSec: 0.6 }], 1.2);
    const err = measureCentsError(x, baseHz, FS) - cents;
    assert.ok(Math.abs(err) < 0.05, `${baseHz}Hz ${cents}센트 → 오차 ${err.toFixed(4)} 센트`);
  }
});

test('가까운 간섭원이 있으면 단순 복조가 실제로 틀린다', () => {
  // 이 테스트는 문제의 존재를 고정한다. 여기가 통과하지 않게 되면
  // 아래 joint 측정이 정말 필요한지 다시 봐야 한다는 뜻이다
  const target = centsToHz(220, -14);
  const interferer = 220; // 목표에서 14센트 위 ≈ 1.8Hz
  const x = synth([
    { hz: target, amp: 1, tauSec: 1.5 },
    { hz: interferer, amp: 0.18, tauSec: 1.5 }, // -15dB 정도로 남아 있는 앞 음
  ], 1.5);

  const naive = measureCentsError(x, target, FS);
  assert.ok(Math.abs(naive) > 1, `단순 복조가 오차 ${naive.toFixed(3)} 센트로 통과해버렸다`);
});

test('알려진 간섭원을 모델에 넣으면 정확해진다', () => {
  const interferer = 220;
  for (const cents of [-37, -14, -5, 5, 14, 37]) {
    const target = centsToHz(interferer, cents);
    const x = synth([
      { hz: target, amp: 1, tauSec: 1.5 },
      { hz: interferer, amp: 0.18, tauSec: 1.5 },
    ], 1.5);

    const err = measureCentsErrorInContext(x, target, FS, { interferersHz: [interferer] });
    assert.ok(Math.abs(err) < 0.5, `${cents}센트 + 간섭 → 오차 ${err.toFixed(4)} 센트`);
  }
});

test('간섭원이 여러 개여도 된다', () => {
  // 화음 위에 한 음이 더 얹힌 상황
  const target = centsToHz(330, -22);
  const others = [220, 261.63, 329.63, 392];
  const x = synth([
    { hz: target, amp: 1, tauSec: 1.5 },
    ...others.map((hz) => ({ hz, amp: 0.25, tauSec: 1.5 })),
  ], 1.5);

  const err = measureCentsErrorInContext(x, target, FS, { interferersHz: others });
  assert.ok(Math.abs(err) < 1, `화음 속 측정 오차 ${err.toFixed(4)} 센트`);
});

test('간섭원을 안 알려주면 joint 측정도 못 고친다', () => {
  // 한계를 명시한다. 이 방법이 통하는 건 무엇이 울리는지 **알 때**뿐이다.
  // 모르는 상태의 음정 검출은 오디오 도메인 문제이고 plan.md 가 Phase 4 로 미뤄 뒀다
  const interferer = 220;
  const target = centsToHz(interferer, -14);
  const x = synth([
    { hz: target, amp: 1, tauSec: 1.5 },
    { hz: interferer, amp: 0.18, tauSec: 1.5 },
  ], 1.5);

  const blind = measureCentsErrorInContext(x, target, FS, { interferersHz: [] });
  assert.ok(Math.abs(blind) > 1, '간섭원 정보 없이도 맞았다면 이 방법의 근거 설명이 틀렸다');
});

test('센트 계산', () => {
  assert.equal(centsBetween(440, 880), 1200);
  assert.ok(Math.abs(centsBetween(440, 440 * Math.pow(2, 1 / 1200)) - 1) < 1e-9);
});

test('신호가 너무 짧으면 조용히 틀린 값을 주지 않고 에러를 낸다', () => {
  const x = synth([{ hz: 440, amp: 1, tauSec: 0.001 }], 0.02);
  assert.throws(() => measureFreq(x, 440, FS), /측정 구간 부족|신호 길이 부족/);
});

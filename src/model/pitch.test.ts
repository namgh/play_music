/**
 * 음정 변환 회귀 테스트.
 *
 * 합성 엔진의 ±1센트 테스트(`spike/m0-karplus/test-pitch.mjs`)와 짝이다.
 * 엔진이 정확해도 데이터 층에서 음정이 틀어지면 제품 주장이 무너지는 건 같다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  centsBetween, detune, formatPitch, hzToPitch, isInScale, isTonic, normalizePitch, pitch,
  pitchName, pitchToHz, tonicSemitone, transpose,
} from './pitch.ts';

const TOL_CENTS = 1e-9;

test('A4 = 440Hz', () => {
  assert.equal(pitchToHz(pitch(69)), 440);
});

test('한 옥타브는 정확히 2배', () => {
  assert.equal(pitchToHz(pitch(81)) / pitchToHz(pitch(69)), 2);
});

test('Hz → 음정 → Hz 왕복이 손실 없다', () => {
  for (const hz of [27.5, 82.41, 261.63, 440, 446.5, 1000, 4186.01, 12543.85]) {
    const round = pitchToHz(hzToPitch(hz));
    assert.ok(
      Math.abs(centsBetween(hz, round)) < TOL_CENTS,
      `${hz}Hz 왕복 오차 ${centsBetween(hz, round)} 센트`,
    );
  }
});

test('센트는 -50~+50 으로 정규화된다', () => {
  // "+70센트"와 "한 반음 위 -30센트"가 같은 값으로 저장돼야 비교가 된다
  const a = normalizePitch({ midi: 69, cents: 70 });
  assert.equal(a.midi, 70);
  assert.ok(Math.abs(a.cents - -30) < 1e-9);

  const b = normalizePitch({ midi: 69, cents: -70 });
  assert.equal(b.midi, 68);
  assert.ok(Math.abs(b.cents - 30) < 1e-9);

  // 경계: 정확히 +50 은 올림 처리되어 한 반음 위 -50 이 된다 (일관성만 있으면 된다)
  const c = normalizePitch({ midi: 69, cents: 50 });
  assert.ok(Math.abs(pitchToHz(c) - pitchToHz({ midi: 69, cents: 50 })) < 1e-9);
});

test('반음 이동이 센트 미세조정을 보존한다', () => {
  // 이게 midi 와 cents 를 나눠 저장하는 이유 그 자체다
  const tuned = detune(pitch(69), -14);
  const moved = transpose(tuned, 12);
  assert.equal(moved.midi, 81);
  assert.ok(Math.abs(moved.cents - -14) < 1e-9);
  assert.ok(Math.abs(centsBetween(pitchToHz(tuned) * 2, pitchToHz(moved))) < TOL_CENTS);
});

test('센트 미세조정이 누적된다', () => {
  let p = pitch(69);
  for (let i = 0; i < 10; i++) p = detune(p, 3);
  assert.equal(p.midi, 69);
  assert.ok(Math.abs(p.cents - 30) < 1e-9);
});

test('조율 기준을 바꾸면 전체가 따라 움직인다', () => {
  const a442 = { a4Hz: 442 };
  assert.equal(pitchToHz(pitch(69), a442), 442);
  // 기준이 바뀌어도 음 간 관계(센트)는 그대로
  assert.ok(
    Math.abs(centsBetween(pitchToHz(pitch(60), a442), pitchToHz(pitch(69), a442)) - 900) < TOL_CENTS,
  );
});

test('음 이름 표기', () => {
  assert.equal(pitchName(pitch(69)), 'A4');
  assert.equal(pitchName(pitch(60)), 'C4');
  assert.equal(pitchName(pitch(21)), 'A0');
  assert.equal(pitchName(pitch(108)), 'C8');
  assert.equal(formatPitch(pitch(69)), 'A4 · 440.00 Hz');
  assert.equal(formatPitch(detune(pitch(69), -14)), 'A4 -14.0¢ · 436.46 Hz');
});

// ---------------------------------------------------------------------------
// 스케일 표시 (피아노롤 조성 하이라이트)
// ---------------------------------------------------------------------------

test('C 메이저는 흰 건반만 스케일에 든다', () => {
  const key = { tonic: 'C', mode: 'major' } as const;
  const white = [60, 62, 64, 65, 67, 69, 71]; // C D E F G A B
  const black = [61, 63, 66, 68, 70];
  for (const midi of white) assert.ok(isInScale(midi, key), `${midi} 가 빠졌다`);
  for (const midi of black) assert.ok(!isInScale(midi, key), `${midi} 가 들어왔다`);
});

test('A 마이너는 C 메이저와 같은 음 집합이다', () => {
  for (let midi = 48; midi < 72; midi++) {
    assert.equal(
      isInScale(midi, { tonic: 'A', mode: 'minor' }),
      isInScale(midi, { tonic: 'C', mode: 'major' }),
      `${midi} 에서 갈렸다`,
    );
  }
});

test('조성이 없으면 전부 스케일 안 — 표시를 하지 않는다', () => {
  for (let midi = 0; midi < 128; midi += 7) assert.ok(isInScale(midi, null));
  assert.equal(isTonic(60, null), false);
});

test('플랫 표기와 대소문자를 받아 준다', () => {
  // 사용자가 Bb 로 쓸 수 있다. 못 읽으면 조용히 C 로 취급돼 엉뚱하게 표시된다
  assert.equal(tonicSemitone('Bb'), 10);
  assert.equal(tonicSemitone('bb'), 10);
  assert.equal(tonicSemitone('A#'), 10);
  assert.equal(tonicSemitone('f#'), 6);
  assert.equal(tonicSemitone('H'), null, '없는 음이름을 받아들였다');
});

test('읽을 수 없는 으뜸음은 표시를 끈다 (조용히 C 로 취급하지 않는다)', () => {
  const bogus = { tonic: '???', mode: 'major' } as const;
  assert.ok(isInScale(61, bogus), 'C 메이저로 취급해 C# 를 밖으로 밀어냈다');
  assert.equal(isTonic(60, bogus), false);
});

test('으뜸음은 옥타브와 무관하게 판정한다', () => {
  const key = { tonic: 'D', mode: 'minor' } as const;
  for (const midi of [50, 62, 74]) assert.ok(isTonic(midi, key), `${midi} 가 D 가 아니라고 한다`);
  assert.ok(!isTonic(64, key));
});

test('센트 미세조정은 스케일 판정에 영향을 주지 않는다', () => {
  // 조성 표시는 건반 줄 단위다. 섞으면 -30센트 맞춰 둔 음이 갑자기 스케일 밖이 된다
  const key = { tonic: 'C', mode: 'major' } as const;
  const p = pitch(64, -30);
  assert.equal(p.midi, 64);
  assert.ok(isInScale(p.midi, key));
});

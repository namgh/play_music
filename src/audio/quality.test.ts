/**
 * **측정기 자체를 먼저 검증한다.**
 *
 * 음질 비교에서 가장 흔한 실패는 엔진이 아니라 계기가 틀린 것이다. 이 저장소에서만
 * 이미 여러 번 그랬다 — 추적 범위 밖에서 마지막 값을 조용히 돌려준 `centsAt`,
 * 엔진을 재사용해 A/B 가 오염된 것, 하모닉 탐색 창이 너무 넓었던 것
 * (`HANDOFF.md` 30번: **재 보기 전에 원인을 쓰지 말 것**).
 *
 * 그래서 여기서는 **정답을 아는 신호**만 넣는다. 규격이 정한 값이 있으면 그것을 쓴다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENBW,
  aliasingVsReferenceDb,
  attackMs,
  componentAmplitude,
  dbfs,
  integratedLufs,
  matchLoudness,
  noiseFloorDbfs,
  octaveBands,
  preciseCentsError,
  spectralCentroidHz,
  spectrum,
  stereoCorrelation,
  thdPlusN,
  truePeakDbfs,
} from './quality.ts';

const FS = 48000;

function sine(hz: number, seconds: number, amplitude = 1, phase = 0): Float32Array {
  const n = Math.round(seconds * FS);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    x[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / FS + phase);
  }
  return x;
}

// --- 라우드니스 --------------------------------------------------------------

test('LUFS — 규격이 정한 정답: 스테레오 1kHz 사인 -23dBFS 는 -23 LUFS', () => {
  // EBU Tech 3341 적합성 시험 1번. 이 값이 안 맞으면 K-가중이나 게이팅이 틀린 것이고,
  // 그러면 라우드니스 정합이 틀리고, 그러면 **모든 A/B 비교가 무의미해진다**
  const amp = 10 ** (-23 / 20);
  const x = sine(1000, 5, amp);
  const measured = integratedLufs([x, Float32Array.from(x)], FS);
  assert.ok(
    Math.abs(measured - -23) < 0.15,
    `-23 LUFS 여야 하는데 ${measured.toFixed(2)} 이 나왔다`,
  );
});

test('LUFS — 전대역 스테레오 사인은 0 LUFS', () => {
  const x = sine(1000, 3, 1);
  const measured = integratedLufs([x, Float32Array.from(x)], FS);
  assert.ok(Math.abs(measured) < 0.15, `0 LUFS 여야 하는데 ${measured.toFixed(2)}`);
});

test('LUFS — 이득을 6dB 올리면 6 LU 올라간다', () => {
  const x = sine(1000, 3, 0.1);
  const loud = Float32Array.from(x, (v) => v * 2);
  const a = integratedLufs([x, x], FS);
  const b = integratedLufs([loud, loud], FS);
  assert.ok(Math.abs(b - a - 6.02) < 0.1, `6dB 차이여야 하는데 ${(b - a).toFixed(2)}`);
});

test('LUFS — 게이트가 무음을 빼고 잰다', () => {
  // 앞 절반이 무음인 신호. 게이트가 없으면 평균이 끌려 내려간다
  const tone = sine(1000, 3, 0.5);
  const withSilence = new Float32Array(tone.length * 2);
  withSilence.set(tone, tone.length);
  const gated = integratedLufs([withSilence, withSilence], FS);
  const plain = integratedLufs([tone, tone], FS);
  assert.ok(
    Math.abs(gated - plain) < 0.5,
    `무음이 결과를 바꾸면 안 된다: ${gated.toFixed(2)} vs ${plain.toFixed(2)}`,
  );
});

test('라우드니스 정합 — 맞춘 뒤에는 두 신호의 LUFS 가 같다', () => {
  // **A/B 의 전제조건.** 0.5dB 만 커도 사람은 "음질이 낫다"고 답한다
  const quiet = sine(440, 3, 0.05);
  const loud = sine(440, 3, 0.8);

  const a = matchLoudness([quiet, quiet], -18, FS);
  const b = matchLoudness([loud, loud], -18, FS);

  const la = integratedLufs(a.channels, FS);
  const lb = integratedLufs(b.channels, FS);
  assert.ok(Math.abs(la - lb) < 0.1, `정합 후 차이: ${(la - lb).toFixed(2)} LU`);
  assert.ok(Math.abs(la - -18) < 0.1);
  // 얼마나 키웠는지 보고한다 — 20dB 를 키웠다면 애초에 비교가 성립 안 하는 조건이었다
  assert.ok(a.gainDb > b.gainDb);
});

// --- 트루 피크 ---------------------------------------------------------------

test('트루 피크 — 샘플 사이에 숨은 피크를 잡는다', () => {
  // fs/4 사인을 45° 어긋나게 표본화하면 샘플은 ±0.707 인데 실제 파형은 1.0 에 닿는다.
  // 샘플 피크만 보면 -3dBFS 라 "여유 있다"고 판정하지만, DAC 이나 mp3 인코더는
  // 그 사이를 복원해서 실제로 깎는다
  const x = sine(FS / 4, 0.2, 1, Math.PI / 4);

  let samplePeak = 0;
  for (const v of x) samplePeak = Math.max(samplePeak, Math.abs(v));
  assert.ok(Math.abs(dbfs(samplePeak) - -3.01) < 0.1, '샘플 피크는 -3dBFS 여야 한다');

  const tp = truePeakDbfs(x);
  assert.ok(tp > -0.6, `트루 피크가 0dBFS 근처여야 하는데 ${tp.toFixed(2)}`);
});

test('트루 피크 — 정렬된 사인에서는 샘플 피크와 거의 같다', () => {
  const x = sine(1000, 0.2, 0.5);
  const tp = truePeakDbfs(x);
  assert.ok(Math.abs(tp - dbfs(0.5)) < 0.2, `${tp.toFixed(2)} vs ${dbfs(0.5).toFixed(2)}`);
});

// --- 왜곡 --------------------------------------------------------------------

test('THD+N — 순수 사인은 빈 중심을 벗어나도 -80dB 이하', () => {
  // **여기가 계기의 함정이었다.** Hann 창으로는 기본파의 누설이 잡음 칸으로 새어
  // 들어가서, 빈 중심에 안 떨어지는 순수 사인이 -43dB 로 읽혔다. 실제 악기의
  // 기본파는 늘 빈 사이에 있으므로 그대로 두면 모든 THD+N 이 엉터리가 된다
  for (const hz of [1000, 440, 1234.56]) {
    const { thdPlusNDb } = thdPlusN(sine(hz, 1, 0.5), hz, FS);
    assert.ok(thdPlusNDb < -80, `${hz}Hz 순수 사인인데 ${thdPlusNDb.toFixed(1)}dB`);
  }
});

test('THD+N — 심어 둔 2차 하모닉을 그 크기로 읽는다', () => {
  const n = FS;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    x[i] =
      0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS) +
      0.005 * Math.sin((2 * Math.PI * 2000 * i) / FS); // -40dB
  }
  const { thdDb, harmonicsDb } = thdPlusN(x, 1000, FS);
  assert.ok(Math.abs(thdDb - -40) < 1, `-40dB 여야 하는데 ${thdDb.toFixed(1)}`);
  assert.ok(Math.abs(harmonicsDb[0]! - -40) < 1, `2차 하모닉: ${harmonicsDb[0]!.toFixed(1)}`);
});

test('THD+N — 잡음을 왜곡과 함께 센다', () => {
  const n = FS;
  const x = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff - 0.5) * 2;
    x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS) + noise * 0.001;
  }
  const { thdPlusNDb, thdDb } = thdPlusN(x, 1000, FS);
  // 잡음이 있으니 THD+N 은 THD 보다 확실히 크다
  assert.ok(thdPlusNDb > thdDb + 10, `${thdPlusNDb.toFixed(1)} vs ${thdDb.toFixed(1)}`);
  assert.ok(thdPlusNDb < -40);
});

// --- 스펙트럼 ----------------------------------------------------------------

test('스펙트럼 — 빈 중심에 떨어지는 사인은 피크 빈이 곧 진폭', () => {
  const size = 16384;
  const hz = (1000 * FS) / size; // 정확히 1000번 빈
  const mag = spectrum(sine(hz, 1, 0.5), size);
  assert.ok(Math.abs(mag[1000]! - 0.5) < 0.01, `진폭 0.5 여야 하는데 ${mag[1000]!.toFixed(3)}`);
});

test('성분 진폭 — 빈 중심을 벗어나도 정확하다', () => {
  // **스캘럽 손실.** 실제 악기의 기본파가 빈 중심에 떨어지는 일은 거의 없다.
  // 피크 빈만 읽으면 최대 -1.4dB 까지 낮게 나오고, 그러면 모든 측정이 조금씩 틀린다
  const size = 16384;
  for (const hz of [1000, 1234.56, (1000 * FS) / size]) {
    const mag = spectrum(sine(hz, 1, 0.5), size);
    const amp = componentAmplitude(mag, (hz * size) / FS, 3, ENBW.hann);
    assert.ok(
      Math.abs(amp - 0.5) < 0.01,
      `${hz.toFixed(1)}Hz: 진폭 0.5 여야 하는데 ${amp.toFixed(4)}`,
    );
  }
});

test('무게중심 — 사인은 그 주파수', () => {
  const c = spectralCentroidHz(sine(1000, 1, 0.5), FS);
  assert.ok(Math.abs(c - 1000) < 60, `1000Hz 근처여야 하는데 ${c.toFixed(0)}`);
});

test('무게중심 — 밝은 소리가 더 크다', () => {
  const dark = spectralCentroidHz(sine(200, 1), FS);
  const bright = spectralCentroidHz(sine(4000, 1), FS);
  assert.ok(bright > dark * 5);
});

test('옥타브 밴드 — 에너지가 해당 밴드에 모인다', () => {
  const bands = octaveBands(sine(1000, 1, 0.5), FS);
  const at1k = bands.find((b) => b.centerHz === 1000)!;
  const at125 = bands.find((b) => b.centerHz === 125)!;
  assert.ok(at1k.db > at125.db + 40, `1kHz 밴드가 지배적이어야 한다`);
});

// --- 시간축 ------------------------------------------------------------------

test('어택 — 심어 둔 상승 시간을 읽는다', () => {
  const n = Math.round(0.5 * FS);
  const x = new Float32Array(n);
  const attackSamples = Math.round(0.05 * FS); // 50ms 선형 상승
  for (let i = 0; i < n; i += 1) {
    const env = i < attackSamples ? i / attackSamples : 1;
    x[i] = env * Math.sin((2 * Math.PI * 440 * i) / FS);
  }
  const ms = attackMs(x, FS);
  // 10%~90% 구간이므로 50ms 의 80% = 40ms
  assert.ok(Math.abs(ms - 40) < 6, `40ms 근처여야 하는데 ${ms.toFixed(1)}`);
});

test('잡음 바닥 — 무음은 아주 낮게 나온다', () => {
  assert.ok(noiseFloorDbfs(new Float32Array(4800)) < -120);
});

// --- 스테레오 ----------------------------------------------------------------

test('스테레오 상관 — 같은 신호는 +1, 뒤집으면 -1', () => {
  const x = sine(440, 0.5, 0.5);
  const inverted = Float32Array.from(x, (v) => -v);
  assert.ok(Math.abs(stereoCorrelation(x, x) - 1) < 1e-6);
  assert.ok(Math.abs(stereoCorrelation(x, inverted) - -1) < 1e-6);
});

test('스테레오 상관 — 위상 반전은 모노에서 사라진다는 신호다', () => {
  // 상관이 음수면 모노 합성에서 소리가 지워진다. 유튜브·클럽 PA 에서 실제로 난다
  const left = sine(440, 0.5, 0.5);
  const right = sine(440, 0.5, 0.5, Math.PI);
  const corr = stereoCorrelation(left, right);
  assert.ok(corr < -0.9, `위상 반전을 못 잡았다: ${corr.toFixed(3)}`);

  const mono = Float32Array.from(left, (v, i) => (v + right[i]!) / 2);
  assert.ok(noiseFloorDbfs(mono) < -100, '모노에서 지워져야 한다');
});

// --- 정밀 음정 ---------------------------------------------------------------

test('정밀 음정 — 빈 폭보다 훨씬 정밀하다', () => {
  // 131072점에서 빈 폭이 0.37Hz 다. 370Hz 에서 그건 1.7센트 —
  // **±1센트 기준을 판정할 수 없는 해상도**라 보간이 필요하다
  for (const hz of [110, 369.994, 440, 1318.51]) {
    const err = preciseCentsError(sine(hz, 3, 0.5), hz, FS);
    assert.ok(Math.abs(err) < 0.05, `${hz}Hz: ${err.toFixed(3)}센트`);
  }
});

test('정밀 음정 — 심어 둔 어긋남을 그대로 읽는다', () => {
  const target = 440;
  for (const cents of [-5, -1, 0.5, 3]) {
    const actual = target * 2 ** (cents / 1200);
    const err = preciseCentsError(sine(actual, 3, 0.5), target, FS);
    assert.ok(Math.abs(err - cents) < 0.05, `${cents}센트 심었는데 ${err.toFixed(3)} 읽음`);
  }
});

test('정밀 음정 — 옆에 있는 비조화 부분음에 끌리지 않는다', () => {
  // **이것 때문에 멀쩡한 튜불러벨이 2.16센트 어긋난 것으로 읽혔다.**
  // 벨은 1.19배·1.51배에 강한 부분음이 있고, 탐색 창이 넓으면 계기가 그쪽으로 끌린다
  const f0 = 370;
  const n = FS * 3;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    x[i] =
      0.5 * Math.sin((2 * Math.PI * f0 * i) / FS) +
      0.45 * Math.sin((2 * Math.PI * f0 * 1.19 * i) / FS) +
      0.4 * Math.sin((2 * Math.PI * f0 * 1.51 * i) / FS);
  }
  const err = preciseCentsError(x, f0, FS);
  assert.ok(Math.abs(err) < 0.1, `비조화 부분음에 끌렸다: ${err.toFixed(3)}센트`);
});

test('LUFS — 아주 짧은 소리도 값을 준다', () => {
  // 하이햇·클랩은 400ms 블록이 하나도 안 나온다. -Infinity 는 정보가 아니다
  const short = sine(1000, 0.05, 0.5);
  const v = integratedLufs([short, short], FS);
  assert.ok(Number.isFinite(v), `유한한 값이어야 하는데 ${v}`);
  assert.ok(v > -30 && v < 0, `그럴듯한 범위여야 하는데 ${v.toFixed(1)}`);
});

// --- 에일리어싱 --------------------------------------------------------------

/** 대역 제한 없는 톱니 — **일부러 에일리어싱을 만든다** */
function naiveSaw(hz: number, seconds: number, rate: number): Float32Array {
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  let phase = 0;
  const inc = hz / rate;
  for (let i = 0; i < n; i += 1) {
    x[i] = 2 * phase - 1;
    phase += inc;
    if (phase >= 1) phase -= 1;
  }
  return x;
}

/** 나이퀴스트 아래 하모닉만 더한 톱니 — 에일리어싱이 원리적으로 없다 */
function bandlimitedSaw(hz: number, seconds: number, rate: number): Float32Array {
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  const harmonics = Math.floor(rate / 2 / hz);
  for (let h = 1; h <= harmonics; h += 1) {
    const amp = 2 / (Math.PI * h);
    for (let i = 0; i < n; i += 1) {
      x[i]! += amp * Math.sin((2 * Math.PI * h * hz * i) / rate);
    }
  }
  return x;
}

test('에일리어싱 — 대역제한 톱니는 깨끗하다고 읽는다', () => {
  // **정답을 아는 신호.** 하모닉을 나이퀴스트 아래로만 쌓았으니 접힌 성분이 없다
  const hz = 2000;
  const low = bandlimitedSaw(hz, 1, FS);
  const ref = bandlimitedSaw(hz, 1, FS * 4);
  const db = aliasingVsReferenceDb(low, FS, ref, FS * 4, hz);
  assert.ok(db < -60, `깨끗한 신호인데 ${db.toFixed(1)}dB 로 읽혔다`);
});

test('에일리어싱 — 순진한 톱니의 접힘을 잡아낸다', () => {
  // 같은 파형을 4배 표본율로 만들면 접힘이 훨씬 적다. 그 차이가 곧 에일리어싱이다
  const hz = 2000;
  const low = naiveSaw(hz, 1, FS);
  const ref = naiveSaw(hz, 1, FS * 4);
  const db = aliasingVsReferenceDb(low, FS, ref, FS * 4, hz);
  assert.ok(db > -40, `접힘이 큰 신호인데 ${db.toFixed(1)}dB 로 읽혔다`);
});

test('에일리어싱 — 비조화 부분음을 접힘으로 오해하지 않는다', () => {
  // **여기서 이전 계기가 틀렸다.** 피아노의 비조화(의도한 설계)와 벨의 모달
  // 부분음을 전부 에일리어싱으로 세어서, 멀쩡한 악기가 +21dB 로 읽혔다 —
  // 기본파보다 접힘이 크다는 물리적으로 불가능한 값이었다
  const f0 = 220;
  const make = (rate: number) => {
    const n = Math.round(1 * rate);
    const x = new Float32Array(n);
    // 비조화 부분음: 1, 2.04, 3.13, 4.28배 (피아노의 강성 분산과 비슷하게)
    for (const [ratio, amp] of [[1, 0.5], [2.04, 0.4], [3.13, 0.3], [4.28, 0.2]]) {
      for (let i = 0; i < n; i += 1) {
        x[i]! += amp * Math.sin((2 * Math.PI * f0 * ratio * i) / rate);
      }
    }
    return x;
  };
  const db = aliasingVsReferenceDb(make(FS), FS, make(FS * 4), FS * 4, f0);
  assert.ok(db < -60, `비조화 부분음을 접힘으로 셌다: ${db.toFixed(1)}dB`);
});

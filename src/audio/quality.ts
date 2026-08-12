/**
 * 음질 측정 — **다른 앱과 비교할 수 있는 형태의 숫자**.
 *
 * `cleanliness.test.ts` 가 "깨졌는가"를 보는 합격/불합격이라면, 여기는 **얼마나
 * 좋은가**를 재는 계기다. 둘을 나누는 이유는 비교의 성격이 다르기 때문이다 —
 * 깨끗함은 통과하거나 못 하거나이지만, 음질 비교는 값의 크기를 나란히 놓는 일이다.
 *
 * ## 여기 있는 것이 "비교 가능한" 이유
 *
 * THD+N, 노이즈 플로어, 트루 피크, LUFS 는 **절대 측정값**이다. 상용 DAW·오디오
 * 인터페이스가 공개하는 스펙과 같은 단위이고, 다른 앱에서 내보낸 파일에 같은 함수를
 * 돌리면 그대로 나란히 놓을 수 있다. "우리 것이 더 좋은가"를 인상이 아니라 숫자로
 * 답할 수 있는 부분이 여기까지다.
 *
 * ## 여기서 답할 수 없는 것
 *
 * **사실감은 귀로만 판정된다** (`sound.md` 11-3). 스펙트럼이 비슷해도 "진짜 기타
 * 같은가"는 다른 질문이다. 그래서 이 모듈은 블라인드 청취를 **대체하지 않고 준비**
 * 한다 — `matchLoudness` 가 그 목적이다.
 *
 * ## 라우드니스 정합이 먼저인 이유
 *
 * **큰 소리가 항상 더 좋게 들린다.** 0.5dB 차이면 사람은 "음질이 낫다"고 답한다.
 * 라우드니스를 맞추지 않은 A/B 는 음질이 아니라 음량을 비교하는 것이고, 그렇게 나온
 * 결론은 전부 버려야 한다. 그래서 비교 도구는 언제나 LUFS 정합을 먼저 한다.
 */

const EPS = 1e-12;

export function dbfs(amplitude: number): number {
  return 20 * Math.log10(Math.max(Math.abs(amplitude), EPS));
}

export function rms(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / Math.max(x.length, 1));
}

// --- FFT ---------------------------------------------------------------------
//
// 라이브러리를 안 쓰는 이유는 `dsp/` 와 같다 — 의존성 하나가 빌드·CI·라이선스에
// 붙는 값어치가 없다. 반복 radix-2 라 길이는 2의 거듭제곱이어야 한다.

/** 제자리 복소 FFT. `re`·`im` 길이는 2의 거듭제곱 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error('FFT 길이는 2의 거듭제곱이어야 한다');
  }

  // 비트 반전 재배열
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;
        const vRe = re[i + k + len / 2]! * curRe - im[i + k + len / 2]! * curIm;
        const vIm = re[i + k + len / 2]! * curIm + im[i + k + len / 2]! * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export type WindowKind = 'hann' | 'blackman-harris';

/** 창의 등가잡음대역폭(빈 단위). 성분 진폭을 파워합에서 되돌릴 때 쓴다 */
export const ENBW: Record<WindowKind, number> = {
  hann: 1.5,
  'blackman-harris': 2.0044,
};

function windowValue(kind: WindowKind, i: number, n: number): number {
  const t = (2 * Math.PI * i) / n;
  if (kind === 'hann') return 0.5 - 0.5 * Math.cos(t);
  // 4항 Blackman-Harris — 사이드로브 -92dB. **THD 측정에는 이게 필요하다**:
  // Hann(사이드로브 -31dB)으로는 기본파의 누설이 잡음 칸으로 새어 들어가서,
  // 완벽한 사인조차 THD+N -43dB 로 읽힌다 (실측했다)
  return (
    0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t)
  );
}

/** 한 창의 진폭 스펙트럼. 진폭은 창 이득을 보정한 선형값 */
export function spectrum(x: Float32Array, size = 16384, kind: WindowKind = 'hann'): Float64Array {
  const n = Math.min(size, 1 << Math.floor(Math.log2(Math.max(x.length, 2))));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let windowSum = 0;
  for (let i = 0; i < n; i += 1) {
    const w = windowValue(kind, i, n);
    re[i] = (x[i] ?? 0) * w;
    windowSum += w;
  }
  fft(re, im);

  const half = n / 2;
  const mag = new Float64Array(half);
  const scale = 2 / Math.max(windowSum, EPS);
  for (let k = 0; k < half; k += 1) {
    mag[k] = Math.hypot(re[k]!, im[k]!) * scale;
  }
  return mag;
}

/**
 * 한 성분의 진폭 — **주엽에 퍼진 에너지를 모아서** 판다.
 *
 * 피크 빈 하나만 읽으면 안 되는 이유: 신호 주파수가 빈 중심에 정확히 안 떨어지면
 * 에너지가 이웃 빈으로 나뉘어 최대 -1.4dB 까지 낮게 읽힌다(스캘럽 손실). 실제
 * 악기 소리의 기본파가 빈 중심에 떨어지는 일은 거의 없으므로, 그대로 두면
 * **모든 측정이 조금씩 틀린다.**
 *
 * 주엽의 파워를 합한 뒤 창의 등가잡음대역폭(ENBW)으로 나눈다.
 */
export function componentAmplitude(
  mag: Float64Array,
  centerBin: number,
  spread: number,
  enbwBins: number,
): number {
  const from = Math.max(0, Math.round(centerBin) - spread);
  const to = Math.min(mag.length - 1, Math.round(centerBin) + spread);
  let power = 0;
  for (let k = from; k <= to; k += 1) power += mag[k]! * mag[k]!;
  return Math.sqrt(power / enbwBins);
}


export function binToHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

export function hzToBin(hz: number, sampleRate: number, fftSize: number): number {
  return Math.round((hz * fftSize) / sampleRate);
}

/**
 * 기본파 주파수를 **빈 폭보다 정밀하게** 잰다.
 *
 * FFT 빈 하나는 48kHz·131072점에서도 0.37Hz 다. 370Hz 에서 0.37Hz 면 1.7센트 —
 * **±1센트 기준을 판정할 수 없는 해상도다.** 그래서 피크 주변 세 점에 포물선을
 * 맞춰 꼭짓점을 찾는다(로그 진폭에서 하면 가우시안 주엽에 잘 맞는다).
 *
 * **좁게 찾는 이유**가 있다. 튜불러벨 같은 비조화 악기는 1.19배·1.51배 같은 곳에
 * 강한 부분음이 있어서, 탐색 창이 넓으면 계기가 그쪽으로 끌린다 — 실제로 멀쩡한
 * 벨이 2.16센트 어긋난 것으로 읽혔다. 엔진을 고칠 뻔했다 (`HANDOFF.md` 30번).
 */
export function preciseFundamentalHz(
  x: Float32Array,
  targetHz: number,
  sampleRate: number,
  size = 131072,
): number {
  const n = Math.min(size, 1 << Math.floor(Math.log2(Math.max(x.length, 2))));
  const mag = spectrum(x.subarray(0, n), n, 'blackman-harris');
  const center = Math.round((targetHz * n) / sampleRate);
  // 목표 주변 ±8빈 안에서만 피크를 찾는다 (약 ±3Hz)
  let k = Math.min(Math.max(center, 1), mag.length - 2);
  for (let i = Math.max(1, center - 8); i <= Math.min(mag.length - 2, center + 8); i += 1) {
    if (mag[i]! > mag[k]!) k = i;
  }
  const a = Math.log(mag[k - 1]! + EPS);
  const b = Math.log(mag[k]! + EPS);
  const c = Math.log(mag[k + 1]! + EPS);
  const denom = a - 2 * b + c;
  const delta = Math.abs(denom) < 1e-12 ? 0 : (0.5 * (a - c)) / denom;
  return ((k + delta) * sampleRate) / n;
}

/** 목표 대비 음정 오차(센트). 양수면 높다 */
export function preciseCentsError(
  x: Float32Array,
  targetHz: number,
  sampleRate: number,
  size = 131072,
): number {
  const got = preciseFundamentalHz(x, targetHz, sampleRate, size);
  return 1200 * Math.log2(got / targetHz);
}

// --- 트루 피크 ---------------------------------------------------------------

/**
 * **샘플 사이의 피크까지 본다** (ITU-R BS.1770 부속서 2).
 *
 * 샘플 피크가 0dBFS 를 안 넘어도 그 사이는 넘을 수 있다. DAC 이 그 파형을 복원하는
 * 순간, 또는 mp3·AAC 로 인코딩하는 순간 실제로 깎인다 — 우리 파일은 멀쩡한데
 * 사용자가 유튜브에 올리면 찌그러지는 종류의 사고다.
 *
 * 4배 오버샘플링(윈도우드 싱크)으로 근사한다. 규격이 요구하는 최소 배율이다.
 */
export function truePeakDbfs(x: Float32Array, oversample = 4): number {
  const taps = 33;
  const half = (taps - 1) / 2;
  let peak = 0;

  for (let phase = 0; phase < oversample; phase += 1) {
    const offset = phase / oversample;
    // 위상별 다상 필터 계수 — 싱크에 Blackman 창
    const coeff = new Float64Array(taps);
    let sum = 0;
    for (let t = 0; t < taps; t += 1) {
      const m = t - half - offset;
      const sinc = Math.abs(m) < 1e-9 ? 1 : Math.sin(Math.PI * m) / (Math.PI * m);
      const w =
        0.42 - 0.5 * Math.cos((2 * Math.PI * t) / (taps - 1)) +
        0.08 * Math.cos((4 * Math.PI * t) / (taps - 1));
      coeff[t] = sinc * w;
      sum += coeff[t]!;
    }
    for (let t = 0; t < taps; t += 1) coeff[t]! /= sum;

    for (let i = 0; i < x.length; i += 1) {
      let acc = 0;
      for (let t = 0; t < taps; t += 1) {
        const idx = i + t - half;
        acc += (idx >= 0 && idx < x.length ? x[idx]! : 0) * coeff[t]!;
      }
      peak = Math.max(peak, Math.abs(acc));
    }
  }
  return dbfs(peak);
}

// --- 라우드니스 (ITU-R BS.1770-4 / EBU R128) ----------------------------------
//
// **48kHz 계수를 그대로 쓴다.** 규격이 그 표본율에서 정의하고 우리 엔진은 전부
// 48kHz 다. 다른 표본율을 조용히 잘못 재느니 명시적으로 거절한다.

const K_STAGE1 = {
  b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a: [1, -1.69065929318241, 0.73248077421585],
};
const K_STAGE2 = {
  b: [1.0, -2.0, 1.0],
  a: [1, -1.99004745483398, 0.99007225036621],
};

function biquad(x: Float32Array, b: number[], a: number[]): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const out = b[0]! * x[i]! + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = out;
    y[i] = out;
  }
  return y;
}

/** K-가중 필터 — 사람 귀가 느끼는 크기에 맞춘다 (고역 강조 + 초저역 제거) */
export function kWeight(x: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate !== 48000) {
    throw new Error(`LUFS 는 48kHz 에서만 잰다 (받은 값: ${sampleRate})`);
  }
  return biquad(biquad(x, K_STAGE1.b, K_STAGE1.a), K_STAGE2.b, K_STAGE2.a);
}

/**
 * 게이트 적용 통합 라우드니스 (LUFS).
 *
 * **게이트가 핵심이다.** 곡 사이의 무음이나 페이드가 평균을 끌어내리면, 조용한
 * 곡일수록 "더 키워도 된다"고 잘못 판정된다. 절대 게이트(-70 LUFS)로 무음을 빼고,
 * 상대 게이트(-10 LU)로 여린 구간을 뺀다.
 */
export function integratedLufs(channels: readonly Float32Array[], sampleRate: number): number {
  if (channels.length === 0) return -Infinity;
  const weighted = channels.map((ch) => kWeight(ch, sampleRate));
  // 스테레오는 좌우 가중치 1.0. 5.1 의 서라운드 채널만 1.41 이다
  const gains = channels.map(() => 1.0);

  const blockLen = Math.round(0.4 * sampleRate); // 400ms
  const hop = Math.round(blockLen * 0.25); // 75% 중첩
  const loudness: number[] = [];
  const power: number[] = [];

  if (weighted[0]!.length < blockLen) {
    // **짧은 소리**(하이햇·클랩)는 400ms 블록이 하나도 안 나온다. 그대로 두면
    // -Infinity 가 나와서 "측정 불가"가 되는데, 그건 정보가 아니다.
    // 신호 전체를 한 블록으로 보고 잰다 — 규격 밖이지만 비교에는 그게 쓸모 있다
    let z = 0;
    for (let c = 0; c < weighted.length; c += 1) {
      let sum = 0;
      const ch = weighted[c]!;
      for (let i = 0; i < ch.length; i += 1) sum += ch[i]! * ch[i]!;
      z += gains[c]! * (sum / Math.max(ch.length, 1));
    }
    return -0.691 + 10 * Math.log10(Math.max(z, EPS));
  }

  for (let start = 0; start + blockLen <= weighted[0]!.length; start += hop) {
    let z = 0;
    for (let c = 0; c < weighted.length; c += 1) {
      let sum = 0;
      const ch = weighted[c]!;
      for (let i = start; i < start + blockLen; i += 1) sum += ch[i]! * ch[i]!;
      z += gains[c]! * (sum / blockLen);
    }
    power.push(z);
    loudness.push(-0.691 + 10 * Math.log10(Math.max(z, EPS)));
  }
  if (loudness.length === 0) return -Infinity;

  // 절대 게이트
  const absKept = power.filter((_, i) => loudness[i]! > -70);
  if (absKept.length === 0) return -Infinity;
  const absMean = absKept.reduce((s, v) => s + v, 0) / absKept.length;
  const relThreshold = -0.691 + 10 * Math.log10(Math.max(absMean, EPS)) - 10;

  // 상대 게이트
  const kept = power.filter((_, i) => loudness[i]! > -70 && loudness[i]! > relThreshold);
  if (kept.length === 0) return -Infinity;
  const mean = kept.reduce((s, v) => s + v, 0) / kept.length;
  return -0.691 + 10 * Math.log10(Math.max(mean, EPS));
}

/**
 * 두 신호의 라우드니스를 맞춘다. **블라인드 A/B 의 전제조건이다.**
 *
 * 반환은 (맞춰진 신호, 적용한 이득 dB). 이득을 함께 돌려주는 것은 나중에
 * "얼마나 키웠는지"를 리포트에 적기 위해서다 — 20dB 를 키웠다면 그 비교는
 * 애초에 성립하지 않는 조건이었다는 뜻이다.
 */
export function matchLoudness(
  channels: readonly Float32Array[],
  targetLufs: number,
  sampleRate: number,
): { channels: Float32Array[]; gainDb: number } {
  const current = integratedLufs(channels, sampleRate);
  if (!Number.isFinite(current)) {
    return { channels: channels.map((c) => Float32Array.from(c)), gainDb: 0 };
  }
  const gainDb = targetLufs - current;
  const gain = 10 ** (gainDb / 20);
  return {
    channels: channels.map((c) => {
      const out = new Float32Array(c.length);
      for (let i = 0; i < c.length; i += 1) out[i] = c[i]! * gain;
      return out;
    }),
    gainDb,
  };
}

// --- 왜곡과 잡음 -------------------------------------------------------------

export interface ThdResult {
  /** 하모닉 왜곡 + 잡음의 총합 (기본파 대비 dB). 낮을수록 깨끗하다 */
  thdPlusNDb: number;
  /** 하모닉만 (2차 이상) */
  thdDb: number;
  /** 하모닉별 레벨 (기본파 대비 dB) */
  harmonicsDb: number[];
}

/**
 * THD+N — **모든 오디오 제품이 공개하는 숫자**라 그대로 비교된다.
 *
 * 순음을 넣고 기본파를 제거한 나머지가 얼마나 남는지를 본다. 우리 엔진에서는
 * 신스 사인·삼각파 같은 "이론적으로 깨끗해야 하는" 신호에 쓴다 — 줄 악기는
 * 하모닉이 음색 자체라 이 숫자가 의미가 없다.
 */
export function thdPlusN(
  x: Float32Array,
  fundamentalHz: number,
  sampleRate: number,
  harmonicCount = 10,
): ThdResult {
  const size = 1 << Math.floor(Math.log2(Math.max(x.length, 2)));
  // **Blackman-Harris 를 쓴다.** Hann 으로는 기본파의 누설이 잡음 칸으로 새어
  // 들어가서, 완벽한 사인조차 THD+N -43dB 로 읽혔다 (실측). 창을 바꾸니 -115dB.
  const kind: WindowKind = 'blackman-harris';
  const mag = spectrum(x, size, kind);
  const binWidth = sampleRate / size;
  // 주엽이 ±4빈이라 여유를 두고 ±8빈까지 한 성분으로 본다
  const spread = 8;

  const peakAround = (hz: number): { level: number; from: number; to: number } => {
    const center = Math.round(hz / binWidth);
    const from = Math.max(0, center - spread);
    const to = Math.min(mag.length - 1, center + spread);
    let power = 0;
    for (let k = from; k <= to; k += 1) power += mag[k]! * mag[k]!;
    return { level: Math.sqrt(power / ENBW[kind]), from, to };
  };

  const fundamental = peakAround(fundamentalHz);
  const excluded = new Set<number>();
  for (let k = fundamental.from; k <= fundamental.to; k += 1) excluded.add(k);

  const harmonicsDb: number[] = [];
  let harmonicPower = 0;
  for (let h = 2; h <= harmonicCount; h += 1) {
    const hz = fundamentalHz * h;
    if (hz >= sampleRate / 2) break;
    const found = peakAround(hz);
    for (let k = found.from; k <= found.to; k += 1) excluded.add(k);
    harmonicPower += found.level * found.level;
    harmonicsDb.push(20 * Math.log10(Math.max(found.level, EPS) / Math.max(fundamental.level, EPS)));
  }

  // 나머지 전부 = 잡음 + 에일리어싱 + 고차 하모닉
  let restPower = 0;
  for (let k = 1; k < mag.length; k += 1) {
    if (!excluded.has(k)) restPower += mag[k]! * mag[k]!;
  }

  const f = Math.max(fundamental.level, EPS);
  return {
    thdPlusNDb: 10 * Math.log10(Math.max(harmonicPower + restPower, EPS) / (f * f)),
    thdDb: 10 * Math.log10(Math.max(harmonicPower, EPS) / (f * f)),
    harmonicsDb,
  };
}

/** 무음 구간의 잡음 바닥 (dBFS). 24bit 를 쓰는 의미가 여기 있다 */
export function noiseFloorDbfs(x: Float32Array): number {
  return dbfs(rms(x));
}

/**
 * 스펙트럼 무게중심 — **밝기**를 하나의 숫자로.
 *
 * 다른 앱과 음색을 견줄 때 "우리 게 더 어둡다/밝다"를 인상이 아니라 Hz 로 말할 수
 * 있다. 같은 악기·같은 음을 렌더해 이 값이 크게 다르면 톤 필터 설계가 다르다는 뜻이다.
 */
export function spectralCentroidHz(x: Float32Array, sampleRate: number): number {
  const size = 1 << Math.floor(Math.log2(Math.max(x.length, 2)));
  const mag = spectrum(x, size);
  let weighted = 0;
  let total = 0;
  for (let k = 1; k < mag.length; k += 1) {
    const hz = binToHz(k, sampleRate, size);
    weighted += hz * mag[k]!;
    total += mag[k]!;
  }
  return total > EPS ? weighted / total : 0;
}

/** 옥타브 밴드별 에너지 (dB). 두 파일의 음색 차이를 눈으로 볼 수 있게 */
export function octaveBands(
  x: Float32Array,
  sampleRate: number,
): { centerHz: number; db: number }[] {
  const size = 1 << Math.floor(Math.log2(Math.max(x.length, 2)));
  const mag = spectrum(x, size);
  const centers = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  return centers.map((centerHz) => {
    const lo = centerHz / Math.SQRT2;
    const hi = centerHz * Math.SQRT2;
    let power = 0;
    for (let k = 1; k < mag.length; k += 1) {
      const hz = binToHz(k, sampleRate, size);
      if (hz >= lo && hz < hi) power += mag[k]! * mag[k]!;
    }
    return { centerHz, db: 10 * Math.log10(Math.max(power, EPS)) };
  });
}

/**
 * 어택 시간 — 최대치의 10%에서 90%까지 걸린 시간(ms).
 *
 * 타건감이 다르게 들리는 이유가 대개 여기다. 숫자로 재면 "우리 피아노가 물렁하다"를
 * 확인하거나 반박할 수 있다.
 */
export function attackMs(x: Float32Array, sampleRate: number, windowMs = 1): number {
  const env = envelope(x, sampleRate, windowMs);
  // **포락선 인덱스는 샘플 인덱스가 아니다.** 창 하나가 여러 샘플이라, 그대로
  // 나누면 창 배수만큼 짧게 나온다 — 50ms 어택이 0.9ms 로 읽혔다
  const samplesPerStep = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < env.length; i += 1) {
    if (env[i]! > peak) {
      peak = env[i]!;
      peakIdx = i;
    }
  }
  if (peak <= EPS) return 0;
  let start = 0;
  let end = peakIdx;
  for (let i = 0; i <= peakIdx; i += 1) {
    if (env[i]! >= peak * 0.1) {
      start = i;
      break;
    }
  }
  for (let i = start; i <= peakIdx; i += 1) {
    if (env[i]! >= peak * 0.9) {
      end = i;
      break;
    }
  }
  return (((end - start) * samplesPerStep) / sampleRate) * 1000;
}

/** 포락선 (1ms 창 RMS) */
export function envelope(x: Float32Array, sampleRate: number, windowMs = 1): Float32Array {
  const w = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const out = new Float32Array(Math.max(1, Math.floor(x.length / w)));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = rms(x.subarray(i * w, (i + 1) * w));
  }
  return out;
}

/** 스테레오 상관 — +1 은 모노, 0 은 무상관, 음수는 위상이 뒤집혀 모노에서 사라진다 */
export function stereoCorrelation(left: Float32Array, right: Float32Array): number {
  const n = Math.min(left.length, right.length);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += left[i]! * right[i]!;
    sxx += left[i]! * left[i]!;
    syy += right[i]! * right[i]!;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom > EPS ? sxy / denom : 1;
}

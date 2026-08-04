/**
 * 신호 분석 — 음정 정확도 검증과 M1.5 튜닝 도구(`sound.md` 9-6)가 같이 쓴다.
 *
 * M0 스파이크에서 검증된 측정기를 옮겨온 것이다. 버릴 코드에 두면 안 되는 이유:
 * 이 측정기가 `sound.md` 11-1 의 "±1센트 자동 회귀 테스트"를 지탱한다.
 *
 * 측정 방식: 목표 주파수로 복조한 뒤 두 창의 위상 흐름으로 오차를 읽는다.
 * FFT 피크 보간보다 훨씬 정확하다 (0.001센트 수준).
 */

export function centsBetween(fromHz: number, toHz: number): number {
  return 1200 * Math.log2(toHz / fromHz);
}

/**
 * 신호가 실제로 살아 있는 구간.
 *
 * 고정 구간을 쓰면 안 된다 — 고음은 수십~수백 ms 만에 -60dB 로 떨어지므로
 * 창이 소멸 구간에 걸리면 노이즈의 위상을 재게 되고 측정값이 통째로 거짓이 된다.
 * (M0 에서 이 함정 때문에 C8 을 -53센트로 잘못 보고했다)
 */
export function analysisRegion(
  x: Float32Array,
  freqHz: number,
  sampleRate: number,
): { start: number; end: number; period: number } {
  const period = Math.max(8, Math.round(sampleRate / freqHz));
  const blocks = Math.floor(x.length / period);
  const rms = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    for (let i = 0; i < period; i++) {
      const v = x[b * period + i]!;
      sum += v * v;
    }
    rms[b] = Math.sqrt(sum / period);
  }

  let peak = 0;
  for (let b = 0; b < blocks; b++) if (rms[b]! > rms[peak]!) peak = b;

  const floor = rms[peak]! * 0.01; // -40 dB
  let end = blocks;
  for (let b = peak; b < blocks; b++) {
    if (rms[b]! < floor) { end = b; break; }
  }
  return { start: (peak + 1) * period, end: end * period, period };
}

/** 목표 주파수로 복조한 위상. 공통 시간 원점으로 되돌려 둔다 */
function demodPhase(
  x: Float32Array,
  start: number,
  len: number,
  targetHz: number,
  sampleRate: number,
): number {
  const w = (2 * Math.PI * targetHz) / sampleRate;
  let re = 0;
  let im = 0;
  for (let m = 0; m < len; m++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * m) / (len - 1));
    const s = x[start + m]! * win;
    re += s * Math.cos(w * m);
    im -= s * Math.sin(w * m);
  }
  return Math.atan2(im, re) - w * start;
}

function wrapPi(x: number): number {
  let v = x;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v <= -Math.PI) v += 2 * Math.PI;
  return v;
}

export class MeasurementError extends Error {}

/**
 * `targetHz` 근처의 실제 주파수를 측정한다.
 *
 * 창 간격이 넓을수록 정확하지만 위상이 감기면(오차가 ±1/(2·간격) Hz 를 넘으면)
 * 값이 거짓이 된다. 그래서 2패스로 간다: 좁은 간격으로 대충 잡고, 그 값을
 * 기준으로 넓은 간격으로 정밀 측정.
 */
export function measureFreq(x: Float32Array, targetHz: number, sampleRate: number): number {
  const { start, end, period } = analysisRegion(x, targetHz, sampleRate);
  const available = end - start;
  if (available < 12 * period) {
    throw new MeasurementError(
      `측정 구간 부족: ${((available / sampleRate) * 1000).toFixed(1)}ms @ ${targetHz.toFixed(1)}Hz`,
    );
  }

  // 창 길이: 기본음과 2배음이 분리될 만큼(≥8주기), 최대 0.25초, 구간의 45% 이하
  const winLen = Math.max(
    4 * period,
    Math.min(Math.round(0.25 * sampleRate), Math.max(8 * period, 256), Math.floor(available * 0.45)),
  );

  const pass = (target: number, unambiguousCents: number): number => {
    const halfRange = target * (Math.pow(2, unambiguousCents / 1200) - 1);
    const gap = Math.max(32, Math.min(Math.round(sampleRate / (2 * halfRange)), available - winLen));
    if (start + gap + winLen > x.length) throw new MeasurementError('신호 길이 부족');
    const p1 = demodPhase(x, start, winLen, target, sampleRate);
    const p2 = demodPhase(x, start + gap, winLen, target, sampleRate);
    return target + wrapPi(p2 - p1) / (2 * Math.PI * (gap / sampleRate));
  };

  return pass(pass(targetHz, 600), 30);
}

/** 목표 대비 센트 오차. `sound.md` 11-1 의 허용치는 ±1 */
export function measureCentsError(x: Float32Array, targetHz: number, sampleRate: number): number {
  return centsBetween(targetHz, measureFreq(x, targetHz, sampleRate));
}

// ---------------------------------------------------------------------------
// 간섭이 있는 상태에서의 측정
//
// 단일 주파수 복조는 목표 근처에 다른 성분이 있으면 그걸 같이 집는다. 음을 늘어놓고
// 재면 앞 음이 몇 초씩 남아 있고, 앞뒤가 같은 음 ±센트일 때 최악이다
// (처음 종단 테스트가 -14센트 지정에서 -8.6센트로 실패한 원인).
//
// **해법: 같이 울리는 주파수를 모델에 넣고 함께 푼다 (joint least squares).**
// 이게 가능한 이유는 우리가 무슨 음이 울리는지 프로젝트 데이터에서 정확히 알기
// 때문이다. 눈먼 f0 검출(= 오디오 도메인, `plan.md` Phase 4)이 아니라
// **알려진 목표의 검증**이다. 이 구분이 여기 성립하는 근거 전부다.
// ---------------------------------------------------------------------------

/** 대칭 실수 선형계를 부분 피벗팅으로 푼다. 규모가 작아(≤32) 이걸로 충분하다 */
function solveLinearSystem(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = Float64Array.from(a);
  const y = Float64Array.from(b);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row * n + col]!) > Math.abs(m[pivot * n + col]!)) pivot = row;
    }
    if (Math.abs(m[pivot * n + col]!) < 1e-18) return null; // 특이행렬

    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const t = m[col * n + k]!;
        m[col * n + k] = m[pivot * n + k]!;
        m[pivot * n + k] = t;
      }
      const t = y[col]!;
      y[col] = y[pivot]!;
      y[pivot] = t;
    }

    const diag = m[col * n + col]!;
    for (let row = col + 1; row < n; row++) {
      const factor = m[row * n + col]! / diag;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) m[row * n + k] = m[row * n + k]! - factor * m[col * n + k]!;
      y[row] = y[row]! - factor * y[col]!;
    }
  }

  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = y[row]!;
    for (let k = row + 1; k < n; k++) sum -= m[row * n + k]! * x[k]!;
    x[row] = sum / m[row * n + row]!;
  }
  return x;
}

/**
 * 창 하나에서 주어진 주파수들의 진폭·위상을 동시에 추정한다.
 * 반환은 `freqs[0]` (목표) 의 위상 — 공통 시간 원점으로 되돌려 둔 값.
 *
 * 각 성분을 cos/sin 쌍으로 모델링해 가중 최소제곱으로 푼다. 목표 하나만 복조하는
 * 것과 달리, 근처 성분이 목표 계수로 새는 것을 모델이 흡수한다.
 */
function jointPhaseAt(
  x: Float32Array,
  start: number,
  len: number,
  freqs: readonly number[],
  sampleRate: number,
): number | null {
  const k = freqs.length;
  const n = 2 * k;
  const basis: Float64Array[] = [];

  for (const f of freqs) {
    const w = (2 * Math.PI * f) / sampleRate;
    const c = new Float64Array(len);
    const s = new Float64Array(len);
    for (let m = 0; m < len; m++) {
      c[m] = Math.cos(w * m);
      s[m] = Math.sin(w * m);
    }
    basis.push(c, s);
  }

  // 해닝 가중. 창 경계의 불연속이 만드는 누설을 줄인다
  const weight = new Float64Array(len);
  for (let m = 0; m < len; m++) weight[m] = 0.5 - 0.5 * Math.cos((2 * Math.PI * m) / (len - 1));

  const gram = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const bi = basis[i]!;
    for (let j = i; j < n; j++) {
      const bj = basis[j]!;
      let sum = 0;
      for (let m = 0; m < len; m++) sum += weight[m]! * bi[m]! * bj[m]!;
      gram[i * n + j] = sum;
      gram[j * n + i] = sum;
    }
    let sum = 0;
    for (let m = 0; m < len; m++) sum += weight[m]! * bi[m]! * x[start + m]!;
    rhs[i] = sum;
  }

  // 목표와 간섭원이 아주 가까우면 기저가 거의 평행해져 계가 불안정해진다.
  // 아주 작은 릿지 항을 넣어 안정화한다 — 편향은 무시할 수준이고, 없으면 발산한다
  let trace = 0;
  for (let i = 0; i < n; i++) trace += gram[i * n + i]!;
  const ridge = (trace / n) * 1e-9;
  for (let i = 0; i < n; i++) gram[i * n + i] = gram[i * n + i]! + ridge;

  const coef = solveLinearSystem(gram, rhs, n);
  if (!coef) return null;

  // a·cos(wm) + b·sin(wm) = A·cos(wm + θ), θ = atan2(-b, a)
  const a = coef[0]!;
  const b = coef[1]!;
  const wTarget = (2 * Math.PI * freqs[0]!) / sampleRate;
  return Math.atan2(-b, a) - wTarget * start;
}

export interface JointMeasureOptions {
  /** 같이 울리고 있는 성분들의 기본 주파수. 목표는 넣지 않는다 */
  interferersHz?: readonly number[];
  /** 각 성분의 하모닉을 몇 배음까지 모델에 넣을지 */
  harmonics?: number;
  /** 측정 시작 위치(샘플). 생략하면 엔벌로프에서 찾는다 */
  start?: number;
  /** 쓸 수 있는 구간 길이(샘플). 생략하면 신호 끝까지 */
  available?: number;
}

/**
 * 간섭이 있는 상태에서 `targetHz` 의 실제 주파수를 측정한다.
 *
 * 알려진 성분을 모델에 넣고 함께 풀기 때문에, 앞 음이 울리고 있어도 목표의
 * 위상 흐름을 읽을 수 있다. 목표 주파수·간섭 주파수를 **정확히 알 때만** 쓴다.
 */
export function measureFreqInContext(
  x: Float32Array,
  targetHz: number,
  sampleRate: number,
  options: JointMeasureOptions = {},
): number {
  const harmonics = options.harmonics ?? 3;
  const interferers = options.interferersHz ?? [];

  const start = options.start ?? analysisRegion(x, targetHz, sampleRate).start;
  const available = options.available ?? x.length - start;
  const period = Math.max(8, Math.round(sampleRate / targetHz));
  if (available < 12 * period) {
    throw new MeasurementError(
      `측정 구간 부족: ${((available / sampleRate) * 1000).toFixed(1)}ms @ ${targetHz.toFixed(1)}Hz`,
    );
  }

  const nyquist = sampleRate / 2;
  const buildBasis = (target: number): number[] => {
    const freqs = [target];
    const push = (f: number) => {
      if (f <= 0 || f >= nyquist) return;
      // 이미 있는 주파수와 거의 같으면 넣지 않는다 — 완전 평행한 기저는 계를 망친다.
      // 목표(index 0)는 절대 제외되지 않는다
      if (freqs.some((g) => Math.abs(g - f) < 0.05)) return;
      freqs.push(f);
    };
    for (let h = 2; h <= harmonics; h++) push(target * h);
    for (const base of interferers) {
      for (let h = 1; h <= harmonics; h++) push(base * h);
    }
    return freqs;
  };

  const winLen = Math.max(
    4 * period,
    Math.min(Math.round(0.4 * sampleRate), Math.max(16 * period, 512), Math.floor(available * 0.45)),
  );

  const pass = (target: number, unambiguousCents: number): number => {
    const halfRange = target * (Math.pow(2, unambiguousCents / 1200) - 1);
    const gap = Math.max(32, Math.min(Math.round(sampleRate / (2 * halfRange)), available - winLen));
    if (start + gap + winLen > x.length) throw new MeasurementError('신호 길이 부족');
    const freqs = buildBasis(target);
    const p1 = jointPhaseAt(x, start, winLen, freqs, sampleRate);
    const p2 = jointPhaseAt(x, start + gap, winLen, freqs, sampleRate);
    if (p1 === null || p2 === null) throw new MeasurementError('연립방정식이 풀리지 않는다 (기저가 평행)');
    return target + wrapPi(p2 - p1) / (2 * Math.PI * (gap / sampleRate));
  };

  return pass(pass(targetHz, 600), 30);
}

/** 간섭이 있는 상태에서의 센트 오차 */
export function measureCentsErrorInContext(
  x: Float32Array,
  targetHz: number,
  sampleRate: number,
  options: JointMeasureOptions = {},
): number {
  return centsBetween(targetHz, measureFreqInContext(x, targetHz, sampleRate, options));
}

/** 결정론적 테스트용 LCG. `Math.random` 을 대체해 주입한다 */
export function seededRng(seed = 0x2f6e2b1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

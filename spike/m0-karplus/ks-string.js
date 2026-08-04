/**
 * M0 스파이크 — Karplus-Strong 줄 모델 (JS)
 *
 * 이 파일은 **버릴 코드**다. M1에서 Rust로 다시 쓴다 (sound.md 10절).
 * 목적은 하나: "줄 길이를 바꾸면 소리가 달라지는가"를 귀로 확인하는 것.
 *
 * 워크렛(ks-processor.js)과 음정 테스트(test-pitch.mjs)가 **같은 이 파일**을 쓴다.
 * 브라우저에서 들은 소리와 테스트가 측정한 음정이 같은 코드에서 나와야 검증에 의미가 있다.
 */

/** 기준 스케일 — 스트라토캐스터 648mm (sound.md 8절) */
export const REF_SCALE_MM = 648;

/** 분산(강성) 올패스 캐스케이드 단수 */
const DISPERSION_STAGES = 3;

/** 딜레이 라인이 커버하는 최저 음 */
const MIN_FREQ_HZ = 20;

// ---------------------------------------------------------------------------
// 위상 지연 계산
//
// 루프 안에는 딜레이 라인 말고도 감쇠 필터와 분산 올패스가 들어 있고, 이들도
// 각각 지연을 만든다. 이걸 빼주지 않으면 음정이 낮아진다 (sound.md 6-2).
// ---------------------------------------------------------------------------

/** 원제로 감쇠 필터 H(z) = (1-s) + s·z⁻¹ 의 위상 지연 (샘플) */
function oneZeroPhaseDelay(s, w) {
  if (w < 1e-9) return s;
  const re = (1 - s) + s * Math.cos(w);
  const im = -s * Math.sin(w);
  return -Math.atan2(im, re) / w;
}

/**
 * 1차 올패스 A(z) = (a + z⁻¹)/(1 + a·z⁻¹) 의 위상 지연 (샘플).
 *
 * A(z) = z⁻¹·(1 + a·z)/(1 + a·z⁻¹) 로 분해하면 위상이
 *   θ(ω) = -ω + 2·atan2(a·sinω, 1 + a·cosω)
 * 가 된다. |a| < 1 이면 1 + a·cosω > 0 이므로 atan2 가 절대 감기지 않는다
 * → 언랩 없이 전 대역에서 정확하다. (a - z⁻¹ 형태로 직접 atan2 하면 감긴다)
 *
 * a < 0 이면 지연이 주파수에 따라 **줄어든다** → 상위 하모닉이 위로 밀린다
 * = 실제 강성 있는 줄의 인하모니시티(f_n = n·f0·√(1+B·n²))와 같은 방향.
 * DC 극한은 (1-a)/(1+a).
 */
function allpassPhaseDelay(a, w) {
  if (w < 1e-9) return (1 - a) / (1 + a);
  const theta = -w + 2 * Math.atan2(a * Math.sin(w), 1 + a * Math.cos(w));
  return -theta / w;
}

/** 올패스 보간 계수 범위 — 이 밖으로 나가면 보간 정확도·안정성이 나빠진다 */
const AP_COEF_MIN = -0.92;
const AP_COEF_MAX = 0.92;

/**
 * 기본음 ω 에서 위상 지연이 정확히 `frac` 샘플이 되는 올패스 계수를 찾는다.
 *
 * 교과서의 c = (1-frac)/(1+frac) 는 **DC에서만** 맞는다. 고음에서는 실제 지연이
 * 그보다 짧아져 음이 샤프해진다 (C8에서 수 센트~수십 센트). 그래서 DC 공식을
 * 쓰지 않고 기본음 주파수에서 직접 푼다. 위상 지연은 a 에 대해 단조 감소한다.
 *
 * 범위를 벗어나면 null — 호출자가 정수 딜레이를 한 칸 조정해 다시 시도한다.
 */
function solveAllpassCoef(frac, w) {
  if (frac > allpassPhaseDelay(AP_COEF_MIN, w)) return null;
  if (frac < allpassPhaseDelay(AP_COEF_MAX, w)) return null;
  let lo = AP_COEF_MIN;
  let hi = AP_COEF_MAX;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (allpassPhaseDelay(mid, w) > frac) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------------
// 파라미터 → 물리량 매핑
//
// 근거: 같은 음정을 같은 굵기 줄로 낼 때 장력은 T = 4·f0²·L²·μ 이고,
// 인하모니시티 계수는 B ∝ E·d⁴/(T·L²) ∝ E·d²/(f0²·L⁴).
// → **음정을 고정하고 줄을 짧게 하면 인하모니시티가 급격히 커진다** (L⁻⁴).
//   레스폴(628)이 스트랫(648)보다 덜 밝고 덜 팽팽하게 들리는 방향과 일치.
//
// 정확한 수치가 아니라 "차이가 들리는가"를 보려는 매핑이다. 실제 튜닝은 M1.5의
// 튜닝 도구(sound.md 9-6)로 귀로 잡는다.
// ---------------------------------------------------------------------------

export const DEFAULT_PARAMS = {
  scaleLengthMm: REF_SCALE_MM, // 300~900
  stiffness: 0.012,            // 0~0.05  기준 스케일에서의 분산 계수
  // 고역 감쇠. 원제로 루프 필터의 감쇠는 주파수에 비례해 커지므로 이 값이 크면
  // 고음의 기본음까지 같이 죽는다 (0.18에서 C8이 50ms 만에 소멸했다).
  // 0.05 부근이 "고음은 짧게 울리지만 음으로 들리는" 지점.
  damping: 0.05,               // 0~0.25
  sustainSec: 3.0,             // 0.3~10  기준 스케일에서의 기본음 T60
  pluckPosition: 0.18,         // 0.02~0.5  브리지 기준
  pluckHardness: 0.4,          // 0~1  0=부드럽게(둥근), 1=딱딱하게(밝은)
  fractionalDelay: true,       // false = 정수 샘플로 반올림 (A/B용)
};

/**
 * 파라미터 → 루프 계수 환산. pluck() 과 UI 표시가 **같은 이 함수**를 쓴다.
 * 화면에 뜬 센트 오차가 실제로 소리 나는 것과 다르면 A/B 자체가 무의미해진다.
 */
export function computeLoop(freqHz, params, fs) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const w = (2 * Math.PI * freqHz) / fs;
  const ratio = REF_SCALE_MM / p.scaleLengthMm;

  // 고역 감쇠: 짧은 줄 = 낮은 장력 = 고역이 빨리 죽는다
  const lpCoef = Math.min(0.4, Math.max(0.0, p.damping * ratio));

  // 분산(강성): B ∝ L⁻⁴. 음이 높으면 주기 자체가 짧아 보정할 여유가 없으므로
  // 딜레이가 남지 않는 선까지 강성을 되돌린다.
  let dispMag = Math.min(0.6, p.stiffness * Math.pow(ratio, 4));
  const targetDelay = fs / freqHz; // 이 음의 한 주기 (분수)
  let inLoop = 0;
  let lineDelay = 0;
  for (let guard = 0; guard < 64; guard++) {
    inLoop = oneZeroPhaseDelay(lpCoef, w) + DISPERSION_STAGES * allpassPhaseDelay(-dispMag, w);
    lineDelay = targetDelay - inLoop;
    if (lineDelay >= 2.0 || dispMag <= 0) break;
    dispMag = Math.max(0, dispMag - 0.02); // 고음에서는 강성을 포기한다
  }

  return { w, ratio, lpCoef, dispCoef: -dispMag, targetDelay, inLoop, lineDelay };
}

/**
 * 분수 딜레이를 껐을 때(정수 반올림) 음정이 얼마나 틀어지는지 — 센트.
 * 실측이 아니라 루프 방정식에서 바로 나오는 값이라 정확하다 (sound.md 6-2).
 */
export function roundedDelayErrorCents(freqHz, params, fs) {
  const { targetDelay, inLoop, lineDelay } = computeLoop(freqHz, params, fs);
  const rounded = Math.max(2, Math.round(lineDelay));
  return 1200 * Math.log2(targetDelay / (rounded + inLoop));
}

export class KSString {
  constructor(sampleRate) {
    this.fs = sampleRate;
    this.size = Math.ceil(sampleRate / MIN_FREQ_HZ) + 8;
    this.buf = new Float32Array(this.size);

    this.wIdx = 0;
    this.delayInt = 1;
    this.apCoef = 0;   // 분수 딜레이 올패스 계수
    this.apState = 0;
    this.lpState = 0;  // 원제로 감쇠 필터의 이전 입력
    this.lpCoef = 0;
    this.loopGain = 0;
    this.dispCoef = 0;
    this.dispState = new Float32Array(DISPERSION_STAGES);

    this.params = { ...DEFAULT_PARAMS };
    this.freq = 0;
    this.active = false;

    /** 마지막 pluck에서 실제로 쓰인 루프 딜레이 — 테스트/표시용 */
    this.actualLoopDelay = 0;
  }

  setParams(p) {
    Object.assign(this.params, p);
  }

  /** 노트 시작. 파라미터를 딜레이 길이·필터 계수로 환산하고 여진을 채운다. */
  pluck(freqHz, velocity = 1) {
    const p = this.params;
    const fs = this.fs;
    this.freq = freqHz;

    const { w, ratio, lpCoef, dispCoef, lineDelay } = computeLoop(freqHz, p, fs);
    this.lpCoef = lpCoef;
    this.dispCoef = dispCoef;

    // 분수 딜레이 (sound.md 6-2 — 타협 불가 항목)
    // 정수 딜레이 라인 + 1차 올패스 보간. 올패스가 기본음에서 정확히 나머지
    // 소수 샘플만큼 지연되도록 계수를 푼다. 목표 소수부는 1 근처로 잡는다
    // (올패스 보간은 지연이 1 부근일 때 가장 정확하다).
    if (p.fractionalDelay) {
      let nInt = Math.max(1, Math.floor(lineDelay - 0.5));
      let coef = solveAllpassCoef(lineDelay - nInt, w);
      // 못 풀면 정수 칸을 옮겨 소수부를 올패스가 다룰 수 있는 범위로 밀어 넣는다
      for (let step = 1; coef === null && step <= 4; step++) {
        for (const cand of [nInt + step, nInt - step]) {
          if (cand < 1) continue;
          const c = solveAllpassCoef(lineDelay - cand, w);
          if (c !== null) { nInt = cand; coef = c; break; }
        }
      }
      this.delayInt = nInt;
      this.apCoef = coef === null ? 0 : coef;
      this.actualLoopDelay = lineDelay;
    } else {
      const rounded = Math.max(2, Math.round(lineDelay));
      this.delayInt = rounded - 1;
      this.apCoef = 0;                          // 지연 = 정확히 1샘플
      this.actualLoopDelay = rounded;
    }

    // 루프 게인 — 기본음의 T60으로 지정. 긴 줄이 더 길게 울린다.
    const t60 = Math.max(0.05, p.sustainSec * Math.pow(1 / ratio, 1.5));
    this.loopGain = Math.pow(10, (-3 * this.actualLoopDelay) / (t60 * fs));

    // ---- 여진 -------------------------------------------------------------
    this.buf.fill(0);
    this.apState = 0;
    this.lpState = 0;
    this.dispState.fill(0);

    // 길이는 정확히 딜레이 라인 길이여야 한다. +1 하면 buf[0] 이 한 번도 읽히지
    // 않아서(첫 읽기 인덱스가 1이 된다) 실제로 순환하는 내용의 합이 0이 아니게 되고,
    // 아래에서 DC를 빼도 DC 모드가 남는다.
    const n = Math.max(1, this.delayInt);
    const burst = new Float32Array(n);

    // 뜯는 세기 → 노이즈 저역통과. 부드럽게 뜯으면 고역이 적다.
    const soft = 1 - p.pluckHardness;
    const lpA = Math.min(0.98, soft * 0.95);
    let z = 0;
    for (let i = 0; i < n; i++) {
      const noise = Math.random() * 2 - 1;
      z = (1 - lpA) * noise + lpA * z;
      burst[i] = z;
    }

    // 뜯는 위치 → 콤 필터. 위치 β 에서 1/β 배수 하모닉에 노치가 생긴다.
    const beta = Math.min(0.5, Math.max(0.01, p.pluckPosition));
    const combDelay = beta * n;
    if (combDelay >= 1) {
      const d0 = Math.floor(combDelay);
      const dFrac = combDelay - d0;
      const combed = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = i - d0 >= 0 ? burst[i - d0] : 0;
        const b = i - d0 - 1 >= 0 ? burst[i - d0 - 1] : 0;
        combed[i] = burst[i] - ((1 - dFrac) * a + dFrac * b);
      }
      burst.set(combed);
    }

    // DC 제거 — 루프 필터는 DC에서 이득이 정확히 1이므로, 여진에 실린 DC는
    // 루프 게인만으로 천천히 빠진다(T60 전체). 음으로는 안 들리면서 헤드룸을
    // 절반 이상 먹고 노트를 쌓으면 누적된다. 들어가기 전에 빼는 게 유일하게 싸다.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += burst[i];
    mean /= n;
    for (let i = 0; i < n; i++) burst[i] -= mean;

    // 정규화 후 세기 반영
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(burst[i]));
    const scale = peak > 1e-9 ? (0.5 * velocity) / peak : 0;
    for (let i = 0; i < n; i++) this.buf[i] = burst[i] * scale;

    this.wIdx = n % this.size;
    this.active = true;
  }

  /** 음 끊기 — 손으로 줄을 짚는 것에 해당 (급하게 감쇠) */
  mute() {
    this.loopGain *= 0.9;
    this.lpCoef = 0.49;
  }

  /** out 에 **더한다** (믹싱은 호출자 책임) */
  process(out, frames) {
    if (!this.active) return;

    const buf = this.buf;
    const size = this.size;
    const dc = this.dispCoef;
    const c = this.apCoef;
    const s = this.lpCoef;
    const g = this.loopGain;
    const stages = this.dispState;

    let w = this.wIdx;
    let apZ = this.apState;
    let lpZ = this.lpState;
    let quiet = true;

    for (let i = 0; i < frames; i++) {
      let r = w - this.delayInt;
      if (r < 0) r += size;
      let v = buf[r];

      // 분산 올패스 캐스케이드 — y = a·x + z ; z = x - a·y
      for (let k = 0; k < DISPERSION_STAGES; k++) {
        const y = dc * v + stages[k];
        stages[k] = v - dc * y;
        v = y;
      }

      // 감쇠: 원제로 저역통과 + 루프 게인
      const lp = (1 - s) * v + s * lpZ;
      lpZ = v;
      v = lp * g;

      // 분수 딜레이 올패스
      const y = c * v + apZ;
      apZ = v - c * y;

      buf[w] = y;
      out[i] += y;
      if (Math.abs(y) > 1e-5) quiet = false;

      w = w + 1 === size ? 0 : w + 1;
    }

    // 수치 안정성 (sound.md 6-5) — NaN 하나가 이후 전체를 무음으로 만든다
    if (!Number.isFinite(apZ) || !Number.isFinite(lpZ)) {
      this.reset();
      return;
    }

    this.wIdx = w;
    this.apState = apZ;
    this.lpState = lpZ;
    if (quiet) this.active = false;
  }

  reset() {
    this.buf.fill(0);
    this.dispState.fill(0);
    this.apState = 0;
    this.lpState = 0;
    this.active = false;
  }
}

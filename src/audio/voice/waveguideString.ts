/**
 * 웨이브가이드 줄 보이스 (Karplus-Strong 확장).
 *
 * **임시 구현이다.** M1에서 Rust→WASM 으로 대체된다 (`sound.md` 10절).
 * 그때까지 앱이 실제로 소리를 내는 경로이므로 스파이크 코드가 아니라 여기 둔다.
 *
 * M0 (`spike/m0-karplus/`) 에서 확인한 함정을 처음부터 반영했다. 순서대로:
 *  1. 올패스 보간 계수를 **기본음 주파수에서 푼다** — 교과서 공식은 DC 에서만 맞다
 *  2. 루프 안 모든 필터의 위상 지연을 뺀다 — 분산 3단이 C8 에서 4샘플을 먹는다
 *  3. 여진의 DC 를 제거하고 여진 길이를 딜레이 라인과 **정확히** 맞춘다
 *  4. 감쇠는 고음의 기본음까지 죽인다 — 기본값을 낮게 잡는다
 *
 * 미해결 (M1): `sustainSec` 이 고음에서 동작하지 않는다. 루프 필터를 기본음에서
 * 단위 이득으로 정규화하면 정확해지지만 DC 이득이 1을 넘어 발산하므로
 * 루프 안 DC 차단기가 전제다.
 */

import type { ParamValue } from '../../instruments/types.ts';
import type { Rng, Voice } from './types.ts';

const DISPERSION_STAGES = 3;
const MIN_FREQ_HZ = 20;
const REF_SCALE_MM = 648;

const AP_COEF_MIN = -0.92;
const AP_COEF_MAX = 0.92;

/** 원제로 감쇠 필터 H(z) = (1-s) + s·z⁻¹ 의 위상 지연 (샘플) */
function oneZeroPhaseDelay(s: number, w: number): number {
  if (w < 1e-9) return s;
  const re = (1 - s) + s * Math.cos(w);
  const im = -s * Math.sin(w);
  return -Math.atan2(im, re) / w;
}

/**
 * 1차 올패스 A(z) = (a + z⁻¹)/(1 + a·z⁻¹) 의 위상 지연 (샘플).
 *
 * θ(ω) = -ω + 2·atan2(a·sinω, 1 + a·cosω) 로 쓰면 |a|<1 에서 1 + a·cosω > 0 이므로
 * atan2 가 절대 감기지 않는다 → 언랩 없이 전 대역에서 정확하다.
 * DC 극한은 (1-a)/(1+a). a < 0 이면 지연이 주파수에 따라 줄어들어
 * 상위 하모닉이 위로 밀린다 = 강성 있는 줄의 인하모니시티와 같은 방향.
 */
function allpassPhaseDelay(a: number, w: number): number {
  if (w < 1e-9) return (1 - a) / (1 + a);
  return -(-w + 2 * Math.atan2(a * Math.sin(w), 1 + a * Math.cos(w))) / w;
}

/**
 * 기본음 ω 에서 위상 지연이 정확히 `frac` 샘플이 되는 올패스 계수.
 * 교과서의 c = (1-frac)/(1+frac) 는 DC 에서만 맞고, 고음에서는 실제 지연이 짧아져
 * 음이 샤프해진다 (C8 에서 10~19센트). 위상 지연은 a 에 대해 단조 감소한다.
 */
function solveAllpassCoef(frac: number, w: number): number | null {
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

export interface StringParams {
  scaleLengthMm: number;
  stiffness: number;
  damping: number;
  sustainSec: number;
  pluckPosition: number;
  pluckHardness: number;
}

const FALLBACK: StringParams = {
  scaleLengthMm: REF_SCALE_MM,
  stiffness: 0.012,
  damping: 0.05,
  sustainSec: 3,
  pluckPosition: 0.18,
  pluckHardness: 0.4,
};

function num(params: Readonly<Record<string, ParamValue>>, key: keyof StringParams): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : FALLBACK[key];
}

export interface LoopCoefficients {
  /** 기본음의 정규화 각주파수 */
  w: number;
  lpCoef: number;
  dispCoef: number;
  /** 이 음의 한 주기 (분수 샘플) */
  targetDelay: number;
  /** 루프 안 필터들이 만드는 지연의 합 */
  inLoopDelay: number;
  /** 딜레이 라인 + 분수 보간이 담당해야 하는 지연 */
  lineDelay: number;
}

/**
 * 파라미터 → 루프 계수. `noteOn` 과 표시·검증이 같은 이 함수를 쓴다.
 * 화면에 뜬 값이 실제로 소리 나는 것과 다르면 검증 자체가 무의미해진다.
 */
export function computeLoop(freqHz: number, params: StringParams, sampleRate: number): LoopCoefficients {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const ratio = REF_SCALE_MM / params.scaleLengthMm;

  const lpCoef = Math.min(0.4, Math.max(0, params.damping * ratio));

  // 분산(강성): 같은 음정을 짧은 줄로 내면 장력이 낮아 인하모니시티가 커진다 (B ∝ L⁻⁴).
  // 고음은 주기 자체가 짧아 보정할 여유가 없으므로 딜레이가 남는 선까지 되돌린다.
  let dispMag = Math.min(0.6, params.stiffness * Math.pow(ratio, 4));
  const targetDelay = sampleRate / freqHz;
  let inLoopDelay = 0;
  let lineDelay = 0;
  for (let guard = 0; guard < 64; guard++) {
    inLoopDelay =
      oneZeroPhaseDelay(lpCoef, w) + DISPERSION_STAGES * allpassPhaseDelay(-dispMag, w);
    lineDelay = targetDelay - inLoopDelay;
    if (lineDelay >= 2 || dispMag <= 0) break;
    dispMag = Math.max(0, dispMag - 0.02);
  }

  return { w, lpCoef, dispCoef: -dispMag, targetDelay, inLoopDelay, lineDelay };
}

export class WaveguideStringVoice implements Voice {
  private readonly sampleRate: number;
  private readonly rng: Rng;
  private readonly buf: Float32Array;
  private readonly size: number;
  private readonly dispState: Float32Array;

  private wIdx = 0;
  private delayInt = 1;
  private apCoef = 0;
  private apState = 0;
  private lpState = 0;
  private lpCoef = 0;
  private dispCoef = 0;
  private loopGain = 0;

  private isActive = false;

  /** 마지막 발음의 실제 루프 딜레이 — 검증·표시용 */
  actualLoopDelay = 0;

  constructor(sampleRate: number, rng: Rng = Math.random) {
    this.sampleRate = sampleRate;
    this.rng = rng;
    this.size = Math.ceil(sampleRate / MIN_FREQ_HZ) + 8;
    this.buf = new Float32Array(this.size);
    this.dispState = new Float32Array(DISPERSION_STAGES);
  }

  get active(): boolean {
    return this.isActive;
  }

  noteOn(freqHz: number, velocity: number, params: Readonly<Record<string, ParamValue>>): void {
    const p: StringParams = {
      scaleLengthMm: num(params, 'scaleLengthMm'),
      stiffness: num(params, 'stiffness'),
      damping: num(params, 'damping'),
      sustainSec: num(params, 'sustainSec'),
      pluckPosition: num(params, 'pluckPosition'),
      pluckHardness: num(params, 'pluckHardness'),
    };

    const { w, lpCoef, dispCoef, lineDelay } = computeLoop(freqHz, p, this.sampleRate);
    this.lpCoef = lpCoef;
    this.dispCoef = dispCoef;

    // 함정 1·2: 분수 딜레이 계수를 기본음에서 푼다
    let nInt = Math.max(1, Math.floor(lineDelay - 0.5));
    let coef = solveAllpassCoef(lineDelay - nInt, w);
    for (let step = 1; coef === null && step <= 4; step++) {
      for (const cand of [nInt + step, nInt - step]) {
        if (cand < 1) continue;
        const c = solveAllpassCoef(lineDelay - cand, w);
        if (c !== null) { nInt = cand; coef = c; break; }
      }
    }
    this.delayInt = nInt;
    this.apCoef = coef ?? 0;
    this.actualLoopDelay = lineDelay;

    const ratio = REF_SCALE_MM / p.scaleLengthMm;
    const t60 = Math.max(0.05, p.sustainSec * Math.pow(1 / ratio, 1.5));
    this.loopGain = Math.pow(10, (-3 * lineDelay) / (t60 * this.sampleRate));

    this.fillExcitation(p, velocity);
    this.isActive = true;
  }

  /** 함정 3: 여진 길이는 딜레이 라인과 정확히 같고, DC 는 0이어야 한다 */
  private fillExcitation(p: StringParams, velocity: number): void {
    this.buf.fill(0);
    this.apState = 0;
    this.lpState = 0;
    this.dispState.fill(0);

    const n = Math.max(1, this.delayInt);
    const burst = new Float32Array(n);

    // 뜯는 세기 → 노이즈 저역통과. 부드럽게 뜯으면 고역이 적다
    const lpA = Math.min(0.98, (1 - p.pluckHardness) * 0.95);
    let z = 0;
    for (let i = 0; i < n; i++) {
      z = (1 - lpA) * (this.rng() * 2 - 1) + lpA * z;
      burst[i] = z;
    }

    // 뜯는 위치 → 콤 필터. 위치 β 에서 1/β 배수 하모닉에 노치가 생긴다
    const beta = Math.min(0.5, Math.max(0.01, p.pluckPosition));
    const combDelay = beta * n;
    if (combDelay >= 1) {
      const d0 = Math.floor(combDelay);
      const dFrac = combDelay - d0;
      const combed = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = i - d0 >= 0 ? burst[i - d0]! : 0;
        const b = i - d0 - 1 >= 0 ? burst[i - d0 - 1]! : 0;
        combed[i] = burst[i]! - ((1 - dFrac) * a + dFrac * b);
      }
      burst.set(combed);
    }

    // DC 제거 — 루프 필터는 DC 에서 이득이 정확히 1이라 한 번 들어간 DC 가
    // 루프 게인만으로 빠진다. 음으로는 안 들리면서 헤드룸을 절반 이상 먹는다
    let mean = 0;
    for (let i = 0; i < n; i++) mean += burst[i]!;
    mean /= n;

    let peak = 0;
    for (let i = 0; i < n; i++) {
      burst[i] = burst[i]! - mean;
      peak = Math.max(peak, Math.abs(burst[i]!));
    }

    const scale = peak > 1e-9 ? (0.5 * velocity) / peak : 0;
    for (let i = 0; i < n; i++) this.buf[i] = burst[i]! * scale;

    this.wIdx = n % this.size;
  }

  noteOff(): void {
    if (!this.isActive) return;
    this.loopGain *= 0.9;
    this.lpCoef = 0.4;
  }

  process(out: Float32Array, frames: number): void {
    if (!this.isActive) return;

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
      let v = buf[r]!;

      // 분산 올패스 캐스케이드 — y = a·x + z ; z = x - a·y
      for (let k = 0; k < DISPERSION_STAGES; k++) {
        const y = dc * v + stages[k]!;
        stages[k] = v - dc * y;
        v = y;
      }

      const lp = (1 - s) * v + s * lpZ;
      lpZ = v;
      v = lp * g;

      const y = c * v + apZ;
      apZ = v - c * y;

      buf[w] = y;
      out[i] = out[i]! + y;
      if (Math.abs(y) > 1e-5) quiet = false;

      w = w + 1 === size ? 0 : w + 1;
    }

    // 수치 안정성 (`sound.md` 6-5) — NaN 하나가 이후 전체를 무음으로 만든다
    if (!Number.isFinite(apZ) || !Number.isFinite(lpZ)) {
      this.reset();
      return;
    }

    this.wIdx = w;
    this.apState = apZ;
    this.lpState = lpZ;
    if (quiet) this.isActive = false;
  }

  reset(): void {
    this.buf.fill(0);
    this.dispState.fill(0);
    this.apState = 0;
    this.lpState = 0;
    this.isActive = false;
  }
}

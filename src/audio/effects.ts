/**
 * 이펙트 — EQ · 컴프레서 · 리버브 (`plan.md` 5-1 Phase 1 기본기).
 *
 * **Web Audio 내장 노드를 빌려 쓴다** (`plan.md` 5-2 "다듬는 층"). 직접 구현하지
 * 않는 이유: 그래프 끝단의 잎사귀라 교체가 국소 작업이고, 여기서 남을 이겨봐야
 * 제품 경쟁력이 되지 않는다. 재현성을 위해 Rust 로 옮기는 것은 Phase 2+ 다.
 *
 * 이 파일의 구조: **파라미터 매핑은 순수 함수, 노드 생성은 별도.**
 * 매핑을 분리해 두면 브라우저 없이 테스트할 수 있다 — "리버브 mix 0.7 이 실제로
 * 어떤 게인이 되는가" 같은 것이 조용히 틀리면 귀로만 잡힌다.
 */

import type { EffectSpec } from '../model/project.ts';

export type EffectType = 'eq' | 'compressor' | 'reverb';

export interface EffectParamSpec {
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  /** 슬라이더 반응 곡선 */
  curve?: 'linear' | 'log';
}

/** 이펙트별 파라미터 선언 — UI 가 이걸 보고 자동 생성한다 (`sound.md` 9-5 와 같은 원칙) */
export const EFFECT_SPECS: Record<EffectType, { label: string; params: Record<string, EffectParamSpec> }> = {
  eq: {
    label: 'EQ',
    params: {
      lowGainDb: { label: '저역', min: -18, max: 18, default: 0, unit: 'dB' },
      midGainDb: { label: '중역', min: -18, max: 18, default: 0, unit: 'dB' },
      highGainDb: { label: '고역', min: -18, max: 18, default: 0, unit: 'dB' },
      midHz: { label: '중역 중심', min: 200, max: 5000, default: 1000, unit: 'Hz', curve: 'log' },
    },
  },
  compressor: {
    label: '컴프레서',
    params: {
      thresholdDb: { label: '스레숄드', min: -60, max: 0, default: -18, unit: 'dB' },
      ratio: { label: '레이시오', min: 1, max: 20, default: 3 },
      attackMs: { label: '어택', min: 0, max: 200, default: 8, unit: 'ms' },
      releaseMs: { label: '릴리즈', min: 10, max: 1000, default: 180, unit: 'ms' },
      makeupDb: { label: '메이크업', min: 0, max: 18, default: 0, unit: 'dB' },
    },
  },
  reverb: {
    label: '리버브',
    params: {
      mix: { label: '섞기', min: 0, max: 1, default: 0.2 },
      decaySec: { label: '길이', min: 0.1, max: 8, default: 1.6, unit: 's' },
      dampingHz: { label: '고역 감쇠', min: 500, max: 16000, default: 4000, unit: 'Hz', curve: 'log' },
    },
  },
};

export function isEffectType(type: string): type is EffectType {
  return type in EFFECT_SPECS;
}

/** 선언된 기본값으로 채운 이펙트 하나 */
export function createEffect(type: EffectType): EffectSpec {
  const params: Record<string, number> = {};
  for (const [key, spec] of Object.entries(EFFECT_SPECS[type].params)) {
    params[key] = spec.default;
  }
  return { type, bypass: false, params };
}

/** 선언 범위로 자른 파라미터. 범위 밖 값은 노드를 발산시키거나 예외를 던진다 */
export function resolveEffectParams(spec: EffectSpec): Record<string, number> {
  if (!isEffectType(spec.type)) {
    throw new Error(`알 수 없는 이펙트: ${spec.type}`);
  }
  const declared = EFFECT_SPECS[spec.type].params;
  const out: Record<string, number> = {};
  for (const [key, param] of Object.entries(declared)) {
    const raw = spec.params[key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : param.default;
    out[key] = Math.min(param.max, Math.max(param.min, value));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 리버브 임펄스 응답
//
// `ConvolverNode` 는 IR 이 필요하다. 실측 IR 은 에셋이므로 지금은 **합성한다** —
// 지수 감쇠 노이즈에 고역 감쇠를 걸면 그럴듯한 홀이 된다. 실측 IR 로 바꾸는 것은
// 에셋이 확보된 뒤의 일이고, 그때 이 함수만 교체하면 된다.
// ---------------------------------------------------------------------------

/** 결정론적 IR 을 위한 LCG — 같은 파라미터면 같은 리버브여야 한다 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * 리버브 IR 을 만든다. 브라우저 없이 테스트할 수 있게 순수 함수로 둔다.
 *
 * 앞 20ms 를 살짝 눌러 프리딜레이 느낌을 준다 — 없으면 소리가 시작부터 뭉개진다.
 */
export function synthesizeReverbIr(
  sampleRate: number,
  decaySec: number,
  dampingHz: number,
  seed = 0x5eed,
): Float32Array[] {
  const length = Math.max(16, Math.round(decaySec * sampleRate));
  const random = lcg(seed);
  // 고역 감쇠를 일차 저역통과로 근사한다
  const alpha = Math.exp((-2 * Math.PI * dampingHz) / sampleRate);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const data = new Float32Array(length);
    let z = 0;
    for (let i = 0; i < length; i++) {
      const noise = random() * 2 - 1;
      z = (1 - alpha) * noise + alpha * z;
      // -60dB 까지 지수 감쇠
      const envelope = Math.pow(10, (-3 * i) / length);
      const preDelay = Math.min(1, i / (0.02 * sampleRate));
      data[i] = z * envelope * preDelay;
    }
    // 정규화 — IR 진폭이 리버브 볼륨을 결정하면 mix 파라미터가 의미를 잃는다
    let rms = 0;
    for (const v of data) rms += v * v;
    rms = Math.sqrt(rms / length);
    const scale = rms > 1e-9 ? 0.35 / rms : 0;
    for (let i = 0; i < length; i++) data[i] = data[i]! * scale;
    channels.push(data);
  }
  return channels;
}

/** 드라이/웻 게인. mix=0 이면 완전 드라이, 1 이면 완전 웻 */
export function reverbMixGains(mix: number): { dry: number; wet: number } {
  const m = Math.min(1, Math.max(0, mix));
  // 등가 파워 크로스페이드 — 선형으로 하면 중간에서 소리가 작아진다
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) };
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

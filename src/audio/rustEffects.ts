/**
 * Rust 이펙트 선언 (`EFFECTS_PLAN.md`) — 순수 데이터. 노드는 `effectGraph.ts` 가 만든다.
 *
 * **객체의 키 순서 = Rust `fx/src/effects/mod.rs` 의 `KINDS` 순서 = 파라미터 슬롯 순서.**
 * 어긋나면 `rustEffects.test.ts` 가 fx.wasm 의 이름 목록과 비교해서 깨진다.
 * 파라미터도 **선언 순서가 p0, p1, …** 이다 (Rust 파일 머리 주석과 같아야 한다).
 */

import type { EffectParamSpec } from './effects.ts';

export type EffectCategory =
  | 'dynamics' | 'eq' | 'delay' | 'modulation' | 'distortion' | 'reverb' | 'pitch' | 'utility' | 'creative' | 'spatial';

export const EFFECT_CATEGORIES: Record<EffectCategory, string> = {
  dynamics: '다이내믹스',
  eq: 'EQ·필터',
  delay: '딜레이',
  modulation: '모듈레이션',
  distortion: '디스토션·앰프',
  reverb: '리버브',
  pitch: '피치·스펙트럼',
  utility: '미터·유틸',
  creative: '멀티·창작',
  spatial: '공간',
};

export interface RustEffectDecl {
  label: string;
  category: EffectCategory;
  /** 처리 지연(샘플, 48kHz 기준이 아니라 **샘플레이트와 무관한 고정 블록**) — Rust 가 보고하는 값과 같아야 한다 */
  latency?: number;
  /** 미터 칸 이름 (Rust `meters()` 순서) */
  meters?: { label: string; unit?: string; min: number; max: number }[];
  params: Record<string, EffectParamSpec>;
}

const db = (label: string, min: number, max: number, def: number): EffectParamSpec => ({ label, min, max, default: def, unit: 'dB' });
const hz = (label: string, min: number, max: number, def: number): EffectParamSpec => ({ label, min, max, default: def, unit: 'Hz', curve: 'log' });
const msec = (label: string, min: number, max: number, def: number, log = true): EffectParamSpec => ({ label, min, max, default: def, unit: 'ms', ...(log ? { curve: 'log' as const } : {}) });
const unit = (label: string, def: number, max = 1, min = 0): EffectParamSpec => ({ label, min, max, default: def });
const choice = (label: string, options: string[], def = 0): EffectParamSpec => ({ label, min: 0, max: options.length - 1, default: def, options, automatable: false });
const GR = { label: '게인 감소', unit: 'dB', min: -40, max: 0 };

export const RUST_EFFECT_SPECS = {
  gate: {
    label: '노이즈 게이트', category: 'dynamics',
    meters: [GR, { label: '감지', unit: 'dB', min: -80, max: 0 }, { label: '열림', min: 0, max: 1 }],
    params: {
      thresholdDb: db('스레숄드', -80, 0, -40),
      reductionDb: db('줄임', -100, 0, -60),
      attackMs: msec('어택', 0.05, 100, 0.5),
      holdMs: msec('홀드', 0, 1000, 30, false),
      releaseMs: msec('릴리즈', 5, 2000, 120),
      hysteresisDb: db('히스테리시스', -20, 0, -3),
      keyLowCutHz: hz('감지 로우컷', 20, 4000, 20),
      keyHighCutHz: hz('감지 하이컷', 200, 20000, 20000),
    },
  },
  multipressor: {
    label: '멀티프레서', category: 'dynamics',
    meters: [{ ...GR, label: '저역' }, { ...GR, label: '중저역' }, { ...GR, label: '중고역' }, { ...GR, label: '고역' }],
    params: {
      split1Hz: hz('분할 1', 30, 500, 120),
      split2Hz: hz('분할 2', 300, 5000, 1000),
      split3Hz: hz('분할 3', 2000, 16000, 6000),
      attackMs: msec('어택', 0.1, 200, 10),
      releaseMs: msec('릴리즈', 5, 2000, 150),
      outputDb: db('출력', -24, 24, 0),
      b1ThresholdDb: db('저역 스레숄드', -60, 0, -18),
      b1Ratio: { label: '저역 레이시오', min: 1, max: 20, default: 2 },
      b1GainDb: db('저역 게인', -24, 24, 0),
      b2ThresholdDb: db('중저역 스레숄드', -60, 0, -18),
      b2Ratio: { label: '중저역 레이시오', min: 1, max: 20, default: 2 },
      b2GainDb: db('중저역 게인', -24, 24, 0),
      b3ThresholdDb: db('중고역 스레숄드', -60, 0, -18),
      b3Ratio: { label: '중고역 레이시오', min: 1, max: 20, default: 2 },
      b3GainDb: db('중고역 게인', -24, 24, 0),
      b4ThresholdDb: db('고역 스레숄드', -60, 0, -18),
      b4Ratio: { label: '고역 레이시오', min: 1, max: 20, default: 2 },
      b4GainDb: db('고역 게인', -24, 24, 0),
    },
  },
  spacedesigner: {
    label: '스페이스 디자이너 (컨볼루션)', category: 'reverb', latency: 1024,
    params: {
      mix: unit('섞기', 0.25),
      space: choice('공간', ['방', '홀', '체임버', '성당', '플레이트'], 1),
      lengthSec: { label: '길이', min: 0.1, max: 8, default: 2, unit: 's', curve: 'log', automatable: false },
      predelayMs: msec('프리딜레이', 0, 250, 15, false),
      dampingHz: { ...hz('고역 감쇠', 500, 18000, 7000), automatable: false },
      lowCutHz: hz('로우컷', 20, 1000, 120),
      width: unit('폭', 1, 1.5),
      outputDb: db('출력', -24, 12, 0),
    },
  },
} satisfies Record<string, RustEffectDecl>;

export type RustEffectType = keyof typeof RUST_EFFECT_SPECS;

/** Rust `KINDS` 의 자리 번호 */
export const RUST_KIND: Record<RustEffectType, number> = Object.fromEntries(
  Object.keys(RUST_EFFECT_SPECS).map((k, i) => [k, i]),
) as Record<RustEffectType, number>;

export function isRustEffect(type: string): type is RustEffectType {
  return type in RUST_EFFECT_SPECS;
}

export const RUST_PARAM_SLOTS = 24;

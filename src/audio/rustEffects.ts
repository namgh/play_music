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

/** 채널 EQ · 리니어 페이즈 EQ 공통 손잡이 (Rust `eq_sections` 순서) */
function eqParams(): Record<string, EffectParamSpec> {
  const peak = (n: number, f: number) => ({
    [`p${n}Hz`]: hz(`피크${n} 주파수`, 20, 20000, f),
    [`p${n}Db`]: db(`피크${n} 게인`, -24, 24, 0),
    [`p${n}Q`]: { label: `피크${n} Q`, min: 0.1, max: 12, default: 1, curve: 'log' as const },
  });
  return {
    lowCutHz: hz('로우컷 (10=끔)', 10, 4000, 10),
    lowCutSlope: choice('로우컷 기울기', ['12dB', '24dB'], 1),
    lowShelfHz: hz('로우 셸프', 20, 2000, 100),
    lowShelfDb: db('로우 셸프 게인', -24, 24, 0),
    ...peak(1, 250), ...peak(2, 800), ...peak(3, 2500), ...peak(4, 6000),
    highShelfHz: hz('하이 셸프', 500, 20000, 8000),
    highShelfDb: db('하이 셸프 게인', -24, 24, 0),
    highCutHz: hz('하이컷 (22000=끔)', 500, 22000, 22000),
    highCutSlope: choice('하이컷 기울기', ['12dB', '24dB'], 1),
    outputDb: db('출력', -24, 24, 0),
  };
}

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
  // --- 1단계: 다이내믹스·EQ·필터 ---
  expander: {
    label: '익스팬더', category: 'dynamics', meters: [GR],
    params: {
      thresholdDb: db('스레숄드', -80, 0, -40),
      ratio: { label: '레이시오', min: 1, max: 8, default: 2 },
      rangeDb: db('바닥', -80, 0, -40),
      attackMs: msec('어택', 0.05, 100, 1),
      releaseMs: msec('릴리즈', 5, 2000, 150),
      kneeDb: db('니', 0, 24, 6),
      makeupDb: db('메이크업', -24, 24, 0),
    },
  },
  deesser: {
    label: '디에서', category: 'dynamics', meters: [GR, { label: '치찰음', unit: 'dB', min: -80, max: 0 }],
    params: {
      freqHz: hz('주파수', 2000, 12000, 6500),
      thresholdDb: db('스레숄드', -60, 0, -28),
      rangeDb: db('최대 줄임', -24, 0, -9),
      mode: choice('방식', ['대역만', '전체'], 0),
      attackMs: msec('어택', 0.1, 30, 1),
      releaseMs: msec('릴리즈', 5, 500, 60),
    },
  },
  enveloper: {
    label: '엔벨로퍼 (트랜지언트)', category: 'dynamics', meters: [{ label: '지금 게인', unit: 'dB', min: -24, max: 24 }],
    params: {
      attackDb: db('어택 게인', -24, 24, 6),
      sustainDb: db('서스테인 게인', -24, 24, 0),
      attackMs: msec('어택 감지', 0.5, 50, 5),
      releaseMs: msec('릴리즈 감지', 20, 2000, 200),
      outputDb: db('출력', -24, 24, 0),
    },
  },
  compmodel: {
    label: '컴프레서 (회로 모델)', category: 'dynamics', latency: 16,
    meters: [GR, { label: '입력', unit: 'dB', min: -60, max: 0 }, { label: '출력', unit: 'dB', min: -60, max: 0 }],
    params: {
      model: choice('모델', ['플래티넘 (디지털)', '스튜디오 VCA', '스튜디오 FET', '빈티지 옵토', '빈티지 VCA'], 1),
      thresholdDb: db('스레숄드', -60, 0, -20),
      ratio: { label: '레이시오', min: 1, max: 30, default: 3, curve: 'log' },
      attackMs: msec('어택', 0.05, 300, 10),
      releaseMs: msec('릴리즈', 5, 3000, 150),
      kneeDb: db('니', 0, 24, 4),
      makeupDb: db('메이크업', -24, 24, 0),
      autoGain: choice('자동 게인', ['끔', '켬'], 0),
      mix: unit('섞기 (병렬)', 1),
      keyLowCutHz: hz('감지 로우컷', 20, 1000, 20),
      color: unit('색 (포화)', 0),
    },
  },
  adaptivelimiter: {
    label: '어댑티브 리미터', category: 'dynamics', latency: 137, meters: [GR],
    params: {
      inputDb: db('입력', 0, 30, 0),
      ceilingDb: db('천장 (dBTP)', -12, 0, -1),
      releaseMs: msec('릴리즈', 5, 2000, 150),
    },
  },
  channeleq: {
    label: '채널 EQ (8밴드)', category: 'eq',
    params: eqParams(),
  },
  linearphaseeq: {
    label: '리니어 페이즈 EQ', category: 'eq', latency: 3072,
    // 손잡이를 바꾸면 FIR 을 새로 만든다 — 오토메이션 대상이 아니다 (출력만)
    params: Object.fromEntries(Object.entries(eqParams()).map(([k, v]) => [k, k === 'outputDb' ? v : { ...v, automatable: false as const }])),
  },
  vintageeq: {
    label: '빈티지 튜브 EQ', category: 'eq', latency: 16,
    params: {
      lowFreq: choice('저역 주파수', ['20Hz', '30Hz', '60Hz', '100Hz'], 2),
      lowBoost: unit('저역 올림', 0, 10),
      lowAtten: unit('저역 깎기', 0, 10),
      highBoostFreq: choice('고역 올림 주파수', ['3k', '4k', '5k', '8k', '10k', '12k', '16k'], 3),
      highBoost: unit('고역 올림', 0, 10),
      highWidth: unit('고역 폭', 0.5),
      highAttenFreq: choice('고역 깎기 주파수', ['5k', '10k', '20k'], 1),
      highAtten: unit('고역 깎기', 0, 10),
      drive: unit('튜브 드라이브', 0.2),
      outputDb: db('출력', -24, 24, 0),
    },
  },
  multifilter: {
    label: '멀티 필터', category: 'eq',
    params: {
      mode: choice('모드', ['로우패스 12', '로우패스 24', '하이패스 12', '하이패스 24', '밴드패스', '노치', '피크'], 0),
      cutoffHz: hz('차단', 20, 20000, 2000),
      resonance: { label: '공명', min: 0.5, max: 25, default: 0.9, curve: 'log' },
      peakDb: db('피크 게인', -24, 24, 6),
      mix: unit('섞기', 1),
      outputDb: db('출력', -24, 24, 0),
    },
  },
  envfilter: {
    label: '엔벨로프 필터 (오토 와우)', category: 'eq', meters: [{ label: '차단', unit: 'Hz', min: 20, max: 20000 }],
    params: {
      mode: choice('모드', ['로우패스', '밴드패스', '하이패스'], 1),
      baseHz: hz('시작', 40, 8000, 300),
      rangeOct: { label: '범위', min: -6, max: 7, default: 3.5, unit: '옥' },
      sensitivityDb: db('감도', -12, 40, 6),
      attackMs: msec('어택', 0.5, 200, 8),
      releaseMs: msec('릴리즈', 10, 2000, 150),
      resonance: { label: '공명', min: 0.5, max: 20, default: 4, curve: 'log' },
      mix: unit('섞기', 1),
    },
  },
  tilteq: {
    label: '틸트 EQ', category: 'eq',
    params: {
      centerHz: hz('중심', 100, 8000, 800),
      tiltDb: db('기울기', -12, 12, 0),
      outputDb: db('출력', -24, 24, 0),
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

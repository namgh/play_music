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

/** 딜레이 디자이너 탭 하나 (Rust 순서: 시간·크기·좌우) */
function tap(n: number, ms: number, level: number, pan: number): Record<string, EffectParamSpec> {
  return {
    [`tap${n}Ms`]: msec(`탭${n} 시간`, 1, 4000, ms),
    [`tap${n}Level`]: unit(`탭${n} 크기`, level),
    [`tap${n}Pan`]: unit(`탭${n} 좌우`, pan, 1, -1),
  };
}

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
  // --- 2단계: 딜레이·모듈레이션 ---
  tapedelay: {
    label: '테이프 딜레이', category: 'delay',
    params: {
      timeMs: msec('시간', 10, 4000, 375),
      feedback: unit('되먹임', 0.4, 1.1),
      mix: unit('섞기', 0.3),
      wow: unit('와우', 0.3),
      flutter: unit('플러터', 0.2),
      lowCutHz: hz('로우컷', 20, 2000, 120),
      highCutHz: hz('하이컷', 500, 8000, 3500),
      saturation: unit('포화', 0.3),
    },
  },
  stereodelay: {
    label: '스테레오 딜레이', category: 'delay',
    params: {
      leftMs: msec('왼쪽', 1, 4000, 375),
      rightMs: msec('오른쪽', 1, 4000, 500),
      feedback: unit('되먹임', 0.35, 0.98),
      crossfeed: unit('교차 (핑퐁)', 0),
      mix: unit('섞기', 0.3),
      lowCutHz: hz('로우컷', 20, 2000, 80),
      highCutHz: hz('하이컷', 500, 20000, 9000),
    },
  },
  delaydesigner: {
    label: '딜레이 디자이너 (6탭)', category: 'delay',
    params: {
      ...tap(1, 125, 0.8, -0.6), ...tap(2, 250, 0.6, 0.6), ...tap(3, 375, 0.45, -0.3),
      ...tap(4, 500, 0, 0.3), ...tap(5, 625, 0, -0.8), ...tap(6, 750, 0, 0.8),
      feedback: unit('되먹임', 0.2, 0.95),
      mix: unit('섞기', 0.3),
      lowCutHz: hz('로우컷', 20, 2000, 100),
      highCutHz: hz('하이컷', 500, 20000, 8000),
    },
  },
  ensemble: {
    label: '앙상블', category: 'modulation',
    params: {
      voices: { label: '목소리', min: 2, max: 8, default: 4 },
      rateHz: hz('속도', 0.02, 8, 0.6),
      depthMs: msec('깊이', 0, 15, 4, false),
      delayMs: msec('기본 지연', 3, 40, 12, false),
      width: unit('폭', 0.9),
      mix: unit('섞기', 0.5),
    },
  },
  moddelay: {
    label: '모듈레이션 딜레이', category: 'modulation',
    params: {
      delayMs: msec('지연', 0.2, 50, 6),
      depthMs: msec('깊이', 0, 20, 2, false),
      rateHz: hz('속도', 0.01, 20, 0.4),
      feedback: unit('되먹임', 0.3, 0.95, -0.95),
      shape: choice('LFO 모양', ['사인', '삼각'], 0),
      stereoPhase: { label: '좌우 위상차', min: 0, max: 180, default: 90, unit: '°' },
      mix: unit('섞기', 0.5),
    },
  },
  rotor: {
    label: '로터 캐비닛 (레슬리)', category: 'modulation',
    params: {
      speed: choice('속도', ['느림 (코랄)', '빠름 (트레몰로)', '정지'], 0),
      balance: unit('혼 ↔ 드럼', 0, 1, -1),
      distance: unit('마이크 거리', 0.4),
      acceleration: { label: '가속', min: 0.25, max: 4, default: 1, curve: 'log' },
    },
  },
  autopan: {
    label: '오토팬', category: 'modulation',
    params: {
      rateHz: hz('속도', 0.02, 20, 1),
      depth: unit('깊이', 0.7),
      shape: choice('모양', ['사인', '삼각', '사각'], 0),
    },
  },
  ringmod: {
    label: '링 모듈레이터', category: 'modulation', latency: 16,
    params: {
      freqHz: hz('반송', 1, 5000, 220),
      lfoRateHz: { label: 'LFO 속도', min: 0, max: 20, default: 0, unit: 'Hz' },
      lfoOct: { label: 'LFO 깊이', min: 0, max: 4, default: 0, unit: '옥' },
      mix: unit('섞기', 0.5),
    },
  },
  freqshifter: {
    label: '주파수 시프터', category: 'modulation',
    params: {
      shiftHz: { label: '이동', min: -2000, max: 2000, default: 30, unit: 'Hz' },
      feedback: unit('되먹임', 0, 0.9),
      mix: unit('섞기', 0.5),
      mirror: choice('좌우', ['같은 방향', '반대 방향'], 0),
    },
  },
  vibrato: {
    label: '비브라토', category: 'modulation',
    params: {
      rateHz: hz('속도', 0.1, 14, 5.5),
      depthCents: { label: '깊이', min: 0, max: 200, default: 25, unit: '¢' },
      mix: unit('섞기', 1),
    },
  },
  phaser12: {
    label: '페이저 (다단)', category: 'modulation',
    params: {
      stages: choice('단 수', ['4', '6', '8', '12'], 2),
      rateHz: hz('속도', 0.01, 10, 0.3),
      depthOct: { label: '깊이', min: 0, max: 5, default: 2.5, unit: '옥' },
      centerHz: hz('중심', 100, 8000, 900),
      feedback: unit('되먹임', 0.4, 0.9, -0.9),
      stereoPhase: { label: '좌우 위상차', min: 0, max: 180, default: 90, unit: '°' },
      mix: unit('섞기', 0.5),
    },
  },
  // --- 3단계: 디스토션·앰프 (비선형은 4배 오버샘플링 → 지연 16) ---
  overdrive: {
    label: '오버드라이브', category: 'distortion', latency: 16,
    params: { driveDb: db('드라이브', 0, 48, 18), toneHz: hz('톤', 500, 12000, 4000), mix: unit('섞기', 1), outputDb: db('출력', -40, 24, -6) },
  },
  fuzz: {
    label: '퍼즈', category: 'distortion', latency: 16,
    params: { fuzz: unit('퍼즈', 0.6), bias: unit('바이어스', 0, 0.5, -0.5), toneHz: hz('톤', 300, 12000, 3000), mix: unit('섞기', 1), outputDb: db('출력', -40, 24, -10) },
  },
  fuzzwah: {
    label: '퍼즈-와우', category: 'distortion', latency: 16,
    params: {
      pedal: unit('페달', 0.4),
      auto: unit('오토 와우', 0),
      resonance: { label: '공명', min: 1, max: 15, default: 5, curve: 'log' },
      fuzz: unit('퍼즈', 0.3),
      order: choice('순서', ['와우 → 퍼즈', '퍼즈 → 와우'], 0),
      outputDb: db('출력', -40, 24, -4),
    },
  },
  bitcrusher: {
    label: '비트크러셔', category: 'distortion',
    params: {
      bits: { label: '비트', min: 1, max: 24, default: 8 },
      downsample: { label: '다운샘플', min: 1, max: 64, default: 4, unit: '×', curve: 'log' },
      driveDb: db('드라이브', 0, 36, 0),
      mix: unit('섞기', 1),
      outputDb: db('출력', -40, 24, 0),
    },
  },
  clipdist: {
    label: '클립 디스토션', category: 'distortion', latency: 16,
    params: {
      driveDb: db('드라이브', 0, 48, 18),
      mode: choice('클립', ['부드럽게', '딱딱하게', '접기'], 0),
      symmetry: unit('대칭', 0, 1, -1),
      preHighpassHz: hz('앞 하이패스', 20, 2000, 60),
      postLowpassHz: hz('뒤 로우패스', 500, 20000, 9000),
      mix: unit('섞기', 1),
      outputDb: db('출력', -40, 24, -8),
    },
  },
  chromaglow: {
    label: '크로마글로 (포화)', category: 'distortion', latency: 16,
    params: {
      model: choice('모델', ['모던 튜브', '실키 튜브', '브라이트 튜브', '테이프', '트랜지스터'], 0),
      driveDb: db('드라이브', 0, 36, 8),
      tone: unit('톤', 0, 1, -1),
      mix: unit('섞기', 1),
      outputDb: db('출력', -40, 24, -2),
    },
  },
  ampdesigner: {
    label: '앰프 디자이너', category: 'distortion', latency: 16,
    params: {
      amp: choice('앰프', ['클린 아메리칸', '브리티시 크런치', '모던 하이게인', '브리티시 클래스 A'], 1),
      gain: unit('게인', 0.5),
      bass: unit('저역', 0, 1, -1),
      mid: unit('중역', 0, 1, -1),
      treble: unit('고역', 0, 1, -1),
      presence: unit('프레즌스', 0, 1, -1),
      master: unit('마스터', 0.4),
      cabinet: choice('캐비닛', ['끔', '1×12 오픈백', '2×12', '4×12 클로즈드'], 2),
      mic: unit('마이크 위치', 0.3),
      outputDb: db('출력', -40, 24, -6),
    },
  },
  bassamp: {
    label: '베이스 앰프', category: 'distortion', latency: 16,
    params: {
      amp: choice('앰프', ['클래식 튜브', '모던', '플립톱'], 0),
      gain: unit('게인', 0.3),
      bass: unit('저역', 0, 1, -1),
      mid: unit('중역', 0, 1, -1),
      treble: unit('고역', 0, 1, -1),
      master: unit('마스터', 0.4),
      cabinet: choice('캐비닛', ['끔', '8×10', '1×15', '4×10'], 1),
      blend: unit('DI ↔ 앰프', 0.6),
      outputDb: db('출력', -40, 24, -3),
    },
  },
  cabinet: {
    label: '캐비닛', category: 'distortion',
    params: {
      kind: choice('종류', ['1×12 오픈백', '2×12', '4×12 클로즈드', '베이스 8×10', '베이스 1×15', '베이스 4×10'], 2),
      mic: unit('마이크 위치', 0.3),
      mix: unit('섞기', 1),
      outputDb: db('출력', -40, 24, 0),
    },
  },
  exciter: {
    label: '익사이터', category: 'distortion', latency: 16,
    params: {
      freqHz: hz('시작', 1000, 12000, 4000),
      harmonics: unit('배음', 0.5),
      color: unit('색 (짝수 ↔ 홀수)', 0.4),
      amount: unit('섞기', 0.3),
      outputDb: db('출력', -24, 24, 0),
    },
  },
  subbass: {
    label: '서브베이스', category: 'distortion',
    params: {
      keyHz: hz('감지 상한', 60, 400, 180),
      sub: unit('서브', 0.6, 2),
      subLowpassHz: hz('서브 로우패스', 30, 200, 90),
      dry: unit('원음', 1),
    },
  },
  // --- 4단계: 리버브 ---
  chromaverb: {
    label: '크로마버브', category: 'reverb',
    params: {
      space: choice('공간', ['방', '체임버', '콘서트 홀', '성당', '신스 홀', '빽빽한 방', '부드러운 공간'], 2),
      decaySec: { label: '길이', min: 0.1, max: 30, default: 2.2, unit: 's', curve: 'log' },
      size: { label: '크기', min: 0.3, max: 2, default: 1, curve: 'log' },
      predelayMs: msec('프리딜레이', 0, 250, 20, false),
      highDecay: unit('고역 길이 비율', 0.5, 1, 0.05),
      modulation: unit('흔들림', 1, 2),
      diffusion: unit('확산', 0.7),
      lowCutHz: hz('로우컷', 20, 1000, 120),
      width: unit('폭', 1, 1.5),
      mix: unit('섞기', 0.25),
      freeze: choice('얼리기', ['끔', '켬'], 0),
    },
  },
  platereverb: {
    label: '플레이트 리버브', category: 'reverb',
    params: {
      decay: unit('길이', 0.7, 0.97),
      predelayMs: msec('프리딜레이', 0, 250, 10, false),
      bandwidthHz: hz('입력 대역', 1000, 20000, 12000),
      dampingHz: hz('고역 감쇠', 500, 20000, 7000),
      lowCutHz: hz('로우컷', 20, 1000, 150),
      width: unit('폭', 1, 1.5),
      mix: unit('섞기', 0.25),
    },
  },
  springreverb: {
    label: '스프링 리버브', category: 'reverb',
    params: {
      tensionMs: msec('장력 (길이)', 15, 100, 38, false),
      decay: unit('감쇠', 0.75, 0.92),
      dispersion: unit('분산', 0.6),
      toneHz: hz('톤', 1000, 8000, 4200),
      drip: unit('드립', 1, 2),
      mix: unit('섞기', 0.3),
    },
  },
  roomreverb: {
    label: '룸 (초기 반사)', category: 'reverb',
    params: {
      sizeM: { label: '방 크기', min: 2, max: 30, default: 7, unit: 'm', curve: 'log' },
      decaySec: { label: '길이', min: 0.1, max: 5, default: 0.7, unit: 's', curve: 'log' },
      earlyLate: unit('반사 ↔ 꼬리', 0.5),
      damping: unit('밝기', 0.6, 1, 0.05),
      predelayMs: msec('프리딜레이', 0, 200, 0, false),
      width: unit('폭', 1, 1.5),
      mix: unit('섞기', 0.25),
    },
  },
  gatedreverb: {
    label: '게이트 리버브', category: 'reverb', meters: [{ label: '게이트', min: 0, max: 1 }],
    params: {
      thresholdDb: db('스레숄드', -60, 0, -24),
      holdMs: msec('홀드', 10, 1000, 220),
      closeMs: msec('닫힘', 1, 200, 12),
      size: { label: '크기', min: 0.3, max: 2, default: 1, curve: 'log' },
      brightness: unit('밝기', 0.6, 1, 0.05),
      mix: unit('섞기', 0.4),
    },
  },
  shimmer: {
    label: '쉬머 리버브', category: 'reverb',
    params: {
      decaySec: { label: '길이', min: 0.5, max: 20, default: 5, unit: 's', curve: 'log' },
      pitchSemis: { label: '음정', min: -12, max: 24, default: 12, unit: '반음' },
      amount: unit('쉬머', 0.4, 0.9),
      brightness: unit('밝기', 0.6, 1, 0.05),
      mix: unit('섞기', 0.35),
    },
  },
  enverb: {
    label: '엔버브 (모양 리버브)', category: 'reverb', latency: 1024,
    params: {
      attackMs: { ...msec('차오름', 0, 2000, 30, false), automatable: false },
      holdMs: { ...msec('홀드', 0, 2000, 50, false), automatable: false },
      decayMs: { ...msec('감쇠', 20, 8000, 1500), automatable: false },
      curve: { ...unit('감쇠 곡선', 0, 1, -1), automatable: false },
      dampingHz: { ...hz('고역 감쇠', 500, 18000, 7000), automatable: false },
      lowCutHz: hz('로우컷', 20, 1000, 120),
      width: unit('폭', 1, 1.5),
      mix: unit('섞기', 0.3),
    },
  },
  // --- 5단계: 피치·스펙트럼 (STFT 는 지연 2048) ---
  pitchshifter: {
    label: '피치 시프터', category: 'pitch',
    params: {
      semitones: { label: '반음', min: -24, max: 24, default: 0, unit: '반음' },
      cents: { label: '센트', min: -100, max: 100, default: 0, unit: '¢' },
      window: choice('창', ['드럼', '말', '노래', '패드'], 2),
      mix: unit('섞기', 1),
    },
  },
  pitchcorrection: {
    label: '피치 보정', category: 'pitch',
    meters: [{ label: '감지', unit: 'Hz', min: 0, max: 1000 }, { label: '목표', unit: 'Hz', min: 0, max: 1000 }, { label: '벗어남', unit: '¢', min: -50, max: 50 }],
    params: {
      root: choice('으뜸음', ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'], 0),
      scale: choice('음계', ['반음계', '장음계', '단음계', '펜타토닉', '블루스'], 0),
      responseMs: msec('응답', 0, 400, 40, false),
      amount: unit('보정 양', 1),
      a4Hz: { label: '기준 A', min: 400, max: 480, default: 440, unit: 'Hz' },
      mix: unit('섞기', 1),
    },
  },
  vocaltransformer: {
    label: '보컬 트랜스포머', category: 'pitch', latency: 2048,
    params: {
      pitch: { label: '음정', min: -24, max: 24, default: 0, unit: '반음' },
      formant: { label: '포먼트', min: -12, max: 12, default: 0, unit: '반음' },
      mix: unit('섞기', 1),
    },
  },
  harmonizer: {
    label: '하모나이저', category: 'pitch',
    params: {
      voice1Semis: { label: '목소리1 음정', min: -24, max: 24, default: 4, unit: '반음' },
      voice1Level: unit('목소리1 크기', 0.6),
      voice1Pan: unit('목소리1 좌우', -0.6, 1, -1),
      voice2Semis: { label: '목소리2 음정', min: -24, max: 24, default: 7, unit: '반음' },
      voice2Level: unit('목소리2 크기', 0.5),
      voice2Pan: unit('목소리2 좌우', 0.6, 1, -1),
      dry: unit('원음', 1),
      window: choice('창', ['드럼', '말', '노래', '패드'], 2),
    },
  },
  octaver: {
    label: '옥타버', category: 'pitch',
    params: {
      down1: unit('−1 옥타브', 0.7, 1.5),
      down2: unit('−2 옥타브', 0, 1.5),
      up1: unit('+1 옥타브', 0, 1.5),
      dry: unit('원음', 1, 1.5),
      lowpassHz: hz('아래 소리 톤', 100, 4000, 1200),
    },
  },
  vocoder: {
    label: '보코더', category: 'pitch',
    params: {
      carrierNote: { label: '캐리어 음', min: 24, max: 96, default: 48, unit: 'MIDI' },
      chord: choice('화음', ['단음', '5도', '장3화음', '단3화음'], 2),
      noise: unit('노이즈', 0.1),
      bands: { label: '대역 수', min: 8, max: 20, default: 16 },
      q: { label: '대역 Q', min: 2, max: 30, default: 8, curve: 'log' },
      attackMs: msec('어택', 0.5, 100, 4),
      releaseMs: msec('릴리즈', 5, 1000, 60),
      formantSemis: { label: '포먼트 이동', min: -12, max: 12, default: 0, unit: '반음' },
      sibilance: unit('치찰음 통과', 0.3),
      mix: unit('섞기', 1),
    },
  },
  spectralgate: {
    label: '스펙트럼 게이트', category: 'pitch', latency: 2048,
    params: {
      thresholdDb: db('스레숄드', -100, 0, -60),
      reductionDb: db('줄임', -100, 0, -40),
      lowHz: hz('구간 아래', 20, 20000, 20),
      highHz: hz('구간 위', 20, 24000, 24000),
      speed: unit('속도', 0.5),
      mix: unit('섞기', 1),
    },
  },
  denoiser: {
    label: '디노이저', category: 'pitch', latency: 2048, meters: [{ label: '잡음 바닥', unit: 'dB', min: -120, max: 0 }],
    params: {
      reductionDb: db('줄임', -60, 0, -15),
      sensitivityDb: db('민감도', 0, 20, 6),
      smoothing: unit('매끄러움', 0.6, 0.95),
      mix: unit('섞기', 1),
    },
  },
  matcheq: {
    label: '매치 EQ', category: 'eq',
    meters: ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'].map((label) => ({ label, unit: 'dB', min: -12, max: 12 })),
    params: {
      target: choice('목표 곡선', ['평탄 (핑크)', '팝 밝게', '따뜻하게', '힙합', '록', '어쿠스틱'], 0),
      amount: unit('양', 0.5),
      learn: choice('배우기', ['멈춤', '배우는 중'], 1),
      maxDb: db('최대 보정', 1, 12, 6),
      outputDb: db('출력', -24, 24, 0),
    },
  },
  freeze: {
    label: '프리즈 (스펙트럼 얼리기)', category: 'pitch', latency: 2048,
    params: {
      freeze: choice('얼리기', ['끔', '켬'], 0),
      blur: unit('번짐', 0.2),
      mix: unit('섞기', 1),
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

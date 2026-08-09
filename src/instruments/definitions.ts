/**
 * 악기 정의 데이터 (`sound.md` 9-2).
 *
 * **여기 아래는 전부 데이터다.** 새 줄 악기를 넣을 때 엔진 코드(`voice/`)를 열지 않는다.
 * `instruments.test.ts` 가 그 성질을 테스트로 고정한다.
 *
 * 나중에 JSON 파일 + 원격 로딩으로 옮길 수 있다. 지금 TS 로 두는 이유는
 * 타입 검사를 받으면서 형태를 확정하는 게 먼저이기 때문.
 */

import type { InstrumentCategory, InstrumentDefinition, ParamSpec } from './types.ts';
import { CATEGORY_ORDER } from './types.ts';
import { resolveInstrument } from './resolve.ts';

/**
 * 노트오프 관련 파라미터. **보이스 타입과 무관하게 모든 악기가 갖는다.**
 *
 * wasm 파라미터 슬롯이 아니라 워크렛 메시지로 간다 (`WORKPLAN.md` 2-2) — 발음마다
 * 바뀌는 값이 아니라 노트오프 시점에만 필요해서다.
 *
 * `letRing` 이 진짜 선택지인 이유: 실제 기타는 손을 떼면 줄이 죽지만 아르페지오는
 * 일부러 울린다. 기타 VST 가 전부 "Let Ring" 이라는 이름으로 갖고 있는 기능이다.
 */
const NOTE_OFF_SPECS: Record<string, ParamSpec> = {
  releaseMs: {
    // 하한 5ms — 0 이면 파형이 뚝 끊겨 그게 클릭이다.
    // 기본 120ms 는 손으로 줄을 짚어 죽이는 데 실제로 걸리는 시간이다
    type: 'float', min: 5, max: 2000, default: 120,
    unit: 'ms', label: '뮤트 속도', curve: 'log', group: '연주',
  },
  letRing: {
    type: 'int', min: 0, max: 1, default: 0,
    label: '울림 유지', group: '연주',
  },
};

/**
 * 연주 표현 파라미터 (`ROADMAP.md` S1). **보이스 타입과 무관하게 모든 악기가 갖는다.**
 *
 * 셋 다 **기본값이 0이고, 0이면 예전과 완전히 같은 소리**다. 악기가 명시적으로 켜야
 * 효과가 생긴다 — 그래야 이미 맞춰 둔 악기들이 이 변경으로 흔들리지 않는다.
 */
const EXPRESSION_SPECS: Record<string, ParamSpec> = {
  stereoWidth: {
    // 음 높이로 좌우에 편다. 실제로 마이크로 잡은 피아노·말렛·하프가 그렇게 들린다.
    // 앰프를 통과하는 일렉기타는 실제로 모노라 0 으로 둔다
    type: 'float', min: 0, max: 1, default: 0,
    label: '좌우 퍼짐', curve: 'linear', group: '연주',
  },
  velocityBrightness: {
    // 세게 치면 밝아진다. 없으면 벨로시티가 볼륨 오토메이션으로만 들린다
    type: 'float', min: 0, max: 1, default: 0,
    label: '세기→밝기', curve: 'linear', group: '연주',
  },
  variationAmount: {
    // 같은 음을 반복하면 완전히 똑같은 파형이 나와 하이햇 16분이 머신건이 된다.
    // **음정은 흔들지 않는다** — 세기·밝기·감쇠만 (`ROADMAP.md` S2-4)
    type: 'float', min: 0, max: 1, default: 0,
    label: '타건 변주', curve: 'linear', group: '연주',
  },
  pickupHumbucker: {
    // 코일 두 개가 직렬이라 공진이 아래로 내려간다 = 더 두껍고 어둡다.
    // 앰프를 쓰는 악기에만 의미가 있다
    type: 'int', min: 0, max: 1, default: 0,
    label: '험버커 픽업', group: '앰프',
  },
};

/**
 * 줄 악기의 표현력 파라미터 (`ROADMAP.md` S2). 줄에만 의미가 있어 공통에 넣지 않는다.
 */
const STRING_EXPRESSION_SPECS: Record<string, ParamSpec> = {
  polarizationMix: {
    // 실제 줄은 두 방향으로 진동한다. 0 이면 편광이 하나뿐이라 지수 감쇠만 남고,
    // 그게 "합성음 같다"는 인상의 1순위 원인이다
    type: 'float', min: 0, max: 1, default: 0,
    label: '2편광 섞기', curve: 'linear', group: '진동체',
  },
  polarizationDetuneCents: {
    // 두 편광의 주파수 차이. **키우면 음정 정확도를 먹는다** — 기본값 주석 참고
    type: 'float', min: 0, max: 20, default: 0.3,
    unit: '¢', label: '편광 디튠', curve: 'linear', group: '진동체',
  },
  playNoiseAmount: {
    // 픽이 줄을 긁는 소리. 지금까지 0 이었고 "진짜 같음"의 지분이 크다
    type: 'float', min: 0, max: 1, default: 0,
    label: '연주 노이즈', curve: 'linear', group: '연주',
  },
  polarizationDecayRatio: {
    // 세로 편광은 브리지에 더 잘 붙어 먼저 죽는다 → "빠른 초기 감쇠 + 느린 꼬리"
    type: 'float', min: 0.05, max: 1, default: 0.25,
    label: '편광 감쇠비', curve: 'linear', group: '진동체',
  },
};

/** 모든 악기가 공통으로 갖는 파라미터 */
const COMMON_SPECS: Record<string, ParamSpec> = { ...NOTE_OFF_SPECS, ...EXPRESSION_SPECS };

/**
 * 웨이브가이드 줄의 기준 정의. 파생 악기들은 여기서 숫자만 덮어쓴다.
 * 파라미터 의미는 `spike/m0-karplus/ks-string.js` 와 같다.
 */
const STRING_BASE: InstrumentDefinition = {
  id: 'string-base',
  schemaVersion: 1,
  name: '줄 (기준)',
  category: '줄',
  voice: 'waveguide-string',
  range: { low: 28, high: 96 },
  paramSpecs: {
    scaleLengthMm: {
      type: 'float', min: 300, max: 900, default: 648,
      unit: 'mm', label: '줄 길이', curve: 'linear', group: '진동체',
    },
    stiffness: {
      type: 'float', min: 0, max: 0.05, default: 0.012,
      label: '강성(분산)', curve: 'linear', group: '진동체',
    },
    damping: {
      type: 'float', min: 0, max: 0.25, default: 0.05,
      label: '고역 감쇠', curve: 'linear', group: '진동체',
    },
    sustainSec: {
      type: 'float', min: 0.3, max: 10, default: 3,
      unit: 's', label: '서스테인', curve: 'log', group: '진동체',
    },
    pluckPosition: {
      type: 'float', min: 0.02, max: 0.5, default: 0.18,
      label: '뜯는 위치', curve: 'linear', group: '연주',
    },
    pluckHardness: {
      type: 'float', min: 0, max: 1, default: 0.4,
      label: '뜯는 세기', curve: 'linear', group: '연주',
    },
    // --- 앰프 체인 (sound.md 5절) ---
    // **줄과 분리된 층이다.** "줄 길이"와 "왜곡"은 서로 다른 곳에 있다.
    // 어쿠스틱 악기는 ampEnabled 를 0 으로 두고 나머지를 무시한다
    ampEnabled: {
      type: 'int', min: 0, max: 1, default: 0,
      label: '앰프', group: '앰프',
    },
    ...STRING_EXPRESSION_SPECS,
    ...COMMON_SPECS,
  },
  params: {
    scaleLengthMm: 648,
    stiffness: 0.012,
    damping: 0.05,
    sustainSec: 3,
    pluckPosition: 0.18,
    pluckHardness: 0.4,
    // 앰프는 기본적으로 꺼져 있다 — 어쿠스틱 악기가 다수다
    ampEnabled: 0,
    // 손을 떼면 줄이 죽는다. 아르페지오처럼 일부러 울리려면 letRing 을 켠다
    releaseMs: 120,
    letRing: 0,
    // 세게 뜯으면 밝아진다 — 줄 악기에서 가장 뚜렷하게 들리는 성질이다
    velocityBrightness: 0.35,
    // **2편광을 기본으로 켠다** (`ROADMAP.md` S2-1). 실제 줄은 두 방향으로 진동하고
    // 두 주파수가 미세하게 다르다. 편광이 하나면 지수 감쇠뿐이라 소리가
    // "삐- 하고 사라지고", 그게 "합성음 같다"는 인상의 1순위 원인이다
    polarizationMix: 0.55,
    polarizationDetuneCents: 1.8,
    polarizationDecayRatio: 0.3,
    // 픽·손톱이 줄을 긁는 소리
    playNoiseAmount: 0.35,
    // 좌우 퍼짐은 악기마다 다르므로 기준에서는 끈다.
    // **선언만 하고 값을 안 두면 해석된 파라미터에서 아예 빠진다** — 그러면
    // 튜닝 화면에 나오지 않고 "이 악기엔 없는 값"처럼 보인다
    stereoWidth: 0,
    pickupHumbucker: 0,
    // 실제로 같은 줄을 같은 세기로 두 번 뜯어도 같은 소리가 안 난다
    variationAmount: 0.5,
  },
  tones: {
    default: {},
    밝은: { pluckHardness: 0.8, pluckPosition: 0.1, damping: 0.03 },
    따뜻한: { pluckHardness: 0.2, pluckPosition: 0.3, damping: 0.08 },
  },
};

// --- 아래부터 파생 악기. 전부 숫자만 다르다 (sound.md 9-3) --------------------

const ACOUSTIC_GUITAR: InstrumentDefinition = {
  id: 'acoustic-guitar',
  schemaVersion: 1,
  name: '어쿠스틱 기타',
  category: '기타',
  extends: 'string-base',
  params: {
    scaleLengthMm: 650, stiffness: 0.01, damping: 0.045, sustainSec: 4,
    // 어쿠스틱은 몸통이 공기를 울려 소리가 한 점에서 나오지 않는다
    stereoWidth: 0.2,
  },
  range: { low: 40, high: 88 }, // E2 ~ E6
};

/**
 * 앰프를 쓰는 악기의 기준 정의. 일렉 기타·베이스가 여기서 상속받는다.
 *
 * 파라미터가 줄 정의와 **섞이지 않는다** — 상속으로 층을 얹는 구조라
 * 어쿠스틱 악기는 이 정의를 거치지 않는다.
 */
const AMPED_STRING: InstrumentDefinition = {
  id: 'amped-string',
  schemaVersion: 1,
  name: '앰프 줄 (기준)',
  extends: 'string-base',
  paramSpecs: {
    ampCharacter: {
      type: 'enum', default: 1, min: 0, max: 3,
      label: '앰프 성격', group: '앰프',
      options: ['클린', '크런치', '디스토션', '퍼즈'],
    },
    ampDrive: {
      type: 'float', min: 0, max: 1, default: 0.35,
      label: '드라이브', group: '앰프',
    },
    ampToneLow: { type: 'float', min: 0, max: 1, default: 0.5, label: '저역', group: '앰프' },
    ampToneMid: { type: 'float', min: 0, max: 1, default: 0.5, label: '중역', group: '앰프' },
    ampToneHigh: { type: 'float', min: 0, max: 1, default: 0.55, label: '고역', group: '앰프' },
    ampLevel: { type: 'float', min: 0, max: 1, default: 0.7, label: '앰프 볼륨', group: '앰프' },
    ampCabinet: { type: 'int', min: 0, max: 1, default: 1, label: '캐비닛', group: '앰프' },
    pickupPosition: {
      type: 'float', min: 0, max: 1, default: 0.15,
      label: '픽업 위치', group: '앰프',
    },
  },
  params: {
    ampEnabled: 1,
    // **자석 픽업은 한 방향 움직임에 주로 반응한다.** 폴피스에 수직인 편광이
    // 크게 잡히고 나머지는 약하게 들어온다 — 어쿠스틱처럼 두 편광이 공기로 함께
    // 나오는 것과 다르다. 왜곡을 거치면 두 편광이 상호변조로 기본음을 당기기도 해서
    // (실측 2.1센트) 물리와 정확도가 같은 방향을 가리킨다
    polarizationMix: 0.25,
    ampCharacter: 1,
    ampDrive: 0.35,
    ampToneLow: 0.5,
    ampToneMid: 0.5,
    ampToneHigh: 0.55,
    ampLevel: 0.7,
    ampCabinet: 1,
    pickupPosition: 0.15,
  },
  tones: {
    클린: { ampCharacter: 0, ampDrive: 0.15, ampToneHigh: 0.6 },
    크런치: { ampCharacter: 1, ampDrive: 0.45 },
    디스토션: { ampCharacter: 2, ampDrive: 0.75, ampToneMid: 0.35 },
    퍼즈: { ampCharacter: 3, ampDrive: 0.9, ampToneLow: 0.6 },
  },
};

const ELECTRIC_GUITAR: InstrumentDefinition = {
  id: 'electric-guitar',
  schemaVersion: 1,
  name: '일렉 기타 (스트랫)',
  category: '기타',
  extends: 'amped-string',
  params: {
    scaleLengthMm: 648, stiffness: 0.012, damping: 0.04, sustainSec: 5,
    // 스트랫은 싱글코일. 앰프를 통과하는 소리는 실제로 모노라 좌우로 펴지 않는다
    pickupHumbucker: 0,
  },
  range: { low: 40, high: 88 },
};

const LES_PAUL: InstrumentDefinition = {
  id: 'electric-guitar-lp',
  schemaVersion: 1,
  name: '일렉 기타 (레스폴)',
  category: '기타',
  extends: 'electric-guitar',
  params: {
    scaleLengthMm: 628, // 스트랫 648
    // **여기가 두 기타의 진짜 차이다.** 예전에는 줄 길이 20mm 뿐이라
    // 실제 스트랫과 레스폴의 차이를 못 냈다 (`ROADMAP.md` S1-3)
    pickupHumbucker: 1,
  },
};

const ELECTRIC_BASS: InstrumentDefinition = {
  id: 'electric-bass',
  schemaVersion: 1,
  name: '일렉 베이스',
  category: '베이스',
  extends: 'amped-string',
  params: {
    scaleLengthMm: 864, stiffness: 0.02, damping: 0.06, sustainSec: 4,
    // 베이스는 캐비닛 성격이 달라 기본을 클린 쪽으로 둔다
    ampCharacter: 0, ampDrive: 0.2, ampToneLow: 0.65,
  },
  range: { low: 28, high: 67 }, // E1 ~ G4
};

const UKULELE: InstrumentDefinition = {
  id: 'ukulele-soprano',
  schemaVersion: 1,
  name: '우쿨렐레 (소프라노)',
  category: '줄',
  extends: 'acoustic-guitar',
  params: { scaleLengthMm: 347, stiffness: 0.016, damping: 0.07, sustainSec: 1.6 },
  range: { low: 60, high: 93 }, // C4 ~ A6
};

const MANDOLIN: InstrumentDefinition = {
  id: 'mandolin',
  schemaVersion: 1,
  name: '만돌린',
  category: '줄',
  extends: 'acoustic-guitar',
  params: { scaleLengthMm: 350, stiffness: 0.022, damping: 0.06, sustainSec: 1.2, pluckHardness: 0.75 },
  range: { low: 55, high: 91 },
};

const HARP: InstrumentDefinition = {
  id: 'harp',
  schemaVersion: 1,
  name: '하프',
  category: '줄',
  extends: 'string-base',
  params: {
    scaleLengthMm: 700, stiffness: 0.006, damping: 0.03, sustainSec: 6, pluckHardness: 0.15,
    // 하프는 뜯고 손을 떼도 울린다 — 줄을 짚어 죽이는 연주가 예외다
    letRing: 1,
    // 줄이 47개나 늘어서 있어 낮은 음과 높은 음의 위치가 실제로 멀다
    stereoWidth: 0.45,
  },
  range: { low: 24, high: 96 },
};

// --- 신스 (Tier 3) ---------------------------------------------------------
//
// 물리 모델링이 아니다. 줄 정의를 상속하지 않으므로 줄 파라미터가 섞이지 않는다.
// 엔벌로프는 wasm 에서 줄 슬롯을 재사용하지만, 정의 층에서는 이름이 따로다.

const SYNTH_BASE: InstrumentDefinition = {
  id: 'synth-base',
  schemaVersion: 1,
  name: '신스 (기준)',
  category: '건반·신스',
  voice: 'virtual-analog',
  range: { low: 24, high: 108 },
  paramSpecs: {
    synthWaveform: {
      type: 'enum', min: 0, max: 3, default: 0,
      label: '파형', group: '오실레이터',
      options: ['톱니', '사각', '삼각', '사인'],
    },
    synthDetuneCents: {
      type: 'float', min: 0, max: 30, default: 8,
      unit: '¢', label: '디튠', group: '오실레이터',
    },
    synthCutoffHz: {
      type: 'float', min: 100, max: 16000, default: 3000,
      unit: 'Hz', label: '컷오프', curve: 'log', group: '필터',
    },
    synthResonance: {
      type: 'float', min: 0, max: 1, default: 0.2,
      label: '레조넌스', group: '필터',
    },
    synthFilterEnv: {
      type: 'float', min: 0, max: 1, default: 0.5,
      label: '필터 엔벌로프', group: '필터',
    },
    // wasm 에서 줄 슬롯 0~3 을 재사용한다 (신스에는 줄 파라미터가 의미 없다)
    scaleLengthMm: {
      type: 'float', min: 0.5, max: 500, default: 5,
      unit: 'ms', label: '어택', curve: 'log', group: '엔벌로프',
    },
    stiffness: {
      type: 'float', min: 1, max: 2000, default: 300,
      unit: 'ms', label: '디케이', curve: 'log', group: '엔벌로프',
    },
    damping: {
      type: 'float', min: 0, max: 1, default: 0.6,
      label: '서스테인', group: '엔벌로프',
    },
    sustainSec: {
      type: 'float', min: 5, max: 2000, default: 250,
      unit: 'ms', label: '릴리즈', curve: 'log', group: '엔벌로프',
    },
    ampEnabled: { type: 'int', min: 0, max: 1, default: 0, label: '앰프', group: '앰프' },
    ampDrive: { type: 'float', min: 0, max: 1, default: 0, label: '드라이브', group: '앰프' },
    ...COMMON_SPECS,
  },
  params: {
    synthWaveform: 0,
    synthDetuneCents: 8,
    synthCutoffHz: 3000,
    synthResonance: 0.2,
    synthFilterEnv: 0.5,
    scaleLengthMm: 5,
    stiffness: 300,
    damping: 0.6,
    sustainSec: 250,
    ampEnabled: 0,
    ampDrive: 0,
    // 신스는 **반드시** 노트오프를 받아야 한다. 안 받으면 ADSR 이 Sustain 단계에서
    // 멈춰 영원히 울린다 (거기서 나올 길이 노트오프뿐이다).
    // 뮤트는 자기 릴리즈(`sustainSec` 슬롯)가 하므로 `releaseMs` 는 쓰이지 않는다
    letRing: 0,
    // 신스의 밝기는 필터 컷오프다. 벨로시티→컷오프는 아날로그 신스의 기본 배선이다
    velocityBrightness: 0.3,
    // 신스는 원래 기계적인 것이 특징이라 약하게만
    variationAmount: 0.15,
  },
  tones: {
    default: {},
    리드: { synthWaveform: 0, synthCutoffHz: 5000, synthResonance: 0.35, damping: 0.5 },
    패드: { synthWaveform: 2, scaleLengthMm: 300, sustainSec: 1200, synthCutoffHz: 1800, damping: 0.8 },
    베이스: { synthWaveform: 1, synthCutoffHz: 900, synthDetuneCents: 0, stiffness: 200, damping: 0.4 },
  },
};

const SYNTH_LEAD: InstrumentDefinition = {
  id: 'synth-lead',
  schemaVersion: 1,
  name: '신스 리드',
  extends: 'synth-base',
  params: { synthCutoffHz: 5000, synthResonance: 0.35 },
  range: { low: 48, high: 108 },
};

const SYNTH_PAD: InstrumentDefinition = {
  id: 'synth-pad',
  schemaVersion: 1,
  name: '신스 패드',
  extends: 'synth-base',
  params: {
    synthWaveform: 2, scaleLengthMm: 300, sustainSec: 1200,
    synthCutoffHz: 1800, damping: 0.8, synthDetuneCents: 14,
    // 패드는 넓게 깔리는 것이 존재 이유다
    stereoWidth: 0.4,
  },
  range: { low: 36, high: 96 },
};

const SYNTH_BASS: InstrumentDefinition = {
  id: 'synth-bass',
  schemaVersion: 1,
  name: '신스 베이스',
  category: '베이스',
  extends: 'synth-base',
  params: {
    synthWaveform: 1, synthCutoffHz: 900, synthDetuneCents: 0,
    stiffness: 200, damping: 0.4,
  },
  range: { low: 24, high: 60 },
};

// --- 모달 (Tier 2) ---------------------------------------------------------

const MODAL_BASE: InstrumentDefinition = {
  id: 'modal-base',
  schemaVersion: 1,
  name: '모달 (기준)',
  category: '말렛·벨',
  voice: 'modal',
  range: { low: 36, high: 100 },
  paramSpecs: {
    modalMaterial: {
      type: 'enum', min: 0, max: 3, default: 0,
      label: '재질', group: '진동체',
      options: ['마림바', '비브라폰', '벨', '글로켄슈필'],
    },
    modalDecaySec: {
      type: 'float', min: 0.05, max: 12, default: 1.2,
      unit: 's', label: '감쇠', curve: 'log', group: '진동체',
    },
    strikePosition: {
      type: 'float', min: 0.02, max: 0.5, default: 0.25,
      label: '때리는 위치', group: '연주',
    },
    // 때리는 세기는 wasm 에서 뜯는 세기 슬롯을 함께 쓴다
    pluckHardness: {
      type: 'float', min: 0, max: 1, default: 0.5,
      label: '때리는 세기', group: '연주',
    },
    ampEnabled: { type: 'int', min: 0, max: 1, default: 0, label: '앰프', group: '앰프' },
    ...COMMON_SPECS,
  },
  params: {
    modalMaterial: 0,
    modalDecaySec: 1.2,
    strikePosition: 0.25,
    pluckHardness: 0.5,
    ampEnabled: 0,
    // 때린 금속·나무는 손을 떼도 계속 울린다. 그게 이 악기들의 성질이다 —
    // 감쇠는 `modalDecaySec` 이 정한다
    letRing: 1,
    releaseMs: 150,
    // 말렛은 세게 때리면 확실히 밝아진다
    velocityBrightness: 0.3,
    variationAmount: 0.4,
    // 건반처럼 음판이 왼쪽(낮음)에서 오른쪽(높음)으로 늘어서 있다
    stereoWidth: 0.3,
  },
  tones: { default: {}, 부드럽게: { pluckHardness: 0.2 }, 세게: { pluckHardness: 0.95 } },
};

const MARIMBA: InstrumentDefinition = {
  id: 'marimba',
  schemaVersion: 1,
  name: '마림바',
  extends: 'modal-base',
  params: { modalMaterial: 0, modalDecaySec: 1.0 },
  range: { low: 45, high: 96 },
};

const VIBRAPHONE: InstrumentDefinition = {
  id: 'vibraphone',
  schemaVersion: 1,
  name: '비브라폰',
  extends: 'modal-base',
  params: { modalMaterial: 1, modalDecaySec: 3.5 },
  range: { low: 53, high: 89 },
};

const TUBULAR_BELL: InstrumentDefinition = {
  id: 'tubular-bell',
  schemaVersion: 1,
  name: '차임벨',
  extends: 'modal-base',
  params: { modalMaterial: 2, modalDecaySec: 8.0, strikePosition: 0.13 },
  range: { low: 48, high: 84 },
};

const GLOCKENSPIEL: InstrumentDefinition = {
  id: 'glockenspiel',
  schemaVersion: 1,
  name: '글로켄슈필',
  extends: 'modal-base',
  params: { modalMaterial: 3, modalDecaySec: 1.6 },
  range: { low: 72, high: 108 },
};

// --- 드럼 (합성) -----------------------------------------------------------
//
// sound.md 3절은 드럼을 Tier 4(샘플)로 둔다. 그 판단은 지금도 맞지만 **샘플이 없다**
// — 녹음이나 라이선스가 필요하고 코드로 만들 수 없다. 드럼이 아예 없으면
// Phase 1 완료 조건("곡 하나를 끝낸다")이 성립하지 않으므로 합성 드럼을 넣는다.
// 어쿠스틱 드럼 샘플은 에셋이 생기면 샘플러 보이스로 따로 들어온다.
//
// 드럼은 음정이 아니라 **소리 종류**로 고른다. 그래서 킷 하나가 아니라
// 악기 하나 = 드럼 하나다 — 피아노롤에서 트랙마다 하나씩 찍는다.

const DRUM_BASE: InstrumentDefinition = {
  id: 'drum-base',
  schemaVersion: 1,
  name: '드럼 (기준)',
  category: '드럼',
  voice: 'percussion',
  range: { low: 24, high: 84 },
  paramSpecs: {
    drumKind: {
      type: 'enum', min: 0, max: 5, default: 0,
      label: '종류', group: '드럼',
      options: ['킥', '스네어', '하이햇(닫힘)', '하이햇(열림)', '탐', '클랩'],
    },
    drumDecaySec: {
      type: 'float', min: 0.02, max: 2, default: 0.35,
      unit: 's', label: '길이', curve: 'log', group: '드럼',
    },
    drumPitchDrop: {
      type: 'float', min: 0, max: 2, default: 0.7,
      label: '음정 스윕', group: '드럼',
    },
    drumNoiseAmount: {
      type: 'float', min: 0, max: 1, default: 0,
      label: '노이즈', group: '드럼',
    },
    strikePosition: {
      type: 'float', min: 0, max: 1, default: 0.5,
      label: '밝기', group: '드럼',
    },
    ampEnabled: { type: 'int', min: 0, max: 1, default: 0, label: '앰프', group: '앰프' },
    ...COMMON_SPECS,
  },
  params: {
    drumKind: 0,
    drumDecaySec: 0.35,
    drumPitchDrop: 0.7,
    drumNoiseAmount: 0,
    strikePosition: 0.5,
    ampEnabled: 0,
    // 세게 치면 밝아진다. 드럼에서 특히 크게 들리는 성질이다
    velocityBrightness: 0.4,
    // **드럼에서 가장 크게 들린다** — 없으면 하이햇 16분이 머신건이 된다
    variationAmount: 0.7,
    // **좌우 퍼짐은 켜지 않는다.** 지금 배치는 음 높이로 정해지는데, 그러면
    // 킥이 왼쪽으로 가 버린다. 드럼은 킥·스네어가 가운데인 것이 기준이다.
    // 악기별 팬 오프셋이 생기면 그때 하이햇·탐만 편다
    stereoWidth: 0,
    // 원샷이다. 킥을 짧게 눌렀다고 짧아지면 안 된다 — 길이는 `drumDecaySec` 이 정한다.
    // Rust 쪽도 타악기의 노트오프를 무시하지만(`voice.rs`), 여기서 명시해 두면
    // 애초에 노트오프를 보내지 않아 헛일이 줄고 의도가 드러난다
    letRing: 1,
  },
  tones: { default: {}, 짧게: { drumDecaySec: 0.12 }, 길게: { drumDecaySec: 1.0 } },
};

const KICK: InstrumentDefinition = {
  id: 'kick',
  schemaVersion: 1,
  name: '킥',
  extends: 'drum-base',
  params: { drumKind: 0, drumDecaySec: 0.4, drumPitchDrop: 0.8 },
  range: { low: 24, high: 48 },
};

const SNARE: InstrumentDefinition = {
  id: 'snare',
  schemaVersion: 1,
  name: '스네어',
  extends: 'drum-base',
  params: { drumKind: 1, drumDecaySec: 0.22, drumPitchDrop: 0.3, drumNoiseAmount: 0.7 },
  range: { low: 36, high: 60 },
};

const HIHAT: InstrumentDefinition = {
  id: 'hihat',
  schemaVersion: 1,
  name: '하이햇',
  extends: 'drum-base',
  params: { drumKind: 2, drumDecaySec: 0.3, drumPitchDrop: 0, drumNoiseAmount: 1 },
  range: { low: 48, high: 84 },
};

const HIHAT_OPEN: InstrumentDefinition = {
  id: 'hihat-open',
  schemaVersion: 1,
  name: '하이햇 (열림)',
  extends: 'drum-base',
  params: { drumKind: 3, drumDecaySec: 0.6, drumPitchDrop: 0, drumNoiseAmount: 1 },
  range: { low: 48, high: 84 },
};

const TOM: InstrumentDefinition = {
  id: 'tom',
  schemaVersion: 1,
  name: '탐',
  extends: 'drum-base',
  params: { drumKind: 4, drumDecaySec: 0.5, drumPitchDrop: 0.4, drumNoiseAmount: 0.15 },
  range: { low: 36, high: 72 },
};

const CLAP: InstrumentDefinition = {
  id: 'clap',
  schemaVersion: 1,
  name: '클랩',
  extends: 'drum-base',
  params: { drumKind: 5, drumDecaySec: 0.35, drumPitchDrop: 0, drumNoiseAmount: 1 },
  range: { low: 48, high: 72 },
};

export const BUILT_IN_INSTRUMENTS: readonly InstrumentDefinition[] = [
  STRING_BASE,
  AMPED_STRING,
  ACOUSTIC_GUITAR,
  ELECTRIC_GUITAR,
  LES_PAUL,
  ELECTRIC_BASS,
  UKULELE,
  MANDOLIN,
  HARP,
  SYNTH_BASE,
  SYNTH_LEAD,
  SYNTH_PAD,
  SYNTH_BASS,
  MODAL_BASE,
  MARIMBA,
  VIBRAPHONE,
  TUBULAR_BELL,
  GLOCKENSPIEL,
  DRUM_BASE,
  KICK,
  SNARE,
  HIHAT,
  HIHAT_OPEN,
  TOM,
  CLAP,
];

/** 기준 정의는 사용자에게 악기로 보이지 않는다 — 연주용 악기가 아니다 */
const ABSTRACT_IDS = new Set([
  'string-base', 'amped-string', 'synth-base', 'modal-base', 'drum-base',
]);

export function createRegistry(
  defs: readonly InstrumentDefinition[] = BUILT_IN_INSTRUMENTS,
): Map<string, InstrumentDefinition> {
  const map = new Map<string, InstrumentDefinition>();
  for (const def of defs) {
    if (map.has(def.id)) throw new Error(`악기 id 중복: ${def.id}`);
    map.set(def.id, def);
  }
  return map;
}

export function playableInstrumentIds(
  defs: readonly InstrumentDefinition[] = BUILT_IN_INSTRUMENTS,
): string[] {
  return defs.filter((d) => !ABSTRACT_IDS.has(d.id)).map((d) => d.id);
}

/**
 * 분류별로 묶은 악기 목록. **화면은 이걸 그대로 그린다** (`plan.md` 원칙 5 —
 * 악기가 늘어나도 화면을 새로 만들지 않는다).
 *
 * 평면 목록이 20개를 넘어가면 고르기가 힘들어진다. 기타만 셋인데 하프·킥 사이에
 * 흩어져 있으면 "기타 중에 뭐가 있나"를 볼 수 없다.
 *
 * 빈 분류는 나오지 않는다 — 악기를 지웠을 때 빈 그룹 헤더가 남으면 안 된다.
 */
export function instrumentsByCategory(
  defs: readonly InstrumentDefinition[] = BUILT_IN_INSTRUMENTS,
): { category: InstrumentCategory; instruments: { id: string; name: string }[] }[] {
  const registry = createRegistry(defs);
  const groups = new Map<InstrumentCategory, { id: string; name: string }[]>();

  for (const id of playableInstrumentIds(defs)) {
    const resolved = resolveInstrument(id, registry);
    const list = groups.get(resolved.category) ?? [];
    list.push({ id, name: resolved.name });
    groups.set(resolved.category, list);
  }

  return CATEGORY_ORDER
    .filter((category) => (groups.get(category)?.length ?? 0) > 0)
    .map((category) => ({ category, instruments: groups.get(category)! }));
}

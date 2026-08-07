/**
 * 악기 정의 데이터 (`sound.md` 9-2).
 *
 * **여기 아래는 전부 데이터다.** 새 줄 악기를 넣을 때 엔진 코드(`voice/`)를 열지 않는다.
 * `instruments.test.ts` 가 그 성질을 테스트로 고정한다.
 *
 * 나중에 JSON 파일 + 원격 로딩으로 옮길 수 있다. 지금 TS 로 두는 이유는
 * 타입 검사를 받으면서 형태를 확정하는 게 먼저이기 때문.
 */

import type { InstrumentDefinition } from './types.ts';

/**
 * 웨이브가이드 줄의 기준 정의. 파생 악기들은 여기서 숫자만 덮어쓴다.
 * 파라미터 의미는 `spike/m0-karplus/ks-string.js` 와 같다.
 */
const STRING_BASE: InstrumentDefinition = {
  id: 'string-base',
  schemaVersion: 1,
  name: '줄 (기준)',
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
  extends: 'string-base',
  params: { scaleLengthMm: 650, stiffness: 0.01, damping: 0.045, sustainSec: 4 },
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
  extends: 'amped-string',
  params: { scaleLengthMm: 648, stiffness: 0.012, damping: 0.04, sustainSec: 5 },
  range: { low: 40, high: 88 },
};

const LES_PAUL: InstrumentDefinition = {
  id: 'electric-guitar-lp',
  schemaVersion: 1,
  name: '일렉 기타 (레스폴)',
  extends: 'electric-guitar',
  params: { scaleLengthMm: 628 }, // 스트랫 648 과의 차이가 이 한 줄
};

const ELECTRIC_BASS: InstrumentDefinition = {
  id: 'electric-bass',
  schemaVersion: 1,
  name: '일렉 베이스',
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
  extends: 'acoustic-guitar',
  params: { scaleLengthMm: 347, stiffness: 0.016, damping: 0.07, sustainSec: 1.6 },
  range: { low: 60, high: 93 }, // C4 ~ A6
};

const MANDOLIN: InstrumentDefinition = {
  id: 'mandolin',
  schemaVersion: 1,
  name: '만돌린',
  extends: 'acoustic-guitar',
  params: { scaleLengthMm: 350, stiffness: 0.022, damping: 0.06, sustainSec: 1.2, pluckHardness: 0.75 },
  range: { low: 55, high: 91 },
};

const HARP: InstrumentDefinition = {
  id: 'harp',
  schemaVersion: 1,
  name: '하프',
  extends: 'string-base',
  params: { scaleLengthMm: 700, stiffness: 0.006, damping: 0.03, sustainSec: 6, pluckHardness: 0.15 },
  range: { low: 24, high: 96 },
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
];

/** 기준 정의는 사용자에게 악기로 보이지 않는다 — 연주용 악기가 아니다 */
const ABSTRACT_IDS = new Set(['string-base', 'amped-string']);

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

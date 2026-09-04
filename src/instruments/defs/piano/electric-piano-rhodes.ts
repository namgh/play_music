import type { InstrumentDefinition } from '../../types.ts';
import { AMP_SPECS } from '../../specs.ts';

export const definition: InstrumentDefinition = {
  id: 'electric-piano-rhodes',
  schemaVersion: 1,
  name: '일렉 피아노 (로즈)',
  baseLevel: 1.41,
  category: '피아노',
  extends: 'modal-base',
  // 픽업 → 앰프를 거치는 건반이라 앰프 선언이 필요하다 (모달 기준에는 없다)
  paramSpecs: { ...AMP_SPECS },
  params: {
    // 로즈는 줄이 아니라 **금속 타인(tine)** 을 때린다 — 모달 합성이 맞는 기법이다
    modalMaterial: 1, // 비브라폰과 같은 금속 계열
    modalDecaySec: 2.4,
    strikePosition: 0.18,
    pluckHardness: 0.6,
    // 픽업으로 받아 앰프를 거친다. 그 살짝의 배음이 로즈의 "벨 같은" 소리다
    ampEnabled: 1,
    ampCharacter: 0,
    ampDrive: 0.18,
    ampToneLow: 0.55, ampToneMid: 0.45, ampToneHigh: 0.5,
    ampLevel: 0.7, ampCabinet: 0, pickupPosition: 0.25,
    velocityBrightness: 0.55, // 세게 치면 "짜앙" 하고 갈라지는 것이 로즈다
    variationAmount: 0.3,
    stereoWidth: 0.3,
    letRing: 0,
    releaseMs: 120,
  },
  range: { low: 28, high: 100 },
  tones: {
    default: {},
    벨: { ampDrive: 0.1, pluckHardness: 0.85, modalDecaySec: 3.2 },
    거친: { ampDrive: 0.45, ampCharacter: 1, pluckHardness: 0.8 },
  },
};

import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'harp',
  schemaVersion: 1,
  name: '하프',
  baseLevel: 1.06,
  category: '줄',
  extends: 'string-base',
  params: {
    scaleLengthMm: 700, stiffness: 0.006, damping: 0.03, sustainSec: 6, pluckHardness: 0.15,
    // 하프는 뜯고 손을 떼도 울린다 — 줄을 짚어 죽이는 연주가 예외다
    letRing: 1,
    // 줄이 47개나 늘어서 있어 낮은 음과 높은 음의 위치가 실제로 멀다
    stereoWidth: 0.45,
    // 하프는 통이 아니라 큰 사운드보드라 공진이 낮고 넓다
    bodyAmount: 0.35, bodyHelmholtzHz: 75,
  },
  range: { low: 24, high: 96 },
  // 하프는 통이 아니라 큰 사운드보드 — 넓고 완만한 공진 몇 개다
  bodyModes: [
    { ratio: 1.00, gain: 1.00, q: 7 },
    { ratio: 1.90, gain: 0.60, q: 9 },
    { ratio: 3.20, gain: 0.30, q: 11 },
  ],
  sympatheticSemitones: [0, 2, 4, 7, 9, 12, 14, 16], // 온음계로 늘어서 있다
};

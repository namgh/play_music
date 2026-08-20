import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'mandolin',
  schemaVersion: 1,
  name: '만돌린',
  category: '줄',
  extends: 'acoustic-guitar',
  params: {
    scaleLengthMm: 350, stiffness: 0.022, damping: 0.06, sustainSec: 1.2, pluckHardness: 0.75,
    bodyAmount: 0.45, bodyHelmholtzHz: 230,
  },
  range: { low: 55, high: 91 },
  // 만돌린은 앞판이 아치라 모드가 더 위로 벌어진다
  bodyModes: [
    { ratio: 1.00, gain: 1.00, q: 14 },
    { ratio: 2.20, gain: 0.65, q: 18 },
    { ratio: 3.40, gain: 0.35, q: 20 },
  ],
  sympatheticSemitones: [0, 7, 14, 21], // GDAE
};

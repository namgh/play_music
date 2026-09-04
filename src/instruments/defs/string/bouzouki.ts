import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'bouzouki',
  schemaVersion: 1,
  name: '부주키',
  baseLevel: 1.25,
  category: '줄',
  extends: 'acoustic-guitar',
  params: {
    scaleLengthMm: 670, stiffness: 0.018, damping: 0.05, sustainSec: 3.4,
    // 디튠 7센트는 측정 음정을 1.25센트 밀었다 — 겹줄 느낌은 편광 비율로 낸다
    polarizationMix: 0.5, polarizationDetuneCents: 2, pluckHardness: 0.65,
  },
  range: { low: 45, high: 86 },
};

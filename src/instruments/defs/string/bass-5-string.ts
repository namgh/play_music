import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'bass-5-string',
  schemaVersion: 1,
  name: '5현 베이스',
  baseLevel: 1.00,
  category: '베이스',
  extends: 'electric-bass',
  params: {
    // 저음현 하나가 더 있다 — B0 까지 내려간다
    scaleLengthMm: 889, stiffness: 0.010, sustainSec: 5,
  },
  range: { low: 23, high: 67 },
};

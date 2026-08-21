import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'double-bass-pizz',
  schemaVersion: 1,
  name: '콘트라베이스 (피치카토)',
  category: '베이스',
  extends: 'electric-bass',
  params: {
    // 현이 아주 길고 굵다 — 900mm 상한이라 거기에 붙인다
    scaleLengthMm: 900, stiffness: 0.004, damping: 0.10, sustainSec: 2.4,
    pluckHardness: 0.15, pluckPosition: 0.13, ampEnabled: 0,
  },
  range: { low: 28, high: 62 },
};

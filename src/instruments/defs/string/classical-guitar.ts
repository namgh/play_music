import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'classical-guitar',
  schemaVersion: 1,
  name: '클래식 기타 (나일론)',
  category: '기타',
  extends: 'acoustic-guitar',
  params: {
    scaleLengthMm: 650, stiffness: 0.006, damping: 0.075, sustainSec: 3.2,
    // 나일론은 강철보다 훨씬 무르다 — 손끝으로 뜯으므로 타격도 부드럽다
    pluckHardness: 0.22, pluckPosition: 0.22,
  },
  range: { low: 40, high: 84 },
};

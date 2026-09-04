import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'rimshot',
  schemaVersion: 1,
  name: '림샷',
  baseLevel: 1.41,
  category: '드럼',
  extends: 'drum-base',
  params: {
    // 테를 때린다 — 스네어보다 훨씬 짧고 와이어가 덜 울린다
    drumKind: 1, drumDecaySec: 0.09, drumSnareWires: 0.25, drumNoiseAmount: 0.45,
    strikePosition: 0.85,
  },
  range: { low: 37, high: 85 },
};

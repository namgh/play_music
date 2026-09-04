import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'hihat',
  schemaVersion: 1,
  name: '하이햇',
  baseLevel: 1.12,
  extends: 'drum-base',
  // 금속판은 막보다 모드가 훨씬 불규칙하다. 노이즈만으로는 "치" 소리가 나지
  // "챙" 이 안 난다
  params: {
    drumKind: 2, drumDecaySec: 0.3, drumPitchDrop: 0, drumNoiseAmount: 1,
    drumModeCount: 5, drumInharmonicity: 1,
  },
  range: { low: 42, high: 84 },
};

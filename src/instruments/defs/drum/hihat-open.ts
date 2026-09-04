import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'hihat-open',
  schemaVersion: 1,
  name: '하이햇 (열림)',
  baseLevel: 0.76,
  extends: 'drum-base',
  params: {
    drumKind: 3, drumDecaySec: 0.6, drumPitchDrop: 0, drumNoiseAmount: 1,
    drumModeCount: 5, drumInharmonicity: 1,
  },
  range: { low: 46, high: 84 },
};

import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'tom-high',
  schemaVersion: 1,
  name: '하이 탐',
  category: '드럼',
  extends: 'drum-base',
  params: {
    drumKind: 4, drumDecaySec: 0.42, drumPitchDrop: 0.75, drumNoiseAmount: 0.12,
  },
  range: { low: 50, high: 64 },
};

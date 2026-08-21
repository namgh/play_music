import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'tom-floor',
  schemaVersion: 1,
  name: '플로어 탐',
  category: '드럼',
  extends: 'drum-base',
  params: {
    drumKind: 4, drumDecaySec: 0.85, drumPitchDrop: 0.55, drumNoiseAmount: 0.1,
  },
  range: { low: 36, high: 50 },
};

import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'bongo',
  schemaVersion: 1,
  name: '봉고',
  category: '드럼',
  extends: 'drum-base',
  params: {
    drumKind: 4, drumDecaySec: 0.18, drumPitchDrop: 0.2, drumNoiseAmount: 0.25,
  },
  range: { low: 60, high: 79 },
};

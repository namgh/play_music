import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'clap',
  schemaVersion: 1,
  name: '클랩',
  extends: 'drum-base',
  params: { drumKind: 5, drumDecaySec: 0.35, drumPitchDrop: 0, drumNoiseAmount: 1 },
  range: { low: 48, high: 72 },
};

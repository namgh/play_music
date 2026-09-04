import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'marimba',
  schemaVersion: 1,
  name: '마림바',
  baseLevel: 1.32,
  extends: 'modal-base',
  params: { modalMaterial: 0, modalDecaySec: 1.0 },
  range: { low: 45, high: 96 },
};

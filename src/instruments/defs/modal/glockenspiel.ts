import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'glockenspiel',
  schemaVersion: 1,
  name: '글로켄슈필',
  baseLevel: 0.87,
  extends: 'modal-base',
  params: { modalMaterial: 3, modalDecaySec: 1.6 },
  range: { low: 72, high: 108 },
};

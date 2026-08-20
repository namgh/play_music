import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'vibraphone',
  schemaVersion: 1,
  name: '비브라폰',
  extends: 'modal-base',
  params: { modalMaterial: 1, modalDecaySec: 3.5 },
  range: { low: 53, high: 89 },
};

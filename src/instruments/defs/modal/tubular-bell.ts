import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'tubular-bell',
  schemaVersion: 1,
  name: '차임벨',
  extends: 'modal-base',
  params: { modalMaterial: 2, modalDecaySec: 8.0, strikePosition: 0.13 },
  range: { low: 48, high: 84 },
};

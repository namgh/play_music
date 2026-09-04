import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'xylophone',
  schemaVersion: 1,
  name: '실로폰',
  baseLevel: 1.41,
  category: '말렛·벨',
  extends: 'modal-base',
  params: {
    modalMaterial: 0, modalDecaySec: 0.45, pluckHardness: 0.85, strikePosition: 0.2,
  },
  range: { low: 53, high: 96 },
};

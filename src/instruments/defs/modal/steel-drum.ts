import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'steel-drum',
  schemaVersion: 1,
  name: '스틸팬',
  baseLevel: 1.41,
  category: '말렛·벨',
  extends: 'modal-base',
  params: {
    modalMaterial: 2, modalDecaySec: 1.8, pluckHardness: 0.5, strikePosition: 0.3,
  },
  range: { low: 48, high: 84 },
};

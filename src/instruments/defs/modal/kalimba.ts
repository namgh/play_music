import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'kalimba',
  schemaVersion: 1,
  name: '칼림바',
  category: '말렛·벨',
  extends: 'modal-base',
  params: {
    // 엄지로 튕기는 금속 혀 — 나무 통이 받쳐 둥글다
    modalMaterial: 0, modalDecaySec: 1.6, pluckHardness: 0.35, strikePosition: 0.35,
  },
  range: { low: 48, high: 84 },
};

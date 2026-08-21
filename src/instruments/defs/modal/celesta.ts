import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'celesta',
  schemaVersion: 1,
  name: '첼레스타',
  category: '말렛·벨',
  extends: 'modal-base',
  params: {
    // 펠트 망치로 금속판을 친다 — 글로켄보다 부드럽고 길다
    modalMaterial: 3, modalDecaySec: 2.2, pluckHardness: 0.3,
  },
  range: { low: 48, high: 96 },
};

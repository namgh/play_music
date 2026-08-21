import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'music-box',
  schemaVersion: 1,
  name: '뮤직박스',
  category: '말렛·벨',
  extends: 'modal-base',
  params: {
    // 아주 짧은 금속 빗살 — 맑고 금방 사라진다
    modalMaterial: 3, modalDecaySec: 0.7, pluckHardness: 0.6, strikePosition: 0.12,
  },
  range: { low: 60, high: 100 },
};

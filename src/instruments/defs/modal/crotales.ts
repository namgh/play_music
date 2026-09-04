import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'crotales',
  schemaVersion: 1,
  name: '크로탈',
  baseLevel: 1.02,
  category: '말렛·벨',
  extends: 'modal-base',
  params: {
    // 작고 두꺼운 놋쇠 원반 — 아주 높고 아주 길게 남는다
    modalMaterial: 2, modalDecaySec: 6, pluckHardness: 0.75,
  },
  range: { low: 72, high: 100 },
};

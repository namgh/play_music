import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'electric-bass',
  schemaVersion: 1,
  name: '일렉 베이스',
  baseLevel: 1.00,
  category: '베이스',
  extends: 'amped-string',
  params: {
    scaleLengthMm: 864, stiffness: 0.02, damping: 0.06, sustainSec: 4,
    // 베이스 4번줄 E1
    sympatheticBaseHz: 41.2,
    // 베이스는 캐비닛 성격이 달라 기본을 클린 쪽으로 둔다
    ampCharacter: 0, ampDrive: 0.2, ampToneLow: 0.65,
  },
  range: { low: 28, high: 67 }, // E1 ~ G4
};

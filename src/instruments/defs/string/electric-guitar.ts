import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'electric-guitar',
  schemaVersion: 1,
  name: '일렉 기타 (스트랫)',
  baseLevel: 0.62,
  category: '기타',
  extends: 'amped-string',
  params: {
    scaleLengthMm: 648, stiffness: 0.012, damping: 0.04, sustainSec: 5,
    // 스트랫은 싱글코일. 앰프를 통과하는 소리는 실제로 모노라 좌우로 펴지 않는다
    pickupHumbucker: 0,
  },
  range: { low: 40, high: 88 },
};

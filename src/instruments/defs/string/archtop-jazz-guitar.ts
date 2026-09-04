import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'archtop-jazz-guitar',
  schemaVersion: 1,
  name: '재즈 기타 (아치탑)',
  baseLevel: 0.73,
  category: '기타',
  extends: 'electric-guitar',
  params: {
    // 재즈 톤은 험버커를 넥 쪽에서, 픽업 위치를 멀리 두어 고음을 죽인다
    scaleLengthMm: 628, damping: 0.085, sustainSec: 4,
    pluckPosition: 0.32, pluckHardness: 0.25, pickupHumbucker: 1,
  },
  range: { low: 40, high: 86 },
};

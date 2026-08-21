import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'harpsichord',
  schemaVersion: 1,
  name: '하프시코드',
  category: '피아노',
  extends: 'acoustic-guitar',
  params: {
    // 건반이지만 때리지 않고 **뜯는다**. 그래서 세기를 줘도 밝기가 안 변한다
    scaleLengthMm: 700, stiffness: 0.011, damping: 0.06, sustainSec: 2.2,
    // 타건 0.95 는 고배음을 너무 세게 실어 측정 음정을 1.34센트 밀었다.
    // 뜯는 성격은 위치(0.11)로 내고 단단함은 낮춘다
    pluckHardness: 0.75, pluckPosition: 0.11, velocityBrightness: 0,
  },
  // 700mm 한 가지 줄 길이로는 저음이 안 된다 — 실제 하프시코드는 저음현이
  // 훨씬 길다. 우리 모델은 줄 길이가 하나라 낼 수 있는 음역만 선언한다
  range: { low: 45, high: 89 },
};

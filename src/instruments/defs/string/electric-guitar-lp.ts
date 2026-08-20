import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'electric-guitar-lp',
  schemaVersion: 1,
  name: '일렉 기타 (레스폴)',
  category: '기타',
  extends: 'electric-guitar',
  params: {
    scaleLengthMm: 628, // 스트랫 648
    // **여기가 두 기타의 진짜 차이다.** 예전에는 줄 길이 20mm 뿐이라
    // 실제 스트랫과 레스폴의 차이를 못 냈다 (`ROADMAP.md` S1-3)
    pickupHumbucker: 1,
  },
};

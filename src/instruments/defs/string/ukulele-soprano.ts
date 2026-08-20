import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'ukulele-soprano',
  schemaVersion: 1,
  name: '우쿨렐레 (소프라노)',
  category: '줄',
  extends: 'acoustic-guitar',
  params: {
    scaleLengthMm: 347, stiffness: 0.016, damping: 0.07, sustainSec: 1.6,
    // 우쿨렐레는 G4 부터 시작하는 재진입 조율이다
    sympatheticBaseHz: 392.0,
    // 통이 작아 공진이 훨씬 위에 있다 — 이게 우쿨렐레 특유의 "통통" 소리다
    bodyAmount: 0.5, bodyHelmholtzHz: 260,
  },
  range: { low: 60, high: 93 }, // C4 ~ A6
  // **모드 구성 자체가 다르다.** 작고 얕은 통이라 상위 모드가 촘촘하고 Q 가 낮다 —
  // 기타 모드를 위로 옮기기만 하면 "작은 기타"가 되지 우쿨렐레가 안 된다
  bodyModes: [
    { ratio: 1.00, gain: 1.00, q: 9 },
    { ratio: 1.70, gain: 0.70, q: 12 },
    { ratio: 2.30, gain: 0.45, q: 14 },
    { ratio: 3.10, gain: 0.25, q: 16 },
  ],
  sympatheticSemitones: [0, 4, 9, 14], // GCEA 재진입 조율
};

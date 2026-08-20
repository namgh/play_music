import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'acoustic-guitar',
  schemaVersion: 1,
  name: '어쿠스틱 기타',
  category: '기타',
  extends: 'string-base',
  params: {
    scaleLengthMm: 650, stiffness: 0.01, damping: 0.045, sustainSec: 4,
    // 어쿠스틱은 몸통이 공기를 울려 소리가 한 점에서 나오지 않는다
    stereoWidth: 0.2,
    // **몸통을 켠다.** 지금까지 줄만 울려서 "기타 소리"가 아니라 "줄 소리"였다.
    // 드레드노트의 헬름홀츠 공명이 대략 100Hz 다
    bodyAmount: 0.55,
    bodyHelmholtzHz: 100,
  },
  range: { low: 40, high: 88 }, // E2 ~ E6
  // 드레드노트: 헬름홀츠(100) · 앞판(200) · 뒷판(250) · 상위 두 개
  bodyModes: [
    { ratio: 1.00, gain: 1.00, q: 12 },
    { ratio: 2.00, gain: 0.80, q: 18 },
    { ratio: 2.50, gain: 0.55, q: 20 },
    { ratio: 3.80, gain: 0.30, q: 22 },
    { ratio: 5.50, gain: 0.18, q: 24 },
  ],
  sympatheticSemitones: [0, 5, 10, 15, 19, 24], // EADGBE
};

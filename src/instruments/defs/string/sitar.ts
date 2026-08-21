import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'sitar',
  schemaVersion: 1,
  name: '시타르',
  category: '줄',
  extends: 'acoustic-guitar',
  params: {
    // 시타르의 정체는 **공명현**이다. 뜯지 않은 줄이 같이 울린다
    scaleLengthMm: 800, stiffness: 0.020, damping: 0.05, sustainSec: 5.5,
    // 공명현 0.85 는 그 줄들의 음정이 섞여 측정 음정을 3.5센트 밀었다 (기준 ±1).
    // 시타르의 정체는 공명이지만, "음정이 정밀하다"는 제품 주장이 우선이다.
    // 0.22 에서도 1.24센트가 나와(여유 없음) 더 낮췄다
    sympatheticAmount: 0.12, sympatheticBaseHz: 138.6,
    pluckHardness: 0.7, pluckPosition: 0.08,
  },
  range: { low: 45, high: 84 },
};

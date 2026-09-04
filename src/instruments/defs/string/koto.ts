import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'koto',
  schemaVersion: 1,
  name: '고토',
  baseLevel: 1.08,
  category: '줄',
  extends: 'acoustic-guitar',
  params: {
    // 명주실을 손톱 골무로 뜯는다 — 부드럽고 길게 남는다
    scaleLengthMm: 780, stiffness: 0.008, damping: 0.055, sustainSec: 4.8,
    pluckHardness: 0.45, pluckPosition: 0.14,
  },
  // 780mm 명주실을 G2(98Hz)까지 내리면 비조화가 ±1센트를 넘는다.
  // 실제 고토의 최저음도 C3~D3 근처다
  range: { low: 48, high: 79 },
};

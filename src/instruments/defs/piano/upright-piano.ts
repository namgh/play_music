import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'upright-piano',
  schemaVersion: 1,
  name: '업라이트 피아노',
  baseLevel: 1.22,
  category: '피아노',
  extends: 'acoustic-piano',
  params: {
    // 줄이 짧고 판이 작다 — 그래서 배음이 더 밀리고 통이 위로 간다
    scaleLengthMm: 900,
    // 줄이 짧을수록 비조화도가 크지만, 위와 같은 이유로 상한이 있다
    stiffness: 0.016,
    sustainSec: 5.5,
    bodyHelmholtzHz: 95,
    stereoWidth: 0.2,
  },
};

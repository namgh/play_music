import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'supersaw-lead',
  schemaVersion: 1,
  name: '슈퍼소우 리드',
  baseLevel: 1.27,
  category: '건반·신스',
  extends: 'synth-base',
  params: {
    // 유니즌을 끝까지 벌린 톱니 — 두껍고 넓다
    synthWaveform: 0, synthUnison: 7, synthUnisonDetuneCents: 40,
    synthCutoffHz: 6000, synthFilterEnv: 0.3, sustainSec: 500,
  },
  range: { low: 48, high: 96 },
};

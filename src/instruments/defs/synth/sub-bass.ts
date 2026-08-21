import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'sub-bass',
  schemaVersion: 1,
  name: '서브 베이스',
  category: '베이스',
  extends: 'synth-base',
  params: {
    // 배음이 거의 없는 순수 저음 — 사인 + 서브만
    synthWaveform: 3, synthSubLevel: 1, synthCutoffHz: 300, synthFilterEnv: 0,
    synthDetuneCents: 0, sustainSec: 200,
  },
  range: { low: 21, high: 52 },
};

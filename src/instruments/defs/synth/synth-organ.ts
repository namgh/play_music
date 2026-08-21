import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'synth-organ',
  schemaVersion: 1,
  name: '신스 오르간',
  category: '건반·신스',
  extends: 'synth-base',
  params: {
    // 오르간은 배음이 정수배로 쌓인 것 — 사인에 서브를 더해 만든다
    synthWaveform: 3, synthSubLevel: 0.8, synthCutoffHz: 8000, synthFilterEnv: 0,
    sustainSec: 1200, synthDetuneCents: 0,
  },
  range: { low: 43, high: 96 },
};

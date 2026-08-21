import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'conga',
  schemaVersion: 1,
  name: '콩가',
  category: '드럼',
  extends: 'drum-base',
  params: {
    // 손바닥으로 치는 가죽 — 탐보다 짧고 음정이 덜 떨어진다
    drumKind: 4, drumDecaySec: 0.3, drumPitchDrop: 0.25, drumNoiseAmount: 0.2,
  },
  range: { low: 48, high: 67 },
};

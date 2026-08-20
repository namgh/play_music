import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'tom',
  schemaVersion: 1,
  name: '탐',
  extends: 'drum-base',
  params: {
    drumKind: 4, drumDecaySec: 0.5, drumPitchDrop: 0.4, drumNoiseAmount: 0.15,
    // 탐은 음정이 어느 정도 잡히므로 비조화도를 중간에 둔다
    drumModeCount: 4, drumInharmonicity: 0.5,
  },
  range: { low: 36, high: 72 },
};

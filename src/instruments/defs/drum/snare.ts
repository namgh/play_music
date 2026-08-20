import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'snare',
  schemaVersion: 1,
  name: '스네어',
  extends: 'drum-base',
  params: {
    drumKind: 1, drumDecaySec: 0.22, drumPitchDrop: 0.3, drumNoiseAmount: 0.7,
    // 스네어 막은 모드가 여럿이고 비조화도가 높다 — 그래서 음정이 안 잡힌다.
    // 줄(wires)이 막의 울림을 따라 달그락거리는 것이 스네어의 정체다
    drumModeCount: 4, drumInharmonicity: 0.75, drumSnareWires: 0.55,
  },
  range: { low: 36, high: 60 },
};

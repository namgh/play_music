import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'cowbell',
  schemaVersion: 1,
  name: '카우벨',
  baseLevel: 1.08,
  category: '드럼',
  extends: 'drum-base',
  params: {
    // 금속이라 감쇠가 거의 없고 음정이 안 떨어진다
    drumKind: 4, drumDecaySec: 0.25, drumPitchDrop: 0, drumNoiseAmount: 0.05,
    strikePosition: 0.15,
  },
  range: { low: 53, high: 79 },
};

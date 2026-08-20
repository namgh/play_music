import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'electric-piano-wurlitzer',
  schemaVersion: 1,
  name: '일렉 피아노 (윌리처)',
  category: '피아노',
  extends: 'electric-piano-rhodes',
  params: {
    // 윌리처는 리드(reed)라 더 짧고 거칠다
    modalDecaySec: 1.5,
    ampDrive: 0.32,
    ampToneMid: 0.6,
    strikePosition: 0.25,
  },
};

import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'tambourine',
  schemaVersion: 1,
  name: '탬버린',
  category: '드럼',
  extends: 'drum-base',
  params: {
    // 징글이 함께 울려 하이햇보다 길고 밝다
    drumKind: 3, drumDecaySec: 0.5, drumNoiseAmount: 1, strikePosition: 0.6,
  },
  range: { low: 60, high: 84 },
};

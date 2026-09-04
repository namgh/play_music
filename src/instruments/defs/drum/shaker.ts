import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'shaker',
  schemaVersion: 1,
  name: '셰이커',
  baseLevel: 1.41,
  category: '드럼',
  extends: 'drum-base',
  params: {
    // 알갱이가 부딪히는 소리 — 음정이 없고 노이즈만 아주 짧게
    drumKind: 2, drumDecaySec: 0.06, drumNoiseAmount: 1, strikePosition: 0.7,
  },
  range: { low: 58, high: 84 },
};

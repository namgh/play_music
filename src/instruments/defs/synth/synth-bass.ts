import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'synth-bass',
  schemaVersion: 1,
  name: '신스 베이스',
  category: '베이스',
  extends: 'synth-base',
  params: {
    synthWaveform: 1, synthCutoffHz: 900, synthDetuneCents: 0,
    stiffness: 200, damping: 0.4,
    // **베이스는 유니즌을 안 쓴다.** 저역에서 여러 보이스를 벌리면 위상이 서로
    // 상쇄돼 오히려 힘이 빠진다. 대신 서브로 받친다
    synthUnison: 1, synthSubLevel: 0.6,
  },
  range: { low: 24, high: 60 },
};

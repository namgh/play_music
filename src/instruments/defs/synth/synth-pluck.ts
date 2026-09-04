import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'synth-pluck',
  schemaVersion: 1,
  name: '신스 플럭',
  baseLevel: 0.57,
  category: '건반·신스',
  extends: 'synth-base',
  params: {
    // 짧게 끊어지는 소리 — 감쇠를 아주 짧게 두고 필터를 빨리 닫는다
    // 감쇠 0.9 · 지속 40 은 저음에서 한 주기(15ms)도 못 울렸다.
    // 플럭 성격은 필터 엔벨롭으로 내고 소리는 남긴다
    synthWaveform: 1, synthCutoffHz: 4200, synthFilterEnv: 0.85, damping: 0.72,
    sustainSec: 160, synthResonance: 0.35,
  },
  // 플럭은 저음에서 한 주기도 못 울린다 — 낼 수 있는 음역만 선언한다
  range: { low: 43, high: 96 },
};

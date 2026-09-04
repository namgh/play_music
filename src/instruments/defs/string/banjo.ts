import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'banjo',
  schemaVersion: 1,
  name: '밴조',
  baseLevel: 1.30,
  category: '기타',
  extends: 'acoustic-guitar',
  params: {
    // 짧고 팽팽한 줄에 얇은 막 — 밝고 빨리 죽는다
    // 강성 0.026 은 비조화를 키워 측정 음정을 1.08센트까지 밀었다 (기준 ±1).
    // 밝기는 damping·pluckHardness 로 내고 강성은 안전한 선까지만 쓴다
    scaleLengthMm: 673, stiffness: 0.016, damping: 0.125, sustainSec: 1.1,
    pluckHardness: 0.85, pluckPosition: 0.09, playNoiseAmount: 0.5,
  },
  // 673mm 줄을 G2(98Hz)까지 내리면 비조화가 커져 ±1센트를 넘는다.
  // 실제 5현 밴조의 최저음도 D3 근처다 — 물리와 기준이 같은 답을 가리킨다
  range: { low: 50, high: 86 },
};

import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'twelve-string-guitar',
  schemaVersion: 1,
  name: '12현 기타',
  category: '기타',
  extends: 'acoustic-guitar',
  params: {
    scaleLengthMm: 648, stiffness: 0.013, damping: 0.045, sustainSec: 4.5,
    // 12현의 정체는 겹줄이다 — 두 편광을 크게 벌려 그 어긋남을 낸다
    // 디튠 9센트는 측정 음정을 0.92센트까지 밀어 ±1 기준에 여유가 없었다.
    // 겹줄 느낌은 편광 비율로 내고 디튠은 안전한 선까지만 쓴다
    polarizationMix: 0.55, polarizationDetuneCents: 5, polarizationDecayRatio: 0.5,
    stereoWidth: 0.6,
  },
  range: { low: 40, high: 84 },
};

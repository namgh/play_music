import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'synth-pad',
  schemaVersion: 1,
  name: '신스 패드',
  baseLevel: 0.87,
  extends: 'synth-base',
  params: {
    synthWaveform: 2, scaleLengthMm: 300, sustainSec: 1200,
    synthCutoffHz: 1800, damping: 0.8, synthDetuneCents: 14,
    // 패드는 넓게 깔리는 것이 존재 이유다
    stereoWidth: 0.4,
    // **패드는 두께가 전부다.** 유니즌을 넓게 벌리고 필터를 천천히 흔든다.
    //
    // 폭을 32센트까지 벌려 봤더니 음정 회귀 테스트가 걸렸다 — 보이스가 대칭이라
    // 중심은 정확하지만 에너지가 퍼져 기본음 추정이 흔들린다. 더 두껍게 하고 싶으면
    // 튜닝 도구에서 올릴 수 있고, 그건 사용자의 선택이다
    synthUnison: 7, synthUnisonDetuneCents: 28,
    synthSubLevel: 0.35, synthNoiseLevel: 0.06,
    // LFO 는 컷오프만 흔든다 — 음정은 안 건드린다
    synthLfoHz: 0.35, synthLfoToCutoff: 0.5,
  },
  range: { low: 36, high: 96 },
};

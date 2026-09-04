import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'acoustic-piano',
  schemaVersion: 1,
  name: '어쿠스틱 피아노',
  baseLevel: 1.14,
  category: '피아노',
  extends: 'string-base',
  params: {
    // 피아노 줄은 굵고 팽팽해 **비조화도가 크다** — 배음이 정수배보다 위로 밀린다.
    // 이게 기타와 피아노를 가르는 가장 큰 차이다.
    //
    // 실제 피아노는 이보다 더 크지만, 강성을 더 올리면 **분산 보정이 따라가지 못해
    // 기본음이 밀린다** (0.032 에서 1.6센트, 클라비넷 0.024 에서 3.2센트 — ±1센트
    // 회귀 테스트가 잡았다). 더 밀어붙이려면 분산 단의 위상 보정을 고차로 푸는
    // 엔진 작업이 필요하고, 그건 `sound.md` 가 Tier 2 "큰 공수"라 한 부분이다
    stiffness: 0.019,
    scaleLengthMm: 1200,
    damping: 0.03,
    sustainSec: 8,
    // 해머는 뜯는 게 아니라 때린다 — 단단하고, 줄 길이의 1/8 지점을 친다
    pluckHardness: 0.72,
    pluckPosition: 0.12,
    // 사운드보드. 통이 아니라 큰 판이라 공진이 낮다.
    // 60Hz 로 두면 최저음(A0 27.5Hz)의 2배음과 겹쳐 기본음 측정이 밀린다 —
    // 실측 1.6센트. 판의 첫 모드를 조금 위로 잡아 피한다
    bodyAmount: 0.3,
    bodyHelmholtzHz: 110,
    // 댐퍼를 뗀 현들이 함께 우는 것은 피아노 울림의 큰 부분이지만, **기본값은 0 이다** —
    // 공명현은 다른 음정을 더해서 노트오프 계약과 ±1센트 회귀 테스트를 깬다
    // (다른 악기에서 이미 같은 이유로 0 이다). 얼마나 울릴지는 S4 에서 귀로 정한다
    sympatheticAmount: 0,
    sympatheticBaseHz: 55,
    polarizationMix: 0.3,
    polarizationDetuneCents: 1.0,
    polarizationDecayRatio: 0.25,
    velocityBrightness: 0.5, // 세게 치면 확 밝아지는 것이 피아노의 성격이다
    playNoiseAmount: 0.2,    // 해머 소리
    variationAmount: 0.35,
    stereoWidth: 0.35,       // 낮은 음이 왼쪽, 높은 음이 오른쪽
    legatoMs: 0,             // 건반은 잇지 않는다 — 각 음이 따로 때려진다
    releaseMs: 90,
  },
  range: { low: 21, high: 108 }, // A0 ~ C8
  // 사운드보드는 크고 넓은 판이라 모드가 낮고 완만하다
  bodyModes: [
    { ratio: 1.00, gain: 1.00, q: 8 },
    { ratio: 1.60, gain: 0.75, q: 10 },
    { ratio: 2.40, gain: 0.50, q: 12 },
    { ratio: 3.60, gain: 0.28, q: 14 },
    { ratio: 5.20, gain: 0.15, q: 16 },
  ],
  // 댐퍼를 뗀 현들 — 옥타브·5도가 가장 강하게 걸린다
  sympatheticSemitones: [0, 7, 12, 19, 24, 28, 31, 36],
  tones: {
    default: {},
    밝은: { pluckHardness: 0.9, bodyAmount: 0.4, damping: 0.02 },
    부드러운: { pluckHardness: 0.5, pluckPosition: 0.18, damping: 0.05 },
  },
};

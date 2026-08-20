import type { InstrumentDefinition } from '../../types.ts';
import { COMMON_SPECS, STRING_EXPRESSION_SPECS } from '../../specs.ts';

/**
 * 웨이브가이드 줄의 기준 정의. 파생 악기들은 여기서 숫자만 덮어쓴다.
 * 파라미터 의미는 `spike/m0-karplus/ks-string.js` 와 같다.
 */
export const definition: InstrumentDefinition = {
  id: 'string-base',
  schemaVersion: 1,
  name: '줄 (기준)',
  category: '줄',
  voice: 'waveguide-string',
  range: { low: 28, high: 96 },
  paramSpecs: {
    scaleLengthMm: {
      type: 'float', min: 300, max: 900, default: 648,
      unit: 'mm', label: '줄 길이', curve: 'linear', group: '진동체',
    },
    stiffness: {
      type: 'float', min: 0, max: 0.05, default: 0.012,
      label: '강성(분산)', curve: 'linear', group: '진동체',
    },
    damping: {
      type: 'float', min: 0, max: 0.25, default: 0.05,
      label: '고역 감쇠', curve: 'linear', group: '진동체',
    },
    sustainSec: {
      type: 'float', min: 0.3, max: 10, default: 3,
      unit: 's', label: '서스테인', curve: 'log', group: '진동체',
    },
    pluckPosition: {
      type: 'float', min: 0.02, max: 0.5, default: 0.18,
      label: '뜯는 위치', curve: 'linear', group: '연주',
    },
    pluckHardness: {
      type: 'float', min: 0, max: 1, default: 0.4,
      label: '뜯는 세기', curve: 'linear', group: '연주',
    },
    // --- 앰프 체인 (sound.md 5절) ---
    // **줄과 분리된 층이다.** "줄 길이"와 "왜곡"은 서로 다른 곳에 있다.
    // 어쿠스틱 악기는 ampEnabled 를 0 으로 두고 나머지를 무시한다
    ampEnabled: {
      type: 'int', min: 0, max: 1, default: 0,
      label: '앰프', group: '앰프',
    },
    ...STRING_EXPRESSION_SPECS,
    ...COMMON_SPECS,
  },
  params: {
    scaleLengthMm: 648,
    stiffness: 0.012,
    damping: 0.05,
    sustainSec: 3,
    pluckPosition: 0.18,
    pluckHardness: 0.4,
    // 앰프는 기본적으로 꺼져 있다 — 어쿠스틱 악기가 다수다
    ampEnabled: 0,
    // 손을 떼면 줄이 죽는다. 아르페지오처럼 일부러 울리려면 letRing 을 켠다
    releaseMs: 120,
    letRing: 0,
    // 세게 뜯으면 밝아진다 — 줄 악기에서 가장 뚜렷하게 들리는 성질이다
    velocityBrightness: 0.35,
    // **2편광을 기본으로 켠다** (`ROADMAP.md` S2-1). 실제 줄은 두 방향으로 진동하고
    // 두 주파수가 미세하게 다르다. 편광이 하나면 지수 감쇠뿐이라 소리가
    // "삐- 하고 사라지고", 그게 "합성음 같다"는 인상의 1순위 원인이다
    polarizationMix: 0.55,
    polarizationDetuneCents: 1.8,
    polarizationDecayRatio: 0.3,
    // 픽·손톱이 줄을 긁는 소리
    playNoiseAmount: 0.35,
    // 이어 치면 손가락만 옮긴다 (해머온·풀오프). 실측 60~110ms
    legatoMs: 80,
    // 공명현은 **구조만 넣고 기본값은 0 이다** (`ROADMAP.md` S2-5).
    //
    // 켜면 노트오프 뒤에도 울림이 남는다 — 실제 악기가 그렇고 물리적으로 맞지만,
    // 지금 노트오프 계약은 "꼬리가 조용하다"를 요구하고 음정 회귀 테스트는 단일
    // 기본음을 잰다. 둘 다 공명현이 더한 다른 음정과 부딪힌다.
    // 얼마나 울릴지는 **귀로 정할 값**이라 S4 로 넘긴다 (로드맵 원칙 2).
    sympatheticAmount: 0,
    sympatheticBaseHz: 82.41,
    // 좌우 퍼짐은 악기마다 다르므로 기준에서는 끈다.
    // **선언만 하고 값을 안 두면 해석된 파라미터에서 아예 빠진다** — 그러면
    // 튜닝 화면에 나오지 않고 "이 악기엔 없는 값"처럼 보인다
    stereoWidth: 0,
    pickupHumbucker: 0,
    // 실제로 같은 줄을 같은 세기로 두 번 뜯어도 같은 소리가 안 난다
    variationAmount: 0.5,
  },
  tones: {
    default: {},
    밝은: { pluckHardness: 0.8, pluckPosition: 0.1, damping: 0.03 },
    따뜻한: { pluckHardness: 0.2, pluckPosition: 0.3, damping: 0.08 },
  },
};

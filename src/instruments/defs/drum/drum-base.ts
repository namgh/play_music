import type { InstrumentDefinition } from '../../types.ts';
import { COMMON_SPECS } from '../../specs.ts';

export const definition: InstrumentDefinition = {
  id: 'drum-base',
  schemaVersion: 1,
  name: '드럼 (기준)',
  category: '드럼',
  voice: 'percussion',
  range: { low: 24, high: 84 },
  paramSpecs: {
    drumKind: {
      type: 'enum', min: 0, max: 5, default: 0,
      label: '종류', group: '드럼',
      options: ['킥', '스네어', '하이햇(닫힘)', '하이햇(열림)', '탐', '클랩'],
    },
    drumDecaySec: {
      // 엔진(`percussion.rs`)은 4초까지 받는다. 화면 상한을 2로 좁혀 뒀던 것은
      // "북 종류"만 염두에 둔 값이라, 크래시 심벌처럼 2초 넘게 우는 금속판에는
      // 안 맞았다 — 실효 범위(4)까지 열었다
      type: 'float', min: 0.02, max: 4, default: 0.35,
      unit: 's', label: '길이', curve: 'log', group: '드럼',
    },
    drumPitchDrop: {
      type: 'float', min: 0, max: 2, default: 0.7,
      label: '음정 스윕', group: '드럼',
    },
    drumNoiseAmount: {
      type: 'float', min: 0, max: 1, default: 0,
      label: '노이즈', group: '드럼',
    },
    strikePosition: {
      type: 'float', min: 0, max: 1, default: 0.5,
      label: '밝기', group: '드럼',
    },
    drumModeCount: {
      // 실제 북은 여러 모드가 겹쳐 울리고 각자 다른 속도로 죽는다.
      // 1 이면 사인 하나 — 808 계열 킥은 그게 맞다
      type: 'int', min: 1, max: 6, default: 1,
      label: '막 모드 수', group: '드럼',
    },
    drumInharmonicity: {
      // 0 이면 배음이 정수배(음정이 뚜렷), 1 이면 이상적인 원형 막("퉁")
      type: 'float', min: 0, max: 1, default: 0,
      label: '막 비조화도', curve: 'linear', group: '드럼',
    },
    drumSnareWires: {
      type: 'float', min: 0, max: 1, default: 0,
      label: '스네어 줄', curve: 'linear', group: '드럼',
    },
    ampEnabled: { type: 'int', min: 0, max: 1, default: 0, label: '앰프', group: '앰프' },
    ...COMMON_SPECS,
  },
  params: {
    drumKind: 0,
    drumDecaySec: 0.35,
    drumPitchDrop: 0.7,
    drumNoiseAmount: 0,
    strikePosition: 0.5,
    ampEnabled: 0,
    // 세게 치면 밝아진다. 드럼에서 특히 크게 들리는 성질이다
    velocityBrightness: 0.4,
    // **드럼에서 가장 크게 들린다** — 없으면 하이햇 16분이 머신건이 된다
    variationAmount: 0.7,
    // **좌우 퍼짐은 켜지 않는다.** 지금 배치는 음 높이로 정해지는데, 그러면
    // 킥이 왼쪽으로 가 버린다. 드럼은 킥·스네어가 가운데인 것이 기준이다.
    // 악기별 팬 오프셋이 생기면 그때 하이햇·탐만 편다
    stereoWidth: 0,
    // 원샷이다. 킥을 짧게 눌렀다고 짧아지면 안 된다 — 길이는 `drumDecaySec` 이 정한다.
    // Rust 쪽도 타악기의 노트오프를 무시하지만(`voice.rs`), 여기서 명시해 두면
    // 애초에 노트오프를 보내지 않아 헛일이 줄고 의도가 드러난다
    letRing: 1,
  },
  tones: { default: {}, 짧게: { drumDecaySec: 0.12 }, 길게: { drumDecaySec: 1.0 } },
};

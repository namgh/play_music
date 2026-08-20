/**
 * 악기들이 공유하는 파라미터 메타데이터.
 *
 * 악기 파일 하나하나가 이걸 다시 적으면 새 파라미터가 생길 때 1000곳을 고쳐야 한다.
 * **여기 한 곳만 고치면 상속으로 전부 따라온다** (`sound.md` 9-3).
 */

import type { ParamSpec } from './types.ts';

/**
 * 노트오프 관련 파라미터. **보이스 타입과 무관하게 모든 악기가 갖는다.**
 *
 * wasm 파라미터 슬롯이 아니라 워크렛 메시지로 간다 (`WORKPLAN.md` 2-2) — 발음마다
 * 바뀌는 값이 아니라 노트오프 시점에만 필요해서다.
 *
 * `letRing` 이 진짜 선택지인 이유: 실제 기타는 손을 떼면 줄이 죽지만 아르페지오는
 * 일부러 울린다. 기타 VST 가 전부 "Let Ring" 이라는 이름으로 갖고 있는 기능이다.
 */
export const NOTE_OFF_SPECS: Record<string, ParamSpec> = {
  releaseMs: {
    // 하한 5ms — 0 이면 파형이 뚝 끊겨 그게 클릭이다.
    // 기본 120ms 는 손으로 줄을 짚어 죽이는 데 실제로 걸리는 시간이다
    type: 'float', min: 5, max: 2000, default: 120,
    unit: 'ms', label: '뮤트 속도', curve: 'log', group: '연주',
  },
  letRing: {
    type: 'int', min: 0, max: 1, default: 0,
    label: '울림 유지', group: '연주',
  },
};

/**
 * 연주 표현 파라미터 (`ROADMAP.md` S1). **보이스 타입과 무관하게 모든 악기가 갖는다.**
 *
 * 셋 다 **기본값이 0이고, 0이면 예전과 완전히 같은 소리**다. 악기가 명시적으로 켜야
 * 효과가 생긴다 — 그래야 이미 맞춰 둔 악기들이 이 변경으로 흔들리지 않는다.
 */
export const EXPRESSION_SPECS: Record<string, ParamSpec> = {
  stereoWidth: {
    // 음 높이로 좌우에 편다. 실제로 마이크로 잡은 피아노·말렛·하프가 그렇게 들린다.
    // 앰프를 통과하는 일렉기타는 실제로 모노라 0 으로 둔다
    type: 'float', min: 0, max: 1, default: 0,
    label: '좌우 퍼짐', curve: 'linear', group: '연주',
  },
  velocityBrightness: {
    // 세게 치면 밝아진다. 없으면 벨로시티가 볼륨 오토메이션으로만 들린다
    type: 'float', min: 0, max: 1, default: 0,
    label: '세기→밝기', curve: 'linear', group: '연주',
  },
  variationAmount: {
    // 같은 음을 반복하면 완전히 똑같은 파형이 나와 하이햇 16분이 머신건이 된다.
    // **음정은 흔들지 않는다** — 세기·밝기·감쇠만 (`ROADMAP.md` S2-4)
    type: 'float', min: 0, max: 1, default: 0,
    label: '타건 변주', curve: 'linear', group: '연주',
  },
  pickupHumbucker: {
    // 코일 두 개가 직렬이라 공진이 아래로 내려간다 = 더 두껍고 어둡다.
    // 앰프를 쓰는 악기에만 의미가 있다
    type: 'int', min: 0, max: 1, default: 0,
    label: '험버커 픽업', group: '앰프',
  },
};

/**
 * 줄 악기의 표현력 파라미터 (`ROADMAP.md` S2). 줄에만 의미가 있어 공통에 넣지 않는다.
 */
export const STRING_EXPRESSION_SPECS: Record<string, ParamSpec> = {
  inharmonicity: {
    // **줄 길이와 무관하게** 비조화도를 직접 준다. `stiffness` 는 `L⁻⁴` 로 길이에
    // 묶여 있어 피아노처럼 긴 줄에 굵은 강선을 쓰는 악기에 안 맞는다.
    //
    // 지금은 **안전 범위에서만 동작한다** — 1차 올패스로는 저역 배음을 못 밀고,
    // 계수를 더 올리면 루프가 무너진다 (`string_voice.rs` 의 실측 기록).
    // 피아노급 비조화도는 설계된 분산 필터가 필요하다
    type: 'float', min: 0, max: 1, default: 0,
    label: '비조화도', curve: 'linear', group: '진동체',
  },
  polarizationMix: {
    // 실제 줄은 두 방향으로 진동한다. 0 이면 편광이 하나뿐이라 지수 감쇠만 남고,
    // 그게 "합성음 같다"는 인상의 1순위 원인이다
    type: 'float', min: 0, max: 1, default: 0,
    label: '2편광 섞기', curve: 'linear', group: '진동체',
  },
  polarizationDetuneCents: {
    // 두 편광의 주파수 차이. **키우면 음정 정확도를 먹는다** — 기본값 주석 참고
    type: 'float', min: 0, max: 20, default: 0.3,
    unit: '¢', label: '편광 디튠', curve: 'linear', group: '진동체',
  },
  bodyAmount: {
    // 어쿠스틱 몸통. 0 이면 줄 소리만 난다 — 지금까지가 그 상태였다.
    // IR 이 확보되면 이 층을 컨볼루션으로 교체한다 (`ROADMAP.md` S3)
    type: 'float', min: 0, max: 1, default: 0,
    label: '몸통 울림', curve: 'linear', group: '진동체',
  },
  bodyHelmholtzHz: {
    // 통 안 공기의 공명. **이 값 하나가 몸통 크기다** — 작을수록 높다
    type: 'float', min: 40, max: 600, default: 100,
    unit: 'Hz', label: '몸통 크기', curve: 'log', group: '진동체',
  },
  sympatheticAmount: {
    // 누르지 않은 줄이 같이 운다. "몸통이 있는 악기"라는 인상의 큰 부분이다
    type: 'float', min: 0, max: 1, default: 0,
    label: '공명현', curve: 'linear', group: '진동체',
  },
  sympatheticBaseHz: {
    // 가장 낮은 공명현의 음정. 기본값은 기타 6번줄 E2
    type: 'float', min: 20, max: 500, default: 82.41,
    unit: 'Hz', label: '공명현 기준음', curve: 'log', group: '진동체',
  },
  legatoMs: {
    // 이어 친 음이 앞 음정에서 미끄러져 들어오는 시간. 0 이면 안 잇는다.
    // **wasm 파라미터가 아니다** — 스케줄러가 앞 음을 알아야 계산할 수 있고,
    // 그건 엔진이 볼 수 없는 정보다 (`ROADMAP.md` S2-3)
    type: 'float', min: 0, max: 300, default: 0,
    unit: 'ms', label: '레가토', curve: 'linear', group: '연주',
  },
  playNoiseAmount: {
    // 픽이 줄을 긁는 소리. 지금까지 0 이었고 "진짜 같음"의 지분이 크다
    type: 'float', min: 0, max: 1, default: 0,
    label: '연주 노이즈', curve: 'linear', group: '연주',
  },
  polarizationDecayRatio: {
    // 세로 편광은 브리지에 더 잘 붙어 먼저 죽는다 → "빠른 초기 감쇠 + 느린 꼬리"
    type: 'float', min: 0.05, max: 1, default: 0.25,
    label: '편광 감쇠비', curve: 'linear', group: '진동체',
  },
};

/**
 * **보이싱 세부** (`ROADMAP.md` S4 준비).
 *
 * 예전에는 전부 Rust `const` 였다 — 밖에서 손댈 수 없으니 **튜닝 도구에 노출할 것이
 * 없었고**, "귀로 맞춘다"는 계획 자체가 성립하지 않았다.
 * `sound.md` 9-1("악기는 데이터, 엔진은 코드")·9-5(파라미터 메타데이터로 UI 자동 생성)를
 * 어긴 것이기도 하다.
 *
 * **전부 기본값 0 이고, 0 이면 엔진 기본값으로 떨어진다.** 그래서 값을 안 준 악기와
 * 옛 프로젝트는 예전과 완전히 같은 소리가 난다.
 */
export const VOICING_SPECS: Record<string, ParamSpec> = {
  velocityReference: {
    type: 'float', min: 0, max: 1, default: 0,
    label: '세기 기준점', curve: 'linear', group: '보이싱',
  },
  panCenterHz: {
    type: 'float', min: 0, max: 2000, default: 0,
    unit: 'Hz', label: '좌우 기준음', curve: 'log', group: '보이싱',
  },
  panOctaveSpan: {
    type: 'float', min: 0, max: 8, default: 0,
    label: '좌우 폭(옥타브)', curve: 'linear', group: '보이싱',
  },
  variationGainDepth: {
    type: 'float', min: 0, max: 0.5, default: 0,
    label: '변주 세기폭', curve: 'linear', group: '보이싱',
  },
  variationBrightDepth: {
    type: 'float', min: 0, max: 0.5, default: 0,
    label: '변주 밝기폭', curve: 'linear', group: '보이싱',
  },
  variationDecayDepth: {
    type: 'float', min: 0, max: 0.5, default: 0,
    label: '변주 감쇠폭', curve: 'linear', group: '보이싱',
  },
  detuneRefHz: {
    type: 'float', min: 0, max: 2000, default: 0,
    unit: 'Hz', label: '편광 디튠 기준음', curve: 'log', group: '보이싱',
  },
  detuneMinScale: {
    type: 'float', min: 0, max: 1, default: 0,
    label: '편광 디튠 하한', curve: 'linear', group: '보이싱',
  },
  playNoiseMs: {
    type: 'float', min: 0, max: 60, default: 0,
    unit: 'ms', label: '연주 노이즈 길이', curve: 'log', group: '보이싱',
  },
  playNoiseLevel: {
    type: 'float', min: 0, max: 1, default: 0,
    label: '연주 노이즈 크기', curve: 'linear', group: '보이싱',
  },
  stealFadeMs: {
    type: 'float', min: 0, max: 50, default: 0,
    unit: 'ms', label: '보이스 훔치기 페이드', curve: 'log', group: '보이싱',
  },
  pickupCoilHz: {
    // 0 이면 험버커 여부에서 유도한다 (예전 동작)
    type: 'float', min: 0, max: 12000, default: 0,
    unit: 'Hz', label: '픽업 코일 공진', curve: 'log', group: '앰프',
  },
  sympatheticT60Sec: {
    type: 'float', min: 0, max: 12, default: 0,
    unit: 's', label: '공명현 길이', curve: 'log', group: '진동체',
  },
  sympatheticDamping: {
    type: 'float', min: 0, max: 0.95, default: 0,
    label: '공명현 고역감쇠', curve: 'linear', group: '진동체',
  },
  bodyMix: {
    type: 'float', min: 0, max: 4, default: 0,
    label: '몸통 섞는 배율', curve: 'linear', group: '진동체',
  },
};

/** 모든 악기가 공통으로 갖는 파라미터 */
export const COMMON_SPECS: Record<string, ParamSpec> = {
  ...NOTE_OFF_SPECS, ...EXPRESSION_SPECS, ...VOICING_SPECS,
};

/**
 * 앰프를 쓰는 악기의 기준 정의. 일렉 기타·베이스가 여기서 상속받는다.
 *
 * 파라미터가 줄 정의와 **섞이지 않는다** — 상속으로 층을 얹는 구조라
 * 어쿠스틱 악기는 이 정의를 거치지 않는다.
 */
/**
 * 앰프 체인 선언. **줄 계열 전용이 아니다** — 로즈처럼 픽업으로 받아 앰프를 거치는
 * 건반도 쓴다. `AMPED_STRING` 안에 두면 그 상속 줄기 밖에서는 못 쓴다
 * (실제로 로즈를 넣다가 걸렸다).
 */
export const AMP_SPECS: Record<string, ParamSpec> = {
    ampCharacter: {
      type: 'enum', default: 1, min: 0, max: 3,
      label: '앰프 성격', group: '앰프',
      options: ['클린', '크런치', '디스토션', '퍼즈'],
    },
    ampDrive: {
      type: 'float', min: 0, max: 1, default: 0.35,
      label: '드라이브', group: '앰프',
    },
    ampToneLow: { type: 'float', min: 0, max: 1, default: 0.5, label: '저역', group: '앰프' },
    ampToneMid: { type: 'float', min: 0, max: 1, default: 0.5, label: '중역', group: '앰프' },
    ampToneHigh: { type: 'float', min: 0, max: 1, default: 0.55, label: '고역', group: '앰프' },
    ampLevel: { type: 'float', min: 0, max: 1, default: 0.7, label: '앰프 볼륨', group: '앰프' },
    ampCabinet: { type: 'int', min: 0, max: 1, default: 1, label: '캐비닛', group: '앰프' },
    pickupPosition: {
      type: 'float', min: 0, max: 1, default: 0.15,
      label: '픽업 위치', group: '앰프',
    },
};

import type { InstrumentDefinition } from '../../types.ts';
import { COMMON_SPECS } from '../../specs.ts';

export const definition: InstrumentDefinition = {
  id: 'synth-base',
  schemaVersion: 1,
  name: '신스 (기준)',
  category: '건반·신스',
  voice: 'virtual-analog',
  range: { low: 24, high: 108 },
  paramSpecs: {
    // **앰프를 켜려면 앰프 파라미터가 선언돼 있어야 한다.**
    // `ampEnabled` 만 있고 `ampLevel` 이 없으면 앰프를 켰을 때 레벨이 0 으로 들어가
    // **완전 무음**이 된다. 출시된 신스가 전부 앰프를 꺼 두고 있어서 아무도 몰랐다.
    //
    // ⚠ `...AMP_SPECS` 를 통째로 펼치면 안 된다. 그 묶음에는 앰프뿐 아니라 **줄 전용
    // 파라미터**(비조화·편광·바디·공명현)가 들어 있어서, 신스에 그 기본값이 실리면
    // 공유 슬롯을 통해 음정이 -30센트까지 밀린다 — 실제로 그렇게 기존 `synth-lead`
    // 가 깨졌다. 필요한 것만 적는다
    ampCharacter: {
      type: 'enum', min: 0, max: 3, default: 1,
      label: '앰프 성격', group: '앰프', options: ['클린', '크런치', '디스토션', '퍼즈'],
    },
    ampToneLow: { type: 'float', min: 0, max: 1, default: 0.5, label: '저역', group: '앰프' },
    ampToneMid: { type: 'float', min: 0, max: 1, default: 0.5, label: '중역', group: '앰프' },
    ampToneHigh: { type: 'float', min: 0, max: 1, default: 0.55, label: '고역', group: '앰프' },
    ampLevel: { type: 'float', min: 0, max: 1, default: 0.7, label: '앰프 볼륨', group: '앰프' },
    ampCabinet: { type: 'int', min: 0, max: 1, default: 1, label: '캐비닛', group: '앰프' },
    synthWaveform: {
      type: 'enum', min: 0, max: 3, default: 0,
      label: '파형', group: '오실레이터',
      options: ['톱니', '사각', '삼각', '사인'],
    },
    synthDetuneCents: {
      type: 'float', min: 0, max: 30, default: 8,
      unit: '¢', label: '디튠', group: '오실레이터',
    },
    synthCutoffHz: {
      type: 'float', min: 100, max: 16000, default: 3000,
      unit: 'Hz', label: '컷오프', curve: 'log', group: '필터',
    },
    synthResonance: {
      type: 'float', min: 0, max: 1, default: 0.2,
      label: '레조넌스', group: '필터',
    },
    synthFilterEnv: {
      type: 'float', min: 0, max: 1, default: 0.5,
      label: '필터 엔벌로프', group: '필터',
    },
    // wasm 에서 줄 슬롯 0~3 을 재사용한다 (신스에는 줄 파라미터가 의미 없다)
    scaleLengthMm: {
      type: 'float', min: 0.5, max: 500, default: 5,
      unit: 'ms', label: '어택', curve: 'log', group: '엔벌로프',
    },
    stiffness: {
      type: 'float', min: 1, max: 2000, default: 300,
      unit: 'ms', label: '디케이', curve: 'log', group: '엔벌로프',
    },
    damping: {
      type: 'float', min: 0, max: 1, default: 0.6,
      label: '서스테인', group: '엔벌로프',
    },
    sustainSec: {
      type: 'float', min: 5, max: 2000, default: 250,
      unit: 'ms', label: '릴리즈', curve: 'log', group: '엔벌로프',
    },
    ampEnabled: { type: 'int', min: 0, max: 1, default: 0, label: '앰프', group: '앰프' },
    ampDrive: { type: 'float', min: 0, max: 1, default: 0, label: '드라이브', group: '앰프' },
    // --- 두께와 움직임 (`ROADMAP.md` 신스 확장) ---
    // 에일리어싱은 잡혀 있었지만 **얇았다.** 신스가 두껍게 들리는 이유는 파형이
    // 아니라 유니즌·서브·노이즈·LFO 다
    synthUnison: {
      type: 'int', min: 1, max: 7, default: 1,
      label: '유니즌', group: '오실레이터',
    },
    synthUnisonDetuneCents: {
      type: 'float', min: 0, max: 60, default: 0,
      unit: '¢', label: '유니즌 폭', curve: 'linear', group: '오실레이터',
    },
    synthSubLevel: {
      type: 'float', min: 0, max: 1, default: 0,
      label: '서브(-1옥타브)', curve: 'linear', group: '오실레이터',
    },
    synthNoiseLevel: {
      type: 'float', min: 0, max: 1, default: 0,
      label: '노이즈', curve: 'linear', group: '오실레이터',
    },
    synthLfoHz: {
      type: 'float', min: 0, max: 20, default: 0,
      unit: 'Hz', label: 'LFO 속도', curve: 'log', group: '모듈레이션',
    },
    synthLfoToPitchCents: {
      type: 'float', min: 0, max: 200, default: 0,
      unit: '¢', label: 'LFO→음정', curve: 'linear', group: '모듈레이션',
    },
    synthLfoToCutoff: {
      type: 'float', min: 0, max: 1, default: 0,
      label: 'LFO→컷오프', curve: 'linear', group: '모듈레이션',
    },
    ...COMMON_SPECS,
  },
  params: {
    synthWaveform: 0,
    synthDetuneCents: 8,
    synthCutoffHz: 3000,
    synthResonance: 0.2,
    synthFilterEnv: 0.5,
    scaleLengthMm: 5,
    stiffness: 300,
    damping: 0.6,
    sustainSec: 250,
    ampEnabled: 0,
    // ⚠ **앰프 기본값을 여기 넣지 않는다.** 신스는 줄 모델과 파라미터 슬롯을
    // 일부 공유해서, 앰프 값을 기본으로 실으면 앰프를 꺼도 음정이 -30센트 밀린다
    // (실제로 그렇게 `synth-lead` 가 깨졌다). 앰프를 쓰는 악기가 직접 적는다
    ampDrive: 0,
    // 신스는 **반드시** 노트오프를 받아야 한다. 안 받으면 ADSR 이 Sustain 단계에서
    // 멈춰 영원히 울린다 (거기서 나올 길이 노트오프뿐이다).
    // 뮤트는 자기 릴리즈(`sustainSec` 슬롯)가 하므로 `releaseMs` 는 쓰이지 않는다
    letRing: 0,
    // 신스의 밝기는 필터 컷오프다. 벨로시티→컷오프는 아날로그 신스의 기본 배선이다
    velocityBrightness: 0.3,
    // 신스는 원래 기계적인 것이 특징이라 약하게만
    variationAmount: 0.15,
    // 기준 신스는 유니즌 3 — 하나면 얇고, 많으면 리드가 뭉개진다
    synthUnison: 3,
    synthUnisonDetuneCents: 12,
    synthSubLevel: 0.25,
  },
  tones: {
    default: {},
    리드: { synthWaveform: 0, synthCutoffHz: 5000, synthResonance: 0.35, damping: 0.5 },
    패드: { synthWaveform: 2, scaleLengthMm: 300, sustainSec: 1200, synthCutoffHz: 1800, damping: 0.8 },
    베이스: { synthWaveform: 1, synthCutoffHz: 900, synthDetuneCents: 0, stiffness: 200, damping: 0.4 },
  },
};

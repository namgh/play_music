import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'synth-lead',
  schemaVersion: 1,
  name: '신스 리드',
  extends: 'synth-base',
  params: {
    synthCutoffHz: 5000, synthResonance: 0.35,
    // 리드는 또렷해야 하므로 유니즌을 얕게 준다.
    //
    // **비브라토는 기본으로 걸지 않는다.** 그건 음색이 아니라 연주 선택이고,
    // 악기에 박아 두면 사용자가 0.0센트로 맞춘 음을 엔진이 계속 흔들게 된다 —
    // "음정이 정밀하다"는 주장과 정면으로 부딪힌다.
    // 음마다 거는 비브라토는 이미 `pitchCurve` 가 담당한다
    synthUnison: 3, synthUnisonDetuneCents: 8,
  },
  range: { low: 48, high: 108 },
};

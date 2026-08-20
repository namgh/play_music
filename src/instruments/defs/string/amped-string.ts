import type { InstrumentDefinition } from '../../types.ts';
import { AMP_SPECS } from '../../specs.ts';

export const definition: InstrumentDefinition = {
  id: 'amped-string',
  schemaVersion: 1,
  name: '앰프 줄 (기준)',
  extends: 'string-base',
  paramSpecs: { ...AMP_SPECS },
  params: {
    ampEnabled: 1,
    // **자석 픽업은 한 방향 움직임에 주로 반응한다.** 폴피스에 수직인 편광이
    // 크게 잡히고 나머지는 약하게 들어온다 — 어쿠스틱처럼 두 편광이 공기로 함께
    // 나오는 것과 다르다. 왜곡을 거치면 두 편광이 상호변조로 기본음을 당기기도 해서
    // (실측 2.1센트) 물리와 정확도가 같은 방향을 가리킨다
    polarizationMix: 0.25,
    ampCharacter: 1,
    ampDrive: 0.35,
    ampToneLow: 0.5,
    ampToneMid: 0.5,
    ampToneHigh: 0.55,
    ampLevel: 0.7,
    ampCabinet: 1,
    pickupPosition: 0.15,
  },
  tones: {
    클린: { ampCharacter: 0, ampDrive: 0.15, ampToneHigh: 0.6 },
    크런치: { ampCharacter: 1, ampDrive: 0.45 },
    디스토션: { ampCharacter: 2, ampDrive: 0.75, ampToneMid: 0.35 },
    퍼즈: { ampCharacter: 3, ampDrive: 0.9, ampToneLow: 0.6 },
  },
};

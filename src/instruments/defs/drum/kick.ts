import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'kick',
  schemaVersion: 1,
  name: '킥',
  extends: 'drum-base',
  // **킥은 모드 하나가 맞다.** 808 계열 전자 킥은 원래 사인 + 음정 스윕이고,
  // 그건 흉내가 아니라 그 악기의 정의다 (`percussion.rs` 머리말)
  params: { drumKind: 0, drumDecaySec: 0.4, drumPitchDrop: 0.8, drumModeCount: 1 },
  range: { low: 24, high: 48 },
};

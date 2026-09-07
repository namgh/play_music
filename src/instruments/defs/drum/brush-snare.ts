import type { InstrumentDefinition } from '../../types.ts';

/**
 * 브러시 스네어 — 지금까지 `rimshot` 으로 대신하던 것
 * (`SONGCRAFT.md` 첫 다섯 곡, "브러시 스네어 → rimshot 대용, 재즈").
 *
 * 스틱 스네어(`snare.ts`)와 같은 `DrumKind::Snare` 다. 갈리는 지점은 세 가지:
 * **더 노이즈 위주**(drumNoiseAmount 상한까지 — 스틱의 "딱" 하는 크랙이 아니라
 * "쏴아" 하는 스침), **더 어둡다**(strikePosition 을 낮춰 브러시 특유의 부드러움),
 * **더 길게 스민다**(decaySec 를 늘리고 snareWires 를 낮춰 달그락거림을 줄인다).
 */
export const definition: InstrumentDefinition = {
  id: 'brush-snare',
  schemaVersion: 1,
  name: '브러시 스네어',
  baseLevel: 1.41,
  extends: 'drum-base',
  params: {
    drumKind: 1, drumDecaySec: 0.5, drumPitchDrop: 0.1, drumNoiseAmount: 1,
    drumModeCount: 3, drumInharmonicity: 0.5, drumSnareWires: 0.2,
    strikePosition: 0.25,
  },
  range: { low: 36, high: 60 },
};

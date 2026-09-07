import type { InstrumentDefinition } from '../../types.ts';

/**
 * 크래시 심벌 — 지금까지 `hihat-open` 으로 대신하던 것 (`SONGCRAFT.md` 2번,
 * `ROADMAP.md` 다음 순서 3번).
 *
 * **새 DrumKind 를 늘리지 않았다.** 물리적으로 크래시도 하이햇(열림)과 같은
 * 종류다 — 비조화 배음이 조밀한 금속판(`percussion.rs` 의 `METAL_RATIOS`).
 * 갈리는 지점은 하나, **길이**다. 하이햇(열림)은 0.6초에서 끊기지만 크래시는
 * 2~4초씩 사라지지 않고 운다. `drumDecaySec` 상한이 화면에서 2였던 것을
 * 엔진 실효 범위(4)까지 열어서 이 값을 얻었다(`drum-base.ts`).
 *
 * 샘플이 아니라 합성이다 — 실제 크래시 심벌 녹음보다 사실감은 떨어지지만,
 * 지금 대용(`hihat-open`)보다는 낫다. 실측 샘플은 `ROADMAP.md` S3(에셋 배선)
 * 대상이고, 그게 들어오면 이 정의를 `sampler` 보이스로 바꾸면 된다.
 */
export const definition: InstrumentDefinition = {
  id: 'crash-cymbal',
  schemaVersion: 1,
  name: '크래시 심벌',
  baseLevel: 0.36,
  extends: 'drum-base',
  params: {
    drumKind: 3, drumDecaySec: 3.2, drumPitchDrop: 0, drumNoiseAmount: 1,
    drumModeCount: 6, drumInharmonicity: 1,
    // 하이햇(열림)보다 밝게 — 크래시 특유의 쏴아 하는 상단 배음
    strikePosition: 0.75,
  },
  range: { low: 46, high: 84 },
};

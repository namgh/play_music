/**
 * **자동 생성 — 손으로 고치지 말 것.** (synth 계열 8개)
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */

import type { InstrumentDefinition } from '../../types.ts';
import { definition as sub_bass } from './sub-bass.ts';
import { definition as supersaw_lead } from './supersaw-lead.ts';
import { definition as synth_base } from './synth-base.ts';
import { definition as synth_bass } from './synth-bass.ts';
import { definition as synth_lead } from './synth-lead.ts';
import { definition as synth_organ } from './synth-organ.ts';
import { definition as synth_pad } from './synth-pad.ts';
import { definition as synth_pluck } from './synth-pluck.ts';

export const definitions: readonly InstrumentDefinition[] = [
  sub_bass,
  supersaw_lead,
  synth_base,
  synth_bass,
  synth_lead,
  synth_organ,
  synth_pad,
  synth_pluck,
];

/**
 * **자동 생성 — 손으로 고치지 말 것.** (drum 계열 7개)
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */

import type { InstrumentDefinition } from '../../types.ts';
import { definition as clap } from './clap.ts';
import { definition as drum_base } from './drum-base.ts';
import { definition as hihat_open } from './hihat-open.ts';
import { definition as hihat } from './hihat.ts';
import { definition as kick } from './kick.ts';
import { definition as snare } from './snare.ts';
import { definition as tom } from './tom.ts';

export const definitions: readonly InstrumentDefinition[] = [
  clap,
  drum_base,
  hihat_open,
  hihat,
  kick,
  snare,
  tom,
];

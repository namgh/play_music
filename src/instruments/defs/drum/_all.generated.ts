/**
 * **자동 생성 — 손으로 고치지 말 것.** (drum 계열 17개)
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */

import type { InstrumentDefinition } from '../../types.ts';
import { definition as bongo } from './bongo.ts';
import { definition as brush_snare } from './brush-snare.ts';
import { definition as clap } from './clap.ts';
import { definition as conga } from './conga.ts';
import { definition as cowbell } from './cowbell.ts';
import { definition as crash_cymbal } from './crash-cymbal.ts';
import { definition as drum_base } from './drum-base.ts';
import { definition as hihat_open } from './hihat-open.ts';
import { definition as hihat } from './hihat.ts';
import { definition as kick } from './kick.ts';
import { definition as rimshot } from './rimshot.ts';
import { definition as shaker } from './shaker.ts';
import { definition as snare } from './snare.ts';
import { definition as tambourine } from './tambourine.ts';
import { definition as tom_floor } from './tom-floor.ts';
import { definition as tom_high } from './tom-high.ts';
import { definition as tom } from './tom.ts';

export const definitions: readonly InstrumentDefinition[] = [
  bongo,
  brush_snare,
  clap,
  conga,
  cowbell,
  crash_cymbal,
  drum_base,
  hihat_open,
  hihat,
  kick,
  rimshot,
  shaker,
  snare,
  tambourine,
  tom_floor,
  tom_high,
  tom,
];

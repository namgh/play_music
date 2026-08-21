/**
 * **자동 생성 — 손으로 고치지 말 것.** (string 계열 19개)
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */

import type { InstrumentDefinition } from '../../types.ts';
import { definition as acoustic_guitar } from './acoustic-guitar.ts';
import { definition as amped_string } from './amped-string.ts';
import { definition as archtop_jazz_guitar } from './archtop-jazz-guitar.ts';
import { definition as banjo } from './banjo.ts';
import { definition as bass_5_string } from './bass-5-string.ts';
import { definition as bouzouki } from './bouzouki.ts';
import { definition as classical_guitar } from './classical-guitar.ts';
import { definition as double_bass_pizz } from './double-bass-pizz.ts';
import { definition as electric_bass } from './electric-bass.ts';
import { definition as electric_guitar_lp } from './electric-guitar-lp.ts';
import { definition as electric_guitar } from './electric-guitar.ts';
import { definition as harp } from './harp.ts';
import { definition as harpsichord } from './harpsichord.ts';
import { definition as koto } from './koto.ts';
import { definition as mandolin } from './mandolin.ts';
import { definition as sitar } from './sitar.ts';
import { definition as string_base } from './string-base.ts';
import { definition as twelve_string_guitar } from './twelve-string-guitar.ts';
import { definition as ukulele_soprano } from './ukulele-soprano.ts';

export const definitions: readonly InstrumentDefinition[] = [
  acoustic_guitar,
  amped_string,
  archtop_jazz_guitar,
  banjo,
  bass_5_string,
  bouzouki,
  classical_guitar,
  double_bass_pizz,
  electric_bass,
  electric_guitar_lp,
  electric_guitar,
  harp,
  harpsichord,
  koto,
  mandolin,
  sitar,
  string_base,
  twelve_string_guitar,
  ukulele_soprano,
];

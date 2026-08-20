/**
 * **자동 생성 파일 — 손으로 고치지 말 것.**
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 이 파일이 최신인지 검사하므로, 잊으면 거기서 걸린다.
 *
 * 악기 30개.
 */

import type { InstrumentDefinition } from './types.ts';

import { definition as clap } from './defs/drum/clap.ts';
import { definition as drum_base } from './defs/drum/drum-base.ts';
import { definition as hihat_open } from './defs/drum/hihat-open.ts';
import { definition as hihat } from './defs/drum/hihat.ts';
import { definition as kick } from './defs/drum/kick.ts';
import { definition as snare } from './defs/drum/snare.ts';
import { definition as tom } from './defs/drum/tom.ts';
import { definition as glockenspiel } from './defs/modal/glockenspiel.ts';
import { definition as marimba } from './defs/modal/marimba.ts';
import { definition as modal_base } from './defs/modal/modal-base.ts';
import { definition as tubular_bell } from './defs/modal/tubular-bell.ts';
import { definition as vibraphone } from './defs/modal/vibraphone.ts';
import { definition as acoustic_piano } from './defs/piano/acoustic-piano.ts';
import { definition as clavinet } from './defs/piano/clavinet.ts';
import { definition as electric_piano_rhodes } from './defs/piano/electric-piano-rhodes.ts';
import { definition as electric_piano_wurlitzer } from './defs/piano/electric-piano-wurlitzer.ts';
import { definition as upright_piano } from './defs/piano/upright-piano.ts';
import { definition as acoustic_guitar } from './defs/string/acoustic-guitar.ts';
import { definition as amped_string } from './defs/string/amped-string.ts';
import { definition as electric_bass } from './defs/string/electric-bass.ts';
import { definition as electric_guitar_lp } from './defs/string/electric-guitar-lp.ts';
import { definition as electric_guitar } from './defs/string/electric-guitar.ts';
import { definition as harp } from './defs/string/harp.ts';
import { definition as mandolin } from './defs/string/mandolin.ts';
import { definition as string_base } from './defs/string/string-base.ts';
import { definition as ukulele_soprano } from './defs/string/ukulele-soprano.ts';
import { definition as synth_base } from './defs/synth/synth-base.ts';
import { definition as synth_bass } from './defs/synth/synth-bass.ts';
import { definition as synth_lead } from './defs/synth/synth-lead.ts';
import { definition as synth_pad } from './defs/synth/synth-pad.ts';

export const BUILT_IN_INSTRUMENTS: readonly InstrumentDefinition[] = [
  clap,
  drum_base,
  hihat_open,
  hihat,
  kick,
  snare,
  tom,
  glockenspiel,
  marimba,
  modal_base,
  tubular_bell,
  vibraphone,
  acoustic_piano,
  clavinet,
  electric_piano_rhodes,
  electric_piano_wurlitzer,
  upright_piano,
  acoustic_guitar,
  amped_string,
  electric_bass,
  electric_guitar_lp,
  electric_guitar,
  harp,
  mandolin,
  string_base,
  ukulele_soprano,
  synth_base,
  synth_bass,
  synth_lead,
  synth_pad,
];

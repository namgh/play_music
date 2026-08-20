/**
 * **자동 생성 — 손으로 고치지 말 것.** (piano 계열 5개)
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */

import type { InstrumentDefinition } from '../../types.ts';
import { definition as acoustic_piano } from './acoustic-piano.ts';
import { definition as clavinet } from './clavinet.ts';
import { definition as electric_piano_rhodes } from './electric-piano-rhodes.ts';
import { definition as electric_piano_wurlitzer } from './electric-piano-wurlitzer.ts';
import { definition as upright_piano } from './upright-piano.ts';

export const definitions: readonly InstrumentDefinition[] = [
  acoustic_piano,
  clavinet,
  electric_piano_rhodes,
  electric_piano_wurlitzer,
  upright_piano,
];

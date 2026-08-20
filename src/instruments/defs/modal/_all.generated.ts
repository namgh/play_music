/**
 * **자동 생성 — 손으로 고치지 말 것.** (modal 계열 5개)
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */

import type { InstrumentDefinition } from '../../types.ts';
import { definition as glockenspiel } from './glockenspiel.ts';
import { definition as marimba } from './marimba.ts';
import { definition as modal_base } from './modal-base.ts';
import { definition as tubular_bell } from './tubular-bell.ts';
import { definition as vibraphone } from './vibraphone.ts';

export const definitions: readonly InstrumentDefinition[] = [
  glockenspiel,
  marimba,
  modal_base,
  tubular_bell,
  vibraphone,
];

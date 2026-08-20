/**
 * **자동 생성 — 손으로 고치지 말 것.** (계열 5개)
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */

import type { InstrumentDefinition } from './types.ts';

type FamilyModule = { definitions: readonly InstrumentDefinition[] };

/** **정적 경로여야 한다** — 번들러가 청크를 나누려면 경로를 컴파일 시점에 알아야 한다 */
export const FAMILY_LOADERS: Record<string, () => Promise<FamilyModule>> = {
  'drum': () => import('./defs/drum/_all.generated.ts'),
  'modal': () => import('./defs/modal/_all.generated.ts'),
  'piano': () => import('./defs/piano/_all.generated.ts'),
  'string': () => import('./defs/string/_all.generated.ts'),
  'synth': () => import('./defs/synth/_all.generated.ts'),
};

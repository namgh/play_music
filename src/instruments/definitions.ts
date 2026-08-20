/**
 * 악기 목록의 **공개 창구.**
 *
 * 정의 자체는 여기 없다 — `defs/<계열>/<id>.ts` 에 **악기 하나당 파일 하나**로 있고,
 * `registry.generated.ts` 가 그 폴더를 읽어 모은다.
 *
 * 왜 나눴는가: 한 파일에 다 넣으면 악기 30개에 1,169줄이었다. 1000개면 39,000줄이
 * 되는데, 그건 한 악기를 고칠 때마다 나머지 999개가 걸린 파일을 여는 것이고
 * 충돌도 거기서 난다. **한 악기를 고쳐도 다른 악기 파일은 손대지 않는다**는 것이
 * 이 구조의 목적이다.
 *
 * 새 악기를 추가하려면 (`sound.md` 9-3):
 *   1. `defs/<계열>/<id>.ts` 를 만든다 — `export const definition`
 *   2. `npm run instruments:index`
 * Rust 는 한 줄도 열지 않는다 (`CLAUDE.md` 확정된 결정 6).
 */

import type { InstrumentCategory, InstrumentDefinition } from './types.ts';
import { CATEGORY_ORDER } from './types.ts';
import { resolveInstrument } from './resolve.ts';
import { BUILT_IN_INSTRUMENTS } from './registry.generated.ts';

export { BUILT_IN_INSTRUMENTS };

/** 기준 정의는 사용자에게 악기로 보이지 않는다 — 연주용 악기가 아니다 */
const ABSTRACT_IDS = new Set([
  'string-base', 'amped-string', 'synth-base', 'modal-base', 'drum-base',
]);

export function createRegistry(
  defs: readonly InstrumentDefinition[] = BUILT_IN_INSTRUMENTS,
): Map<string, InstrumentDefinition> {
  const map = new Map<string, InstrumentDefinition>();
  for (const def of defs) {
    if (map.has(def.id)) throw new Error(`악기 id 중복: ${def.id}`);
    map.set(def.id, def);
  }
  return map;
}

export function playableInstrumentIds(
  defs: readonly InstrumentDefinition[] = BUILT_IN_INSTRUMENTS,
): string[] {
  return defs.filter((d) => !ABSTRACT_IDS.has(d.id)).map((d) => d.id);
}

/**
 * 분류별로 묶은 악기 목록. **화면은 이걸 그대로 그린다** (`plan.md` 원칙 5 —
 * 악기가 늘어나도 화면을 새로 만들지 않는다).
 *
 * 평면 목록이 20개를 넘어가면 고르기가 힘들어진다. 기타만 셋인데 하프·킥 사이에
 * 흩어져 있으면 "기타 중에 뭐가 있나"를 볼 수 없다.
 *
 * 빈 분류는 나오지 않는다 — 악기를 지웠을 때 빈 그룹 헤더가 남으면 안 된다.
 */
export function instrumentsByCategory(
  defs: readonly InstrumentDefinition[] = BUILT_IN_INSTRUMENTS,
): { category: InstrumentCategory; instruments: { id: string; name: string }[] }[] {
  const registry = createRegistry(defs);
  const groups = new Map<InstrumentCategory, { id: string; name: string }[]>();

  for (const id of playableInstrumentIds(defs)) {
    const resolved = resolveInstrument(id, registry);
    const list = groups.get(resolved.category) ?? [];
    list.push({ id, name: resolved.name });
    groups.set(resolved.category, list);
  }

  return CATEGORY_ORDER
    .filter((category) => (groups.get(category)?.length ?? 0) > 0)
    .map((category) => ({ category, instruments: groups.get(category)! }));
}

/**
 * 악기 목록의 **공개 창구.**
 *
 * 정의 자체는 여기 없다 — `defs/<계열>/<id>.ts` 에 **악기 하나당 파일 하나**로 있다.
 * 목록에 필요한 것(이름·분류)은 `catalog.generated.ts` 에 상속을 펼쳐 박아 두고,
 * 파라미터는 그 악기로 소리를 낼 때 계열 단위로 불러온다 (`loader.ts`).
 *
 * 왜 나눴는가:
 *  - **파일은 악기 단위** — 하나를 고칠 때 남의 파일을 안 연다
 *  - **청크는 계열 단위** — 악기마다 나누면 1000개 요청이 된다
 *  - **목록은 항상, 파라미터는 필요할 때** — 1000개면 865KB 대 45KB 다
 *
 * 새 악기를 추가하려면 (`sound.md` 9-3):
 *   1. `defs/<계열>/<id>.ts` 를 만든다 — `export const definition`
 *   2. `npm run instruments:index`
 * Rust 는 한 줄도 열지 않는다 (`CLAUDE.md` 확정된 결정 6).
 */

import type { InstrumentCategory, InstrumentDefinition } from './types.ts';
import { CATEGORY_ORDER } from './types.ts';
import { INSTRUMENT_CATALOG, type CatalogEntry } from './catalog.generated.ts';

export { INSTRUMENT_CATALOG, type CatalogEntry };
export {
  isLoaded, loadAllInstruments, loadInstruments, loadedRegistry, resetLoaderForTest,
} from './loader.ts';

/**
 * 목록에 나올 악기들. **불러오지 않고** 답한다 — 고르는 화면은 이름만 있으면 된다.
 */
export function playableInstrumentIds(): string[] {
  return INSTRUMENT_CATALOG.filter((e) => !e.abstract).map((e) => e.id);
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
export function instrumentsByCategory(): {
  category: InstrumentCategory;
  instruments: { id: string; name: string }[];
}[] {
  const groups = new Map<InstrumentCategory, { id: string; name: string }[]>();
  for (const entry of INSTRUMENT_CATALOG) {
    if (entry.abstract) continue;
    const list = groups.get(entry.category) ?? [];
    list.push({ id: entry.id, name: entry.name });
    groups.set(entry.category, list);
  }
  return CATEGORY_ORDER
    .filter((category) => (groups.get(category)?.length ?? 0) > 0)
    .map((category) => ({ category, instruments: groups.get(category)! }));
}

/**
 * 정의 배열로 레지스트리를 만든다.
 *
 * **테스트가 손으로 만든 정의를 넣어 볼 때** 쓴다. 앱은 `loadInstruments()` 가
 * 돌려주는 것을 쓴다 — 거기가 캐시를 들고 있다.
 */
export function createRegistry(
  defs: readonly InstrumentDefinition[],
): Map<string, InstrumentDefinition> {
  const map = new Map<string, InstrumentDefinition>();
  for (const def of defs) {
    if (map.has(def.id)) throw new Error(`악기 id 중복: ${def.id}`);
    map.set(def.id, def);
  }
  return map;
}

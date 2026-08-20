/**
 * 악기 지연 로딩.
 *
 * 악기 고르는 화면은 **이름과 분류만** 있으면 된다 (`catalog.generated.ts`, 항상 실림).
 * 파라미터는 그 악기로 **소리를 낼 때** 필요하다. 실측하면 목록에 필요한 것은 전체의
 * 5% 라, 1000개에서 865KB 를 내려받을 것이 45KB 가 된다.
 *
 * 내려받기의 단위는 **계열**이다. 악기마다 나누면 1000개 요청이 되고, 한 덩어리로
 * 두면 지연 로딩이 아니게 된다.
 *
 * ## 왜 캐시가 모듈 수준에 있나
 *
 * 같은 계열을 두 번 내려받지 않기 위해서다. 브라우저 모듈 캐시가 이미 그 일을
 * 하지만, 여기서 한 번 더 잡아 **동시에 두 트랙이 같은 계열을 부를 때** 요청이
 * 겹치지 않게 한다.
 */

import type { InstrumentDefinition } from './types.ts';
import { INSTRUMENT_CATALOG } from './catalog.generated.ts';
import { FAMILY_LOADERS } from './families.generated.ts';

const loaded = new Map<string, InstrumentDefinition>();
const inFlight = new Map<string, Promise<void>>();

/** 지금까지 불러온 것만. 화면이 아니라 **렌더러**가 쓴다 */
export function loadedRegistry(): Map<string, InstrumentDefinition> {
  return loaded;
}

export function isLoaded(id: string): boolean {
  return loaded.has(id);
}

async function loadFamily(family: string): Promise<void> {
  const load = FAMILY_LOADERS[family];
  if (!load) throw new Error(`모르는 계열: ${family}`);

  const running = inFlight.get(family);
  if (running) return running;

  const task = load().then((mod) => {
    for (const def of mod.definitions) loaded.set(def.id, def);
  });
  inFlight.set(family, task);
  try {
    await task;
  } finally {
    // 실패하면 다음에 다시 시도할 수 있어야 한다 — 실패를 캐시하면 영영 안 된다
    inFlight.delete(family);
  }
}

/**
 * 이 악기들로 소리를 낼 수 있게 준비한다. **상속을 따라** 필요한 계열을 전부 부른다
 * (피아노가 줄 계열을 상속하는 식이라, 계열 하나만 불러서는 부족하다).
 */
export async function loadInstruments(
  ids: readonly string[],
): Promise<Map<string, InstrumentDefinition>> {
  const families = new Set<string>();
  for (const id of ids) {
    const entry = INSTRUMENT_CATALOG.find((e) => e.id === id);
    if (!entry) throw new Error(`모르는 악기: ${id}`);
    for (const chunk of entry.chunks) families.add(chunk);
  }
  await Promise.all([...families].map(loadFamily));
  return loaded;
}

/**
 * 전부 불러온다. **테스트와 측정 도구용**이다 — 앱에서 부르면 지연 로딩이 무의미해진다.
 */
export async function loadAllInstruments(): Promise<Map<string, InstrumentDefinition>> {
  await Promise.all(Object.keys(FAMILY_LOADERS).map(loadFamily));
  return loaded;
}

/** 테스트가 상태를 초기화할 수 있게 */
export function resetLoaderForTest(): void {
  loaded.clear();
  inFlight.clear();
}

/**
 * 화면이 필요한 악기를 불러오는 훅.
 *
 * **이름은 기다리지 않는다.** 목록·이름·분류는 항상 실려 있는 카탈로그에서 바로
 * 나온다 (`catalog.generated.ts`). 기다려야 하는 것은 파라미터·음역·음색뿐이고,
 * 그건 그 악기로 소리를 낼 때 필요하다.
 *
 * 그래서 이 훅은 화면을 막지 않는다 — 목록은 즉시 그려지고, 상세는 `ready` 가
 * 참이 되면 나타난다.
 */

import { useEffect, useState } from 'react';

import type { InstrumentDefinition } from './types.ts';
import { loadInstruments, loadedRegistry } from './loader.ts';

export interface InstrumentsState {
  registry: Map<string, InstrumentDefinition>;
  /** 요청한 악기들의 정의가 전부 왔는가 */
  ready: boolean;
  /** 불러오다 실패했다면 그 이유 — 화면이 조용히 비어 있으면 안 된다 */
  error: Error | null;
}

export function useInstruments(ids: readonly string[]): InstrumentsState {
  // 배열은 매 렌더마다 새 참조라 그대로 의존성에 넣으면 무한히 다시 부른다.
  // 내용으로 비교한다
  const key = [...new Set(ids)].sort().join(',');
  const [state, setState] = useState<InstrumentsState>(() => ({
    registry: loadedRegistry(),
    ready: ids.every((id) => loadedRegistry().has(id)),
    error: null,
  }));

  useEffect(() => {
    let alive = true;
    const wanted = key ? key.split(',') : [];
    if (wanted.every((id) => loadedRegistry().has(id))) {
      setState({ registry: loadedRegistry(), ready: true, error: null });
      return () => { alive = false; };
    }

    setState((s) => ({ ...s, ready: false }));
    loadInstruments(wanted)
      .then((registry) => { if (alive) setState({ registry, ready: true, error: null }); })
      .catch((e: unknown) => {
        if (alive) {
          setState({
            registry: loadedRegistry(),
            ready: false,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      });
    return () => { alive = false; };
  }, [key]);

  // **`ready` 는 지금 요청한 악기 기준으로 매 렌더 다시 판정한다.**
  //
  // 상태에 담아 두면 한 렌더 늦는다: 프로젝트가 바뀐 렌더에서는 아직 **이전 곡
  // 기준의 `ready: true`** 가 남아 있고(효과는 렌더 뒤에 돈다), 화면은 그걸 믿고
  // 아직 안 온 악기를 resolve 하다 죽는다.
  //
  // 실제로 그랬다 — MIDI 를 가져오면 악기가 통째로 바뀌는데, 그 순간
  // `InstrumentResolveError: 악기 정의 "acoustic-piano" 없음` 으로 편집기가 내려갔다.
  // 가져오기가 전부 기타로 들어오던 때에는 이미 불러온 악기라 드러나지 않았다.
  const wanted = key ? key.split(',') : [];
  const ready = state.error === null && wanted.every((id) => state.registry.has(id));
  return { ...state, ready };
}

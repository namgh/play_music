/**
 * 소리 찾기 — 악기 검색·거르기와 사용자 패치(내 음색) 보관 (Logic 브라우저, `LOGIC_PARITY.md` 1-6).
 *
 * 검색은 순수 함수다. 패치는 **곡이 아니라 사용자 라이브러리**라 프로젝트에 넣지 않고
 * 브라우저 저장소에 둔다 — 다른 곡에서도 꺼내 쓰는 것이 패치의 쓸모다.
 */

import type { CatalogEntry } from './definitions.ts';
import type { InstrumentCategory } from './types.ts';

/** 합성 방식 이름 — 검색어로도 쓴다 ("모달" 이라고 치면 말렛류가 나온다) */
export const FAMILY_LABEL: Record<string, string> = {
  string: '줄 · 물리 모델',
  modal: '모달 · 물리 모델',
  synth: '신스 · 버추얼 아날로그',
  sampler: '샘플러',
  drum: '합성 드럼',
};

export interface BrowseQuery {
  text: string;
  category: InstrumentCategory | null;
}

/**
 * 이름·분류·합성 방식에 낱말이 **전부** 들어 있는 것. 띄어쓰기로 낱말을 나눈다 —
 * "베이스 신스" 는 신스 베이스를 찾는다. 대소문자·띄어쓰기 차이는 무시한다.
 */
export function searchInstruments(catalog: readonly CatalogEntry[], query: BrowseQuery): CatalogEntry[] {
  const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.filter((entry) => {
    if (entry.abstract) return false;
    if (query.category && entry.category !== query.category) return false;
    const hay = `${entry.name} ${entry.id} ${entry.category} ${FAMILY_LABEL[entry.family] ?? entry.family}`.toLowerCase().replace(/\s+/g, '');
    return words.every((w) => hay.includes(w));
  });
}

export interface UserPatch {
  id: string;
  name: string;
  instrumentId: string;
  toneId: string;
  toneParams: Record<string, number | string> | null;
  /** 저장한 시각 (ms) — 최근 것이 위 */
  savedAt: number;
}

const PATCH_KEY = 'user-patches-v1';

export function addPatch(list: readonly UserPatch[], patch: Omit<UserPatch, 'id' | 'savedAt'>, now: number): UserPatch[] {
  const name = patch.name.trim() || '내 음색';
  // 같은 이름이면 덮어쓴다 — 이름이 패치를 찾는 열쇠다
  const rest = list.filter((p) => p.name !== name);
  return [{ ...patch, name, id: `pat_${now.toString(36)}`, savedAt: now }, ...rest];
}

export function removePatch(list: readonly UserPatch[], id: string): UserPatch[] {
  return list.filter((p) => p.id !== id);
}

export function loadPatches(): UserPatch[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PATCH_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && typeof p.instrumentId === 'string') : [];
  } catch {
    return [];
  }
}

export function savePatches(list: readonly UserPatch[]): boolean {
  try {
    localStorage.setItem(PATCH_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

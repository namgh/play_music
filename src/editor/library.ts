/**
 * 곡 보관함 — 최근 곡 목록과 곡마다의 버전 (Logic 프로젝트 고르기 · 프로젝트 대안,
 * `LOGIC_PARITY.md` 1-1).
 *
 * 자동 저장은 "지금 여는 곡" 하나다(`projectStorage.ts`). 보관함은 그 곁에 **여러 곡**과
 * **곡마다 이름 붙인 버전**을 둔다. 버전은 Logic 의 대안(alternative)과 같다 — "브리지
 * 바꾸기 전" 을 남겨 두고 마음껏 고친 뒤 돌아올 수 있다.
 *
 * 저장소는 키-값 하나로 추상화한다(`Kv`). 브라우저에서는 localStorage, 테스트에서는
 * 메모리 Map. 데스크톱 앱으로 감싸면 파일 시스템으로 갈아 끼운다.
 */

import type { Project, ProjectId } from '../model/project.ts';
import { deserializeProject, serializeProject } from '../model/persistence.ts';

export interface Kv {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const browserKv: Kv = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { localStorage.setItem(k, v); },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

export interface LibraryEntry {
  id: ProjectId;
  name: string;
  updatedAt: number;
  tracks: number;
  bars: number;
}

export interface VersionEntry {
  id: string;
  name: string;
  savedAt: number;
}

const INDEX = 'library-v1';
const projectKey = (id: string) => `library-project-${id}`;
const versionsKey = (id: string) => `library-versions-${id}`;
const versionKey = (id: string, v: string) => `library-version-${id}-${v}`;
/** 최근 곡을 이만큼만 남긴다 — 저장소가 차면 자동 저장까지 실패한다 */
export const LIBRARY_LIMIT = 30;

function readJson<T>(kv: Kv, key: string, fallback: T): T {
  try {
    const raw = kv.get(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function listProjects(kv: Kv): LibraryEntry[] {
  return readJson<LibraryEntry[]>(kv, INDEX, []).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 자리 만들기 — 가장 오래된 곡 하나(와 그 버전)를 지운다. `keepId` 는 지금 여는 곡이라 남긴다.
 * 지울 것이 없으면 false.
 *
 * 브라우저 저장소는 5MB 쯤이고 곡 하나가 수백 KB 다 — 30곡을 채우기 훨씬 전에 찬다.
 * 그때 **지금 곡의 자동 저장이 실패하는 것**이 가장 나쁘다 (새로고침 한 번에 곡을 잃는다).
 * 그래서 오래된 곡부터 내주고 지금 곡을 지킨다.
 */
export function makeRoom(kv: Kv, keepId: ProjectId | null): boolean {
  const oldest = listProjects(kv).filter((e) => e.id !== keepId).pop();
  if (!oldest) return false;
  try { removeProject(kv, oldest.id); } catch { return false; }
  return true;
}

/** 저장소가 차 있으면 오래된 곡을 내주며 다시 쓴다. 더 내줄 곡이 없는데도 안 들어가면 던진다 */
export function setWithRoom(kv: Kv, key: string, value: string, keepId: ProjectId | null): void {
  for (;;) {
    try { kv.set(key, value); return; } catch (err) {
      if (!makeRoom(kv, keepId)) throw err;
    }
  }
}

/** 곡을 보관함에 넣거나 갱신한다. 넘치면 가장 오래된 곡(과 그 버전)을 지운다 */
export function putProject(kv: Kv, project: Project, now: number): void {
  setWithRoom(kv, projectKey(project.id), serializeProject(project), project.id);
  const entry: LibraryEntry = {
    id: project.id, name: project.name, updatedAt: now, tracks: project.tracks.length, bars: project.lengthBars,
  };
  const list = [entry, ...listProjects(kv).filter((e) => e.id !== project.id)];
  for (const old of list.slice(LIBRARY_LIMIT)) removeProject(kv, old.id);
  kv.set(INDEX, JSON.stringify(list.slice(0, LIBRARY_LIMIT)));
}

export function getProject(kv: Kv, id: ProjectId): Project | null {
  const raw = kv.get(projectKey(id));
  if (raw === null) return null;
  try { return deserializeProject(raw); } catch { return null; }
}

export function removeProject(kv: Kv, id: ProjectId): void {
  for (const v of listVersions(kv, id)) kv.remove(versionKey(id, v.id));
  kv.remove(versionsKey(id));
  kv.remove(projectKey(id));
  kv.set(INDEX, JSON.stringify(listProjects(kv).filter((e) => e.id !== id)));
}

export function listVersions(kv: Kv, id: ProjectId): VersionEntry[] {
  return readJson<VersionEntry[]>(kv, versionsKey(id), []).sort((a, b) => b.savedAt - a.savedAt);
}

/** 지금 곡을 이름 붙인 버전으로 남긴다. 같은 이름이면 덮어쓴다 */
export function saveVersion(kv: Kv, project: Project, name: string, now: number): VersionEntry {
  const label = name.trim() || `버전 ${listVersions(kv, project.id).length + 1}`;
  const existing = listVersions(kv, project.id).find((v) => v.name === label);
  const entry: VersionEntry = { id: existing?.id ?? now.toString(36), name: label, savedAt: now };
  setWithRoom(kv, versionKey(project.id, entry.id), serializeProject(project), project.id);
  kv.set(versionsKey(project.id), JSON.stringify([entry, ...listVersions(kv, project.id).filter((v) => v.id !== entry.id)]));
  return entry;
}

export function loadVersion(kv: Kv, id: ProjectId, versionId: string): Project | null {
  const raw = kv.get(versionKey(id, versionId));
  if (raw === null) return null;
  try { return deserializeProject(raw); } catch { return null; }
}

export function deleteVersion(kv: Kv, id: ProjectId, versionId: string): void {
  kv.remove(versionKey(id, versionId));
  kv.set(versionsKey(id), JSON.stringify(listVersions(kv, id).filter((v) => v.id !== versionId)));
}

/** 테스트용 메모리 저장소 */
export function memoryKv(quotaChars = Infinity): Kv & { size: () => number } {
  const map = new Map<string, string>();
  const used = (skip: string) => [...map.entries()].reduce((n, [k, v]) => n + (k === skip ? 0 : k.length + v.length), 0);
  return {
    get: (k) => map.get(k) ?? null,
    // 브라우저처럼 — 넘치면 던지고 아무것도 바꾸지 않는다
    set: (k, v) => { if (used(k) + k.length + v.length > quotaChars) throw new Error('QuotaExceededError'); map.set(k, v); },
    remove: (k) => { map.delete(k); },
    size: () => map.size,
  };
}

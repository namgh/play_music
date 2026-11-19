/**
 * 묶음 파일 — 곡(JSON) + 오디오·영상 에셋을 ZIP 하나로 (`PARITY_ROUND2.md` 1).
 *
 * 오디오·영상은 이 브라우저의 에셋 저장소(IndexedDB)에만 있어서 .json 으로 저장하면 소리가 빠졌다.
 * 에셋이 하나라도 있으면 `<곡>.zip` 으로 내려받는다: `project.json` + `assets/<id>`.
 * 열 때는 에셋을 저장소에 다시 넣는다 — 에셋 id 가 내용 해시라 같은 소리는 한 번만 들어간다.
 *
 * 에셋을 읽고 쓰는 함수를 인자로 받는다 — Node 시험에서 IndexedDB 없이 돌린다.
 */

import type { Project } from '../model/project.ts';
import { deserializeProject, serializeProject } from '../model/persistence.ts';
import { makeZip, readZip, ZipReadError } from '../audio/zip.ts';

export const BUNDLE_PROJECT = 'project.json';

/** 곡이 쓰는 에셋 id (중복 없이) */
export function projectAssetIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const t of project.tracks) {
    for (const c of t.clips) if (c.audio?.assetId) ids.add(c.audio.assetId);
  }
  if (project.video?.assetId) ids.add(project.video.assetId);
  return [...ids];
}

export interface BundleResult {
  bytes: Uint8Array;
  /** 저장소에서 찾지 못한 에셋 — 이 브라우저에 없는 소리 (다른 기기에서 연 곡 등) */
  missing: string[];
}

export async function makeBundle(project: Project, getAsset: (id: string) => Promise<ArrayBuffer | null>): Promise<BundleResult> {
  const entries = [{ name: BUNDLE_PROJECT, data: new TextEncoder().encode(serializeProject(project)) }];
  const missing: string[] = [];
  for (const id of projectAssetIds(project)) {
    const bytes = await getAsset(id);
    if (bytes) entries.push({ name: `assets/${id}`, data: new Uint8Array(bytes) });
    else missing.push(id);
  }
  return { bytes: makeZip(entries), missing };
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export interface OpenedBundle {
  project: Project;
  /** 저장소에 넣은 에셋 수 */
  assets: number;
  /** 곡이 쓰는데 묶음에 없던 에셋 */
  missing: string[];
}

export async function openBundle(bytes: Uint8Array, putAsset: (bytes: ArrayBuffer) => Promise<string>): Promise<OpenedBundle> {
  const files = readZip(bytes);
  const json = files.get(BUNDLE_PROJECT);
  if (!json) throw new ZipReadError(`묶음 파일에 ${BUNDLE_PROJECT} 이 없습니다`);
  const project = deserializeProject(new TextDecoder().decode(json));
  let assets = 0;
  for (const [name, data] of files) {
    if (!name.startsWith('assets/')) continue;
    const id = await putAsset(data.slice().buffer);
    // 이름과 내용 해시가 다르면 파일이 바뀐 것 — 그래도 넣되 곡이 찾는 id 는 이름 쪽이다
    if (id !== name.slice(7)) console.warn(`에셋 ${name} 의 내용이 이름과 다르다`);
    assets++;
  }
  const have = new Set([...files.keys()].filter((n) => n.startsWith('assets/')).map((n) => n.slice(7)));
  return { project, assets, missing: projectAssetIds(project).filter((id) => !have.has(id)) };
}

/**
 * 프로젝트 보관 — 브라우저 저장소와 파일.
 *
 * 서버는 아직 없다 (`plan.md` 5-2 — 서버는 저장·동기화만 담당하고 나중에 붙는다).
 * 그때까지 **작업이 새로고침으로 사라지지 않게** 하는 것이 목적이다.
 *
 * 자동 저장은 localStorage, 명시적 저장·열기는 파일이다. 둘을 나누는 이유:
 * localStorage 는 브라우저를 지우면 없어지고 용량 제한도 있으므로, 사용자가
 * "내 곡"이라고 여기는 것은 파일로 손에 쥘 수 있어야 한다.
 */

import type { Project } from '../model/project.ts';
import { deserializeProject, ProjectLoadError, serializeProject } from '../model/persistence.ts';
import { isZip, makeBundle, openBundle, projectAssetIds } from './bundle.ts';
import { getAsset, putAsset } from '../audio/assets.ts';

const AUTOSAVE_KEY = 'project-autosave-v1';

/** 파일 이름으로 쓸 수 없는 문자를 정리한다 */
export function projectFileName(project: Project): string {
  const base = project.name.trim().replace(/[/\\?%*:|"<>]/g, '-').slice(0, 60);
  return `${base || 'project'}.json`;
}

/**
 * 성공 여부를 돌려준다. **실패를 삼키지 않는다** — 저장이 안 되고 있는데 화면이
 * "저장됨"이라고 하면 사용자는 새로고침 한 번에 곡을 잃는다. 편집을 막지는 않되
 * 알리는 것은 호출한 쪽의 몫이다.
 */
export function saveAutosave(project: Project): boolean {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeProject(project));
    return true;
  } catch {
    // 용량 초과, 저장소 차단(사생활 보호 창) 등
    return false;
  }
}

export function loadAutosave(): Project | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (!text) return null;
    return deserializeProject(text);
  } catch (err) {
    // 깨진 자동 저장이 앱을 못 열게 만들면 안 된다
    console.warn('자동 저장을 불러오지 못했다 — 새 프로젝트로 시작한다', err);
    return null;
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* 무시 */
  }
}

/** 프로젝트를 파일로 내려받는다 */
export function downloadProject(project: Project): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = projectFileName(project);
  link.click();
  URL.revokeObjectURL(url);
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 파일로 저장 — 오디오·영상이 있으면 **묶음 파일(.zip)** 로 (소리까지 들어간다), 없으면 예전처럼 .json.
 * 결과: 어떤 파일로 저장했는지와, 이 브라우저에 없어 빠진 에셋 수
 */
export async function saveProjectFile(project: Project): Promise<{ kind: 'json' | 'bundle'; missing: number }> {
  if (projectAssetIds(project).length === 0) {
    downloadProject(project);
    return { kind: 'json', missing: 0 };
  }
  const { bytes, missing } = await makeBundle(project, getAsset);
  download(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), projectFileName(project).replace(/\.json$/, '.zip'));
  return { kind: 'bundle', missing: missing.length };
}

/** 파일에서 프로젝트를 읽는다(.json 또는 묶음 .zip). 실패 이유를 그대로 올려 보낸다 */
export async function readProjectFile(file: File): Promise<Project> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (isZip(head)) {
    try {
      const opened = await openBundle(new Uint8Array(await file.arrayBuffer()), putAsset);
      if (opened.missing.length) console.warn(`묶음 파일에 없는 에셋 ${opened.missing.length}개`);
      return opened.project;
    } catch (err) {
      if (err instanceof ProjectLoadError) throw err;
      throw new ProjectLoadError(err instanceof Error ? err.message : String(err));
    }
  }
  const text = await file.text();
  try {
    return deserializeProject(text);
  } catch (err) {
    if (err instanceof ProjectLoadError) throw err;
    throw new ProjectLoadError(err instanceof Error ? err.message : String(err));
  }
}

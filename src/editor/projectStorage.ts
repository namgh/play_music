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

const AUTOSAVE_KEY = 'project-autosave-v1';

/** 파일 이름으로 쓸 수 없는 문자를 정리한다 */
export function projectFileName(project: Project): string {
  const base = project.name.trim().replace(/[/\\?%*:|"<>]/g, '-').slice(0, 60);
  return `${base || 'project'}.json`;
}

export function saveAutosave(project: Project): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serializeProject(project));
  } catch {
    // 용량 초과 등. 자동 저장 실패로 편집을 막지는 않는다
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

/** 파일에서 프로젝트를 읽는다. 실패 이유를 그대로 올려 보낸다 */
export async function readProjectFile(file: File): Promise<Project> {
  const text = await file.text();
  try {
    return deserializeProject(text);
  } catch (err) {
    if (err instanceof ProjectLoadError) throw err;
    throw new ProjectLoadError(err instanceof Error ? err.message : String(err));
  }
}

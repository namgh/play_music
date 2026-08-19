/**
 * 클라우드 저장 — 곡 목록·열기·저장.
 *
 * **저장은 `If-Match` 낙관적 잠금이다** (`server/app/api/v1/projects.py`).
 * 헤더가 없으면 서버가 거절한다 — 없으면 덮어쓰기가 기본값이 되고 그건 데이터
 * 손실이다. 충돌(409)이 나면 서버가 **현재 문서를 실어서** 주므로, 화면은
 * "다른 곳에서 먼저 저장됨"을 보여주고 사용자가 고를 수 있게 한다.
 */

import { request } from './client.ts';
import { ApiError } from './errors.ts';

export type ProjectSummary = {
  id: string;
  org_id: string;
  name: string;
  updated_at: string;
  head_version_id: string | null;
  bpm: number | null;
  key_tonic: string | null;
  key_mode: string | null;
  length_bars: number | null;
  track_count: number | null;
  instrument_ids: string[];
};

export type ProjectDetail = ProjectSummary & {
  document: Record<string, unknown> | null;
  seq: number;
};

export type ProjectList = { items: ProjectSummary[]; next_cursor: string | null };

export function listProjects(cursor?: string): Promise<ProjectList> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return request<ProjectList>(`/v1/projects${q}`);
}

export function listTrash(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>('/v1/projects/trash');
}

export function createProject(
  name: string,
  document: Record<string, unknown>,
  orgId?: string,
): Promise<ProjectDetail> {
  return request<ProjectDetail>('/v1/projects', {
    method: 'POST',
    body: { name, document, org_id: orgId ?? null },
  });
}

export function openProject(id: string): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/v1/projects/${id}`);
}

export type SaveResult =
  | { ok: true; project: ProjectDetail }
  | { ok: false; conflict: ProjectDetail | null; error: ApiError };

/**
 * 저장. **충돌을 예외가 아니라 결과로 돌려준다.**
 *
 * 충돌은 오류가 아니라 정상적으로 일어나는 일이다(다른 탭, 다른 기기). 예외로
 * 던지면 호출부가 try/catch 로 감싸다 실수로 삼키게 되고, 그러면 사용자는 저장이
 * 된 줄 안다.
 */
export async function saveProject(
  id: string,
  expectedHeadVersionId: string,
  document: Record<string, unknown>,
  name?: string,
): Promise<SaveResult> {
  try {
    const project = await request<ProjectDetail>(`/v1/projects/${id}`, {
      method: 'PUT',
      body: name === undefined ? { document } : { document, name },
      headers: { 'If-Match': expectedHeadVersionId },
    });
    return { ok: true, project };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      // 서버가 현재 문서를 실어 보낸다 — 사용자가 비교할 수 있어야 한다
      const current = (e.details?.current as ProjectDetail | undefined) ?? null;
      return { ok: false, conflict: current, error: e };
    }
    throw e;
  }
}

export function renameProject(id: string, name: string): Promise<ProjectSummary> {
  return request<ProjectSummary>(`/v1/projects/${id}`, { method: 'PATCH', body: { name } });
}

export function deleteProject(id: string): Promise<void> {
  return request<void>(`/v1/projects/${id}`, { method: 'DELETE' });
}

export function restoreProject(id: string): Promise<ProjectSummary> {
  return request<ProjectSummary>(`/v1/projects/${id}/restore`, { method: 'POST' });
}

export function duplicateProject(id: string): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/v1/projects/${id}/duplicate`, { method: 'POST' });
}

/**
 * 내 계정 + 워크스페이스 + 플랜 + 사용량 — **첫 화면이 필요한 것을 한 번에** 받는다.
 *
 * 나눠서 네 번 부르면 그 넷이 서로 다른 시점을 보여 주고, 첫 렌더가 어긋나 보인다
 * (`server/app/api/v1/me.py`).
 */

import { request } from './client.ts';

export type Workspace = {
  id: string;
  slug: string;
  name: string;
  kind: 'personal' | 'team';
  my_role: 'owner' | 'admin' | 'editor' | 'viewer';
  plan_code: string;
  commercial_license: boolean;
  /** `null` 은 **무제한**이다. 0 과 헷갈리지 말 것 */
  limits: Record<string, number | null>;
  usage: Record<string, number>;
};

export type Me = {
  id: string;
  email: string;
  display_name: string;
  status: string;
  platform_role: string;
  email_verified: boolean;
  auth_providers: string[];
  created_at: string;
  workspaces: Workspace[];
};

export function fetchMe(): Promise<Me> {
  return request<Me>('/v1/me');
}

export function updateDisplayName(displayName: string): Promise<Me> {
  return request<Me>('/v1/me', { method: 'PATCH', body: { display_name: displayName } });
}

/** 무료 체험을 몇 곡 남겼나. 무제한이면 `null` */
export function songsRemaining(ws: Workspace): number | null {
  const limit = ws.limits.songs_total;
  if (limit === null || limit === undefined) return null;
  return Math.max(0, limit - (ws.usage.songs_total ?? 0));
}

/** 비밀번호 바꾸기 — 지금 비밀번호를 같이 보낸다. 새 비밀번호는 10자 이상 (서버 규칙) */
export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request<void>('/v1/me/password', { method: 'POST', body: { current_password: currentPassword, new_password: newPassword } });
}

/** 모든 기기에서 로그아웃 — 잃어버린 기기가 있을 때. 이 기기도 같이 나간다 */
export function logoutEverywhere(): Promise<void> {
  return request<void>('/v1/auth/logout-all', { method: 'POST', noRetry: true });
}

/** 서버가 받는 확인 문구. 화면이 이 글자를 그대로 치게 한다 */
export const DELETE_CONFIRM = '삭제합니다';

/** 탈퇴 — 바로 지우지 않고 유예 기간에 들어간다 (그 안에 로그인하면 되살릴 수 있다) */
export function deleteAccount(password: string | null): Promise<void> {
  return request<void>('/v1/me/delete', { method: 'POST', body: { password, confirm: DELETE_CONFIRM } });
}

export type Storage = { used_bytes: number; limit_bytes: number | null; asset_count: number };

export function fetchStorage(): Promise<Storage> {
  return request<Storage>('/v1/storage');
}

/** 용량을 사람이 읽는 글로 — 1536 → "1.5 KB" */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 새 비밀번호가 받아들여질지 — 서버에 보내기 전에 화면에서 먼저 말해 준다. 괜찮으면 null */
export function passwordProblem(next: string, again: string): string | null {
  if (next.length < 10) return '새 비밀번호는 10자 이상이어야 합니다';
  if (next !== again) return '새 비밀번호 두 칸이 다릅니다';
  return null;
}

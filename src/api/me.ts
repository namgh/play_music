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

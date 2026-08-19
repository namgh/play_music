/**
 * 계정 — 가입·로그인·이메일 확인·비밀번호 재설정·초대 수락.
 *
 * 메일로 나가는 링크(`/verify`, `/reset`, `/invite`)가 여기로 들어온다.
 * 화면이 없으면 그 링크는 그냥 깨진 주소다.
 */

import { request, forgetSession } from './client.ts';
import { setSession, type Session, type TokenOut } from './session.ts';

export async function signup(email: string, password: string): Promise<Session | null> {
  const token = await request<TokenOut>('/v1/auth/signup', {
    method: 'POST',
    body: { email, password },
    // 가입 실패(이미 있는 주소)에 갱신을 시도할 이유가 없다
    noRetry: true,
  });
  return setSession(token);
}

export async function login(email: string, password: string): Promise<Session | null> {
  const token = await request<TokenOut>('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
    noRetry: true,
  });
  return setSession(token);
}

export async function logout(): Promise<void> {
  try {
    await request<void>('/v1/auth/logout', { method: 'POST', noRetry: true });
  } finally {
    // 서버가 실패해도 **화면에서는 반드시 로그아웃된다.** 남의 컴퓨터에서
    // 로그아웃을 눌렀는데 안 되는 것이 제일 나쁘다
    forgetSession();
  }
}

export async function verifyEmail(token: string): Promise<void> {
  await request<void>('/v1/auth/verify-email', {
    method: 'POST',
    body: { token },
    noRetry: true,
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await request<void>('/v1/auth/forgot-password', {
    method: 'POST',
    body: { email },
    noRetry: true,
  });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await request<void>('/v1/auth/reset-password', {
    method: 'POST',
    body: { token, password },
    noRetry: true,
  });
}

export async function acceptInvite(token: string): Promise<{ org_id: string }> {
  return request('/v1/orgs/invites/accept', { method: 'POST', body: { token } });
}

/** 구글 로그인은 서버가 리다이렉트를 주도한다 — 우리는 보내기만 한다 */
export function googleLoginUrl(): string {
  return '/v1/auth/google/start';
}

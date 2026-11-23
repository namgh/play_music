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

interface DesktopBridge {
  /** 시스템 브라우저에서 구글 로그인을 하고, 앱으로 돌아온 한 번짜리 코드를 준다 */
  googleLogin?: () => Promise<{ code: string; verifier: string }>;
}

/**
 * 구글로 로그인 — **로그인 수단은 이것 하나다** (2026-11-24).
 *
 * - 웹: 서버에서 구글 주소를 받아 그리로 간다. 돌아오면 서버가 리프레시 쿠키를 심어 두었고
 *   앱이 켜지면서 `refresh` 로 세션을 받는다. (이 함수는 돌아오지 않는다)
 * - 설치형: 앱 창이 아니라 **시스템 브라우저**에서 로그인한다 (구글이 내장 창의 로그인을 막고,
 *   사용자도 주소창이 보여야 진짜 구글인지 안다). 껍데기가 127.0.0.1 로 돌아온 코드를 받아 주면
 *   여기서 세션으로 바꾼다.
 */
export async function loginWithGoogle(): Promise<Session | null> {
  const bridge = (globalThis as { resona?: DesktopBridge }).resona;
  if (bridge?.googleLogin) {
    const { code, verifier } = await bridge.googleLogin();
    const token = await request<TokenOut>('/v1/auth/desktop/exchange', {
      method: 'POST',
      body: { code, verifier },
      noRetry: true,
    });
    return setSession(token);
  }
  const { authorization_url } = await request<{ authorization_url: string }>('/v1/auth/google/start', { noRetry: true });
  window.location.assign(authorization_url);
  return null;
}

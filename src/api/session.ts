/**
 * 로그인 세션 — **액세스 토큰은 메모리에만 둔다.**
 *
 * `localStorage` 에 넣지 않는다. 거기 있는 값은 XSS 한 번이면 통째로 새어 나가고,
 * 그러면 사용자가 로그아웃해도 공격자는 토큰 수명만큼 계속 들어온다. 메모리에 두면
 * 탭이 닫히는 순간 사라진다.
 *
 * 리프레시 토큰은 **httpOnly 쿠키**라 JS 가 읽지 못한다 (`server/app/api/v1/auth.py`,
 * path=`/v1/auth`). 새로고침하면 액세스 토큰은 사라지지만 쿠키는 남아 있으므로,
 * 앱이 뜰 때 `/v1/auth/refresh` 를 한 번 불러 세션을 되살린다.
 */

import { ApiError } from './errors.ts';

export type Session = {
  accessToken: string;
  userId: string;
  /** 'pending_verification' | 'active' | 'suspended' | 'deleted' */
  status: string;
  /** epoch ms. 만료 직전에 미리 갱신하는 데 쓴다 */
  expiresAt: number;
};

export type TokenOut = {
  access_token: string;
  expires_in: number;
  user_id: string;
  status: string;
};

let current: Session | null = null;
let listeners: Array<(s: Session | null) => void> = [];

/**
 * **동시에 두 번 갱신하지 않기 위한 자물쇠.**
 *
 * 서버는 리프레시 토큰 재사용을 탈취로 보고 **그 계정의 전 세션을 끊는다**
 * (`refresh_tokens.rotated_from`). 요청 세 개가 한꺼번에 401 을 받아 각자 갱신을
 * 부르면, 같은 쿠키 값이 두 번 가고 두 번째가 재사용으로 판정되어 **멀쩡한
 * 사용자가 강제 로그아웃된다.** 그래서 갱신은 언제나 하나만 날아간다.
 *
 * 탭이 여러 개면 이 자물쇠가 닿지 않는다 — 그건 남은 한계이고,
 * 갱신을 401 이 났을 때만 하도록 좁혀 확률을 낮춰 둔다.
 */
let inFlight: Promise<Session | null> | null = null;

export function getSession(): Session | null {
  return current;
}

export function setSession(token: TokenOut | null): Session | null {
  current = token
    ? {
        accessToken: token.access_token,
        userId: token.user_id,
        status: token.status,
        expiresAt: Date.now() + token.expires_in * 1000,
      }
    : null;
  for (const fn of listeners) fn(current);
  return current;
}

export function onSessionChange(fn: (s: Session | null) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

/** 테스트가 상태를 초기화할 수 있게 */
export function resetSessionForTest(): void {
  current = null;
  inFlight = null;
  listeners = [];
}

type Refresher = () => Promise<TokenOut | null>;

/**
 * 리프레시 쿠키로 액세스 토큰을 다시 받는다. **동시에 불러도 한 번만 나간다.**
 *
 * 실패하면 `null` 을 돌려주고 세션을 비운다 — 로그인 화면으로 보내라는 뜻이다.
 */
export async function refreshSession(refresher: Refresher): Promise<Session | null> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const token = await refresher();
      return setSession(token);
    } catch (e) {
      // 401 은 "쿠키가 없거나 만료됐다" — 정상적인 로그아웃 상태다.
      // 그 밖의 오류(네트워크 등)까지 세션을 비우면, 잠깐 끊겼다고 로그아웃된다
      if (e instanceof ApiError && e.status === 401) {
        setSession(null);
        return null;
      }
      throw e;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

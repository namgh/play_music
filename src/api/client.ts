/**
 * 서버 호출의 유일한 출입구.
 *
 * 여기 하나로 모으는 이유는 **401 처리와 토큰 갱신을 한 곳에서만 하기 위해서**다.
 * 화면마다 `fetch` 를 부르면 갱신 로직이 여기저기 복제되고, 그러면 리프레시 토큰이
 * 동시에 두 번 나가 계정 전체가 로그아웃되는 사고가 난다 (`session.ts` 참고).
 */

import { ApiError, toApiError } from './errors.ts';
import { getSession, refreshSession, setSession, type TokenOut } from './session.ts';

/** 개발에서는 vite 프록시가 `/v1` 을 8000 번으로 넘긴다 (`vite.config.ts`) */
const BASE = (import.meta.env?.VITE_API_BASE ?? '').replace(/\/$/, '');

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** 테스트가 네트워크 대신 가짜를 물릴 수 있게 한다 */
export function setFetchForTest(f: FetchLike | null): void {
  fetchImpl = f ?? ((input, init) => fetch(input, init));
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** 401 을 받아도 갱신을 시도하지 않는다 (로그인·갱신 자체에 쓴다) */
  noRetry?: boolean;
  signal?: AbortSignal;
};

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const session = getSession();
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;

  // `exactOptionalPropertyTypes` 아래에서는 **키를 `undefined` 로 넣는 것과 키가
  // 없는 것이 다르다.** 있는 값만 붙인다
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    // 리프레시 쿠키를 실어 보내려면 필요하다. 쿠키 자체가 `/v1/auth` 로
    // 경로 제한돼 있어서 다른 요청에는 붙지 않는다
    credentials: 'include',
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  if (opts.signal) init.signal = opts.signal;

  try {
    return await fetchImpl(`${BASE}${path}`, init);
  } catch (e) {
    // `fetch` 는 네트워크 실패에서만 throw 한다 — 4xx·5xx 는 정상 반환이다
    throw ApiError.offline(e);
  }
}

/** 갱신 요청 자체는 `request` 를 쓰지 않는다 — 무한 재귀가 된다 */
async function callRefresh(): Promise<TokenOut | null> {
  const res = await send('/v1/auth/refresh', { method: 'POST', noRetry: true });
  const body = await parse(res);
  if (!res.ok) throw toApiError(res.status, body);
  return body as TokenOut;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts);

  if (res.status === 401 && !opts.noRetry) {
    // 액세스 토큰이 만료됐을 수 있다. **한 번만** 갱신하고 다시 시도한다
    const revived = await refreshSession(callRefresh);
    if (!revived) {
      throw toApiError(401, await parse(res));
    }
    res = await send(path, opts);
  }

  const body = await parse(res);
  if (!res.ok) throw toApiError(res.status, body);
  return body as T;
}

/**
 * 앱이 뜰 때 한 번 부른다. 쿠키가 살아 있으면 로그인 상태가 복구된다.
 * 없으면 조용히 비로그인으로 둔다 — 첫 화면에 오류를 띄울 일이 아니다.
 */
export async function restoreSession(): Promise<boolean> {
  try {
    return (await refreshSession(callRefresh)) !== null;
  } catch {
    return false;
  }
}

export function forgetSession(): void {
  setSession(null);
}

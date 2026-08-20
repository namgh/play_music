/**
 * 서버 호출 계층 — **401 처리와 토큰 갱신.**
 *
 * 여기가 틀리면 증상이 고약하다. 갱신이 동시에 두 번 나가면 서버가 그걸 **탈취로
 * 보고 전 세션을 끊는다** (`refresh_tokens.rotated_from`). 멀쩡한 사용자가 갑자기
 * 로그아웃되고, 재현이 어려워 원인을 찾는 데 오래 걸린다.
 *
 * 브라우저 없이 시험한다 — `fetch` 를 갈아 끼울 수 있게 만들어 뒀다.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { forgetSession, request, restoreSession, setFetchForTest } from './client.ts';
import { ApiError } from './errors.ts';
import { getSession, resetSessionForTest, setSession } from './session.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TOKEN = { access_token: 'a1', expires_in: 900, user_id: 'u1', status: 'active' };

beforeEach(() => {
  resetSessionForTest();
  setFetchForTest(null);
});

test('오류 봉투를 그대로 읽는다', async () => {
  setFetchForTest(async () =>
    json(402, { error: { code: 'song_limit_reached', message: '무료 5곡을 다 썼습니다' } }),
  );
  await assert.rejects(
    () => request('/v1/projects', { method: 'POST' }),
    (e: ApiError) => e.code === 'song_limit_reached' && e.status === 402,
  );
});

test('봉투가 아닌 응답에도 죽지 않는다', async () => {
  // 앞단(nginx·프록시)이 만든 502 는 우리 봉투가 아니다
  setFetchForTest(async () => new Response('<html>502</html>', { status: 502 }));
  await assert.rejects(() => request('/v1/me'), (e: ApiError) => e.status === 502);
});

test('네트워크 실패는 던지되 상태 0 으로 구분된다', async () => {
  setFetchForTest(async () => { throw new TypeError('failed to fetch'); });
  await assert.rejects(
    () => request('/v1/me'),
    (e: ApiError) => e.status === 0 && e.code === 'network_unreachable',
  );
});

test('401 을 받으면 한 번 갱신하고 다시 시도한다', async () => {
  setSession(TOKEN);
  const calls: string[] = [];
  setFetchForTest(async (url) => {
    calls.push(url);
    if (url.endsWith('/v1/auth/refresh')) return json(200, { ...TOKEN, access_token: 'a2' });
    return calls.filter((c) => c.endsWith('/v1/me')).length === 1
      ? json(401, { error: { code: 'token_expired', message: '만료' } })
      : json(200, { id: 'u1' });
  });

  const me = await request<{ id: string }>('/v1/me');
  assert.equal(me.id, 'u1');
  assert.equal(getSession()?.accessToken, 'a2', '새 토큰으로 갈아 끼워야 한다');
  assert.deepEqual(calls.map((c) => c.replace(/^.*\/v1/, '/v1')), [
    '/v1/me', '/v1/auth/refresh', '/v1/me',
  ]);
});

test('⚠ 동시에 401 이 여럿 나도 갱신은 한 번만 나간다', async () => {
  // **이게 이 파일에서 가장 중요한 시험이다.** 갱신이 두 번 나가면 서버가 재사용으로
  // 판정해 전 세션을 끊는다 — 아무 잘못 없는 사용자가 로그아웃된다
  setSession(TOKEN);
  let refreshes = 0;
  const seen = new Set<string>();

  setFetchForTest(async (url) => {
    if (url.endsWith('/v1/auth/refresh')) {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 10)); // 왕복 시간을 흉내
      return json(200, { ...TOKEN, access_token: 'fresh' });
    }
    if (!seen.has(url)) { seen.add(url); return json(401, { error: { code: 'x', message: 'x' } }); }
    return json(200, { ok: true });
  });

  await Promise.all([
    request('/v1/projects'),
    request('/v1/me'),
    request('/v1/orgs'),
  ]);
  assert.equal(refreshes, 1, `갱신이 ${refreshes}번 나갔다 — 전 세션이 끊긴다`);
});

test('갱신이 401 이면 로그아웃 상태가 된다', async () => {
  setSession(TOKEN);
  setFetchForTest(async (url) =>
    url.endsWith('/v1/auth/refresh')
      ? json(401, { error: { code: 'no_cookie', message: '없음' } })
      : json(401, { error: { code: 'token_expired', message: '만료' } }),
  );

  await assert.rejects(() => request('/v1/me'));
  assert.equal(getSession(), null, '되살릴 수 없으면 세션을 비운다');
});

test('갱신이 네트워크 오류면 세션을 비우지 않는다', async () => {
  // 잠깐 끊겼다고 로그아웃시키면, 지하철에서 편집하던 사람이 매번 튕긴다
  setSession(TOKEN);
  setFetchForTest(async (url) => {
    if (url.endsWith('/v1/auth/refresh')) throw new TypeError('offline');
    return json(401, { error: { code: 'token_expired', message: '만료' } });
  });

  await assert.rejects(() => request('/v1/me'));
  assert.notEqual(getSession(), null, '네트워크 문제로 세션을 버리면 안 된다');
});

test('로그인·갱신 자체는 401 에 재시도하지 않는다', async () => {
  // 비밀번호가 틀린 것을 갱신으로 되살릴 수는 없다 — 무한 왕복만 생긴다
  let calls = 0;
  setFetchForTest(async () => {
    calls += 1;
    return json(401, { error: { code: 'invalid_credentials', message: '틀림' } });
  });
  await assert.rejects(() => request('/v1/auth/login', { method: 'POST', noRetry: true }));
  assert.equal(calls, 1);
});

test('앱이 뜰 때 쿠키가 없으면 조용히 비로그인이다', async () => {
  // 첫 화면에 오류를 띄울 일이 아니다
  setFetchForTest(async () => json(401, { error: { code: 'no_cookie', message: '없음' } }));
  assert.equal(await restoreSession(), false);
  assert.equal(getSession(), null);
});

test('앱이 뜰 때 쿠키가 있으면 로그인 상태가 복구된다', async () => {
  setFetchForTest(async () => json(200, TOKEN));
  assert.equal(await restoreSession(), true);
  assert.equal(getSession()?.userId, 'u1');
});

test('로그아웃은 메모리에서 토큰을 지운다', () => {
  setSession(TOKEN);
  forgetSession();
  assert.equal(getSession(), null);
});

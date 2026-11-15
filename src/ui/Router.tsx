/**
 * 주소 → 화면.
 *
 * 앱이 뜰 때 **세션을 한 번 되살린다.** 액세스 토큰은 메모리에만 있어서
 * 새로고침하면 사라지지만, 리프레시 쿠키는 남아 있다 (`api/session.ts`).
 * 그걸 한 번 교환해 주지 않으면 새로고침할 때마다 로그아웃된 것처럼 보인다.
 */

import { useEffect, useState } from 'react';

import { restoreSession } from '../api/client.ts';
import { App } from '../App.tsx';
import {
  AcceptInviteScreen,
  AuthScreen,
  ResetPasswordScreen,
  VerifyEmailScreen,
} from './auth/AuthScreens.tsx';
import { parseRoute, type Route } from './route.ts';

function currentRoute(): Route {
  return parseRoute(window.location.pathname, window.location.search);
}

export function Router() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    // **세션 복구가 끝나기 전에는 편집기를 그리지 않는다.** 먼저 그리면
    // "로그인 안 됨"이 잠깐 보였다가 바뀌어서, 멀쩡히 로그인된 사용자가
    // 로그아웃된 줄 알고 다시 로그인하러 간다
    restoreSession().finally(() => setReady(true));
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 메일 링크는 세션과 무관하게 바로 처리한다 — 로그인 안 한 사람이 여는 것이 정상이다
  switch (route.name) {
    case 'verify':
      return <VerifyEmailScreen token={route.token} />;
    case 'reset':
      return <ResetPasswordScreen token={route.token} />;
    case 'invite':
      return <AcceptInviteScreen token={route.token} />;
    case 'login':
      return <AuthScreen />;
    default:
      break;
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-body text-sm text-ink-3">
        불러오는 중…
      </div>
    );
  }
  return <App />;
}

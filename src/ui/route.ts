/**
 * 주소 해석 — **메일로 나간 링크가 도착하는 곳.**
 *
 * 라우터 라이브러리를 넣지 않았다. 경로가 다섯 개고 중첩이 없다. 스케줄러를
 * 직접 만든 것과 같은 이유다 — 이만한 것에 프레임워크를 들이면 그 프레임워크의
 * 사정까지 같이 안고 가게 된다.
 *
 * **순수 함수로 둔 이유**: 주소 해석이 틀리면 확인 메일과 비밀번호 재설정이
 * 통째로 죽는다. 그건 React 를 띄우지 않고 시험할 수 있어야 한다.
 */

export type Route =
  | { name: 'editor' }
  | { name: 'login' }
  | { name: 'verify'; token: string }
  | { name: 'reset'; token: string }
  | { name: 'invite'; token: string };

/**
 * 토큰이 필요한 경로에서 **토큰이 없으면 편집기로 보낸다.**
 *
 * 빈 토큰으로 화면을 띄우면 사용자가 "확인 실패"를 보게 되는데, 실패한 것은
 * 사용자가 아니라 링크다. 메일 앱이 URL 을 자르는 일은 실제로 흔하다.
 */
export function parseRoute(pathname: string, search = ''): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  const token = new URLSearchParams(search).get('token')?.trim() ?? '';

  switch (path) {
    case '/login':
      return { name: 'login' };
    case '/verify':
      return token ? { name: 'verify', token } : { name: 'editor' };
    case '/reset':
      return token ? { name: 'reset', token } : { name: 'editor' };
    case '/invite':
      return token ? { name: 'invite', token } : { name: 'editor' };
    default:
      // **모르는 주소를 404 로 만들지 않는다.** 음악을 만들러 온 사람에게
      // 빈 화면을 보여 줄 이유가 없다 — 편집기로 보낸다
      return { name: 'editor' };
  }
}

/** 주소창을 바꾸되 새로고침은 하지 않는다 (편집 중인 곡이 날아가면 안 된다) */
export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * 토큰을 주소창에서 지운다.
 *
 * 확인·재설정 토큰이 주소창에 남으면 어깨너머로 보이고, 브라우저 기록과
 * 리퍼러에도 남는다. 화면에 도착한 뒤에는 더 필요 없으므로 즉시 지운다.
 */
export function stripToken(): void {
  window.history.replaceState({}, '', window.location.pathname);
}

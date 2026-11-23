/**
 * 계정 화면 — 로그인·가입·비밀번호 재설정·메일 확인·초대 수락.
 *
 * **여기서 문구를 지어내지 않는다.** 서버가 준 `message` 를 그대로 보여 준다.
 * 화면이 따로 문장을 들고 있으면 서버가 문구를 고쳐도 반영이 안 되고, 두 곳이
 * 서로 다른 말을 하게 된다. 화면이 판단하는 것은 `code` 뿐이다.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { ApiError } from '../../api/errors.ts';
import {
  acceptInvite,
  loginWithGoogle,
  resetPassword,
  verifyEmail,
} from '../../api/auth.ts';
import { navigate, stripToken } from '../route.ts';
import { platformInfo } from '../../platform/platform.ts';

const field =
  'w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm ' +
  'outline-none focus:border-neutral-500';
const primary =
  'w-full rounded bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 ' +
  'disabled:opacity-40';
const ghost = 'text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-200';

function Shell({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-neutral-100">
      <div className="w-full max-w-sm space-y-5">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{title}</h1>
          {hint && <p className="text-sm text-neutral-400">{hint}</p>}
        </div>
        {children}
        <button type="button" onClick={() => navigate('/')} className={ghost}>
          편집기로 돌아가기
        </button>
      </div>
    </div>
  );
}

function Message({ error, ok }: { error?: string | null; ok?: string | null }) {
  if (!error && !ok) return null;
  return (
    <p className={`text-sm ${error ? 'text-red-400' : 'text-emerald-400'}`}>{error ?? ok}</p>
  );
}

/** 서버 메시지를 그대로 쓰되, 네트워크 실패만 화면이 말한다 */
function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return '요청을 보내지 못했습니다';
}

// --- 로그인 · 가입 -----------------------------------------------------------

export function AuthScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => (
    new URLSearchParams(window.location.search).get('error') ? '로그인을 마치지 못했습니다. 다시 해 주세요' : null
  ));
  const desktop = platformInfo().kind === 'desktop';

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // 웹은 구글로 넘어가서 돌아오지 않는다. 설치형은 브라우저에서 마치면 여기로 돌아온다
      const session = await loginWithGoogle();
      if (session) navigate('/');
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  return (
    <Shell
      title="로그인"
      hint="계정 없이도 곡은 만들 수 있습니다. 로그인하면 클라우드에 저장됩니다."
    >
      <Message error={error} />
      <button type="button" disabled={busy} onClick={() => void start()} className={primary} data-google-login>
        {busy ? (desktop ? '브라우저에서 로그인을 마쳐 주세요…' : '구글로 가는 중…') : '구글로 계속하기'}
      </button>
      {busy && desktop && (
        <button type="button" className={ghost} onClick={() => setBusy(false)}>다시 시도</button>
      )}
      <p className="text-xs text-neutral-500">
        처음이면 계정이 바로 만들어집니다. 비밀번호는 따로 만들지 않습니다.
      </p>
    </Shell>
  );
}

// --- 메일 확인 ---------------------------------------------------------------

export function VerifyEmailScreen({ token }: { token: string }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // **토큰을 주소창에서 지운다** — 어깨너머·기록·리퍼러로 새는 것을 막는다
    stripToken();
    verifyEmail(token)
      .then(() => setState('done'))
      .catch((e) => { setError(messageOf(e)); setState('failed'); });
  }, [token]);

  return (
    <Shell title="이메일 확인">
      {state === 'working' && <p className="text-sm text-neutral-400">확인하는 중…</p>}
      {state === 'done' && <Message ok="확인됐습니다. 이제 전부 사용할 수 있습니다" />}
      {state === 'failed' && (
        <div className="space-y-2">
          <Message error={error} />
          <p className="text-sm text-neutral-400">
            링크는 한 번만 쓸 수 있고 기한이 있습니다. 로그인 후 다시 받을 수 있습니다.
          </p>
        </div>
      )}
    </Shell>
  );
}

// --- 비밀번호 재설정 ---------------------------------------------------------

export function ResetPasswordScreen({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => { stripToken(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Shell title="비밀번호 변경됨" hint="다른 기기의 로그인은 모두 해제됐습니다.">
        <button type="button" onClick={() => navigate('/login')} className={primary}>
          로그인하기
        </button>
      </Shell>
    );
  }

  return (
    <Shell title="새 비밀번호">
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="새 비밀번호 (10자 이상)"
          autoComplete="new-password"
          minLength={10}
          required
          className={field}
        />
        <Message error={error} />
        <button type="submit" disabled={busy} className={primary}>
          {busy ? '바꾸는 중…' : '비밀번호 바꾸기'}
        </button>
      </form>
    </Shell>
  );
}

// --- 초대 수락 ---------------------------------------------------------------

export function AcceptInviteScreen({ token }: { token: string }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    stripToken();
    acceptInvite(token)
      .then(() => setState('done'))
      .catch((e) => {
        // 로그인해야 수락할 수 있다 — 그때는 로그인 화면으로 보내는 것이 맞다
        if (e instanceof ApiError && e.status === 401) {
          navigate('/login');
          return;
        }
        setError(messageOf(e));
        setState('failed');
      });
  }, [token]);

  return (
    <Shell title="워크스페이스 초대">
      {state === 'working' && <p className="text-sm text-neutral-400">수락하는 중…</p>}
      {state === 'done' && <Message ok="참여했습니다" />}
      {state === 'failed' && <Message error={error} />}
    </Shell>
  );
}

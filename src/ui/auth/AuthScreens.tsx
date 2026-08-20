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
  googleLoginUrl,
  login,
  requestPasswordReset,
  resetPassword,
  signup,
  verifyEmail,
} from '../../api/auth.ts';
import { navigate, stripToken } from '../route.ts';

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
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      if (mode === 'signup') {
        await signup(email, password);
        setOk('가입했습니다. 확인 메일을 보냈습니다');
      } else {
        await login(email, password);
      }
      navigate('/');
    } catch (err) {
      // **이미 있는 주소로 가입하면 서버가 토큰을 주지 않는다** (계정 탈취 방지).
      // 그때는 로그인 쪽으로 안내하는 것이 맞다
      if (err instanceof ApiError && err.code === 'email_taken') {
        setMode('login');
        setError('이미 가입된 주소입니다. 로그인해 주세요');
      } else {
        setError(messageOf(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    if (!email) {
      setError('주소를 먼저 입력해 주세요');
      return;
    }
    setError(null);
    try {
      await requestPasswordReset(email);
      // **계정이 있든 없든 같은 문구다.** 다르게 말하면 가입 여부를 알려 주는 셈이다
      setOk('재설정 메일을 보냈습니다. 받은 편지함을 확인해 주세요');
    } catch (err) {
      setError(messageOf(err));
    }
  };

  return (
    <Shell
      title={mode === 'login' ? '로그인' : '가입'}
      hint="계정 없이도 편집기는 그대로 씁니다. 로그인하면 클라우드에 저장됩니다."
    >
      <form onSubmit={submit} className="space-y-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="이메일"
          autoComplete="email"
          required
          className={field}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="비밀번호"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          // 서버가 10자 이상을 요구한다 — 여기서 막아 주면 왕복이 한 번 준다
          minLength={mode === 'signup' ? 10 : undefined}
          required
          className={field}
        />
        <Message error={error} ok={ok} />
        <button type="submit" disabled={busy} className={primary}>
          {busy ? '보내는 중…' : mode === 'login' ? '로그인' : '가입'}
        </button>
      </form>

      <a href={googleLoginUrl()} className="block w-full rounded border border-neutral-700 px-3 py-2 text-center text-sm">
        구글로 계속하기
      </a>

      <div className="flex items-center justify-between">
        <button
          type="button"
          className={ghost}
          onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setOk(null); }}
        >
          {mode === 'login' ? '계정 만들기' : '로그인하기'}
        </button>
        {mode === 'login' && (
          <button type="button" className={ghost} onClick={forgot}>
            비밀번호를 잊었나요
          </button>
        )}
      </div>
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

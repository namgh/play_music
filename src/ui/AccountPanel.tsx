/**
 * 계정 — 로그인 상태가 **늘 보이는 자리**(머리 줄 프로필 단추)에서 여는 창.
 *
 * 서버에는 비밀번호 변경·모든 기기 로그아웃·탈퇴가 이미 있었는데 누를 곳이 없었다
 * (2026-11-22). 로그인하지 않아도 편집기는 그대로 돈다 — 여기는 "얹는 것"이다.
 */
import { useEffect, useState } from 'react';

import { logout } from '../api/auth.ts';
import { forgetSession } from '../api/client.ts';
import { ApiError } from '../api/errors.ts';
import {
  changePassword, deleteAccount, DELETE_CONFIRM, fetchMe, fetchStorage, formatBytes, logoutEverywhere,
  passwordProblem, songsRemaining, updateDisplayName, type Me, type Storage,
} from '../api/me.ts';
import { getSession, onSessionChange } from '../api/session.ts';
import { platformInfo } from '../platform/platform.ts';
import { navigate } from './route.ts';

const FIELD = 'h-8 w-full rounded-md border border-rule bg-panel px-2.5 text-sm text-ink';
const BTN = 'h-8 shrink-0 rounded-md border border-rule bg-panel px-3 text-xs text-ink hover:border-ink-3 disabled:opacity-40';
const H3 = 'mb-2 text-[11px] font-semibold text-ink-3';

/** 로그인 상태를 따라가는 훅 — 프로필 단추와 창이 같이 쓴다 */
export function useAccount(): { signedIn: boolean; me: Me | null; reload: () => void } {
  const [signedIn, setSignedIn] = useState(getSession() !== null);
  const [me, setMe] = useState<Me | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onSessionChange((s) => setSignedIn(s !== null)), []);
  useEffect(() => {
    if (!signedIn) { setMe(null); return; }
    let alive = true;
    fetchMe().then((m) => { if (alive) setMe(m); }).catch(() => { /* 서버가 없어도 편집기는 돈다 */ });
    return () => { alive = false; };
  }, [signedIn, tick]);
  return { signedIn, me, reload: () => setTick((t) => t + 1) };
}

/** 프로필 단추에 넣을 글자 — 이름 첫 글자, 없으면 메일 첫 글자 */
export function initialOf(me: Me | null): string {
  const source = (me?.display_name || me?.email || '').trim();
  return source ? [...source][0]!.toUpperCase() : '';
}

export function AccountPanel({ me, signedIn, onReload, onClose, onNotice }: {
  me: Me | null; signedIn: boolean; onReload: () => void; onClose: () => void; onNotice: (text: string) => void;
}) {
  const [name, setName] = useState(me?.display_name ?? '');
  const [storage, setStorage] = useState<Storage | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [confirm, setConfirm] = useState('');
  const [delPassword, setDelPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setName(me?.display_name ?? ''); }, [me?.display_name]);
  useEffect(() => { if (signedIn) fetchStorage().then(setStorage).catch(() => setStorage(null)); }, [signedIn]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError(e instanceof ApiError ? e.message : '요청을 처리하지 못했습니다 — 서버에 닿지 않습니다'); } finally { setBusy(false); }
  };
  const hasPassword = me ? me.auth_providers.includes('password') || me.auth_providers.length === 0 : true;
  const ws = me?.workspaces[0];
  const left = ws ? songsRemaining(ws) : null;
  const pwProblem = next || again ? passwordProblem(next, again) : null;
  const desktop = platformInfo().kind === 'desktop';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6" onClick={onClose}>
      <div role="dialog" aria-label="계정" onClick={(e) => e.stopPropagation()}
        className="scope-body flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-rule bg-body shadow-2xl">
        <div className="flex items-center gap-2 border-b border-rule px-5 py-3">
          <h2 className="font-disp text-lg text-ink">계정</h2>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={BTN}>닫기</button>
        </div>

        {!signedIn ? (
          <div className="space-y-3 p-5 text-sm text-ink-2">
            <p>로그인하지 않아도 곡을 만들고 이 {desktop ? '컴퓨터' : '브라우저'}에 저장하고 내보낼 수 있습니다.</p>
            <p>로그인하면 곡을 서버에 저장해 다른 기기에서 이어서 할 수 있습니다.</p>
            <button type="button" data-account-login onClick={() => { onClose(); navigate('/login'); }}
              className="h-9 rounded-full bg-cta px-5 text-[13px] font-semibold text-cta-ink">로그인 · 가입</button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5 text-sm text-ink">
            {error && <p role="alert" className="rounded-lg border border-rec bg-rec/10 px-3 py-2 text-xs text-ink">{error}</p>}

            <section>
              <h3 className={H3}>프로필</h3>
              <p className="mb-2 text-xs text-ink-2">
                {me?.email ?? '불러오는 중…'}
                {me && (me.email_verified
                  ? <span className="ml-2 text-ink-3">메일 확인됨</span>
                  : <span className="ml-2 font-semibold text-rec">메일 확인 전 — 받은 편지함의 링크를 눌러 주세요</span>)}
              </p>
              <div className="flex items-center gap-2">
                <input aria-label="표시 이름" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className={FIELD} />
                <button type="button" className={BTN} disabled={busy || !name.trim() || name === me?.display_name}
                  onClick={() => run(async () => { await updateDisplayName(name.trim()); onReload(); onNotice('이름을 바꿨습니다'); })}>이름 저장</button>
              </div>
            </section>

            <section>
              <h3 className={H3}>플랜 · 사용량</h3>
              <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-xs">
                <dt className="text-ink-3">플랜</dt>
                <dd>{ws ? `${ws.plan_code}${ws.commercial_license ? ' · 상업 이용 가능' : ''}` : '—'}</dd>
                <dt className="text-ink-3">곡</dt>
                <dd>{ws ? (left === null ? '무제한' : `${ws.usage.songs_total ?? 0}곡 만듦 · ${left}곡 더 만들 수 있음`) : '—'}</dd>
                <dt className="text-ink-3">저장 용량</dt>
                <dd>{storage ? `${formatBytes(storage.used_bytes)}${storage.limit_bytes === null ? '' : ` / ${formatBytes(storage.limit_bytes)}`} · 파일 ${storage.asset_count}개` : '—'}</dd>
              </dl>
              <p className="mt-2 text-[11px] text-ink-3">한도에 닿아도 이미 만든 곡은 계속 편집하고 내보낼 수 있습니다.</p>
            </section>

            {hasPassword && (
              <section>
                <h3 className={H3}>비밀번호 바꾸기</h3>
                <div className="grid grid-cols-3 gap-2">
                  <input aria-label="지금 비밀번호" type="password" autoComplete="current-password" placeholder="지금 비밀번호" value={cur} onChange={(e) => setCur(e.target.value)} className={FIELD} />
                  <input aria-label="새 비밀번호" type="password" autoComplete="new-password" placeholder="새 비밀번호 (10자 이상)" value={next} onChange={(e) => setNext(e.target.value)} className={FIELD} />
                  <input aria-label="새 비밀번호 다시" type="password" autoComplete="new-password" placeholder="새 비밀번호 다시" value={again} onChange={(e) => setAgain(e.target.value)} className={FIELD} />
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <button type="button" className={BTN} disabled={busy || !cur || passwordProblem(next, again) !== null}
                    onClick={() => run(async () => { await changePassword(cur, next); setCur(''); setNext(''); setAgain(''); onNotice('비밀번호를 바꿨습니다'); })}>비밀번호 바꾸기</button>
                  {pwProblem && <span data-password-problem className="text-[11px] text-rec">{pwProblem}</span>}
                </div>
              </section>
            )}

            <section>
              <h3 className={H3}>로그인 세션</h3>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={BTN} disabled={busy}
                  onClick={() => run(async () => { await logout(); onClose(); onNotice('로그아웃했습니다 — 이 기기의 곡은 그대로 있습니다'); })}>로그아웃</button>
                <button type="button" className={BTN} disabled={busy}
                  onClick={() => run(async () => { try { await logoutEverywhere(); } finally { forgetSession(); } onClose(); onNotice('모든 기기에서 로그아웃했습니다'); })}>모든 기기에서 로그아웃</button>
                <span className="text-[11px] text-ink-3">기기를 잃어버렸으면 "모든 기기"를 누르세요</span>
              </div>
            </section>

            <section className="rounded-xl border border-rec/40 p-3">
              <h3 className={`${H3} text-rec`}>계정 삭제</h3>
              <p className="mb-2 text-xs text-ink-2">
                바로 지워지지 않고 유예 기간에 들어갑니다 — 그 안에 다시 로그인하면 되살릴 수 있습니다.
                계속하려면 아래에 <b>{DELETE_CONFIRM}</b> 를 그대로 쳐 주세요.
              </p>
              <div className="flex items-center gap-2">
                <input aria-label="삭제 확인 문구" placeholder={DELETE_CONFIRM} value={confirm} onChange={(e) => setConfirm(e.target.value)} className={FIELD} />
                {hasPassword && <input aria-label="삭제 확인 비밀번호" type="password" autoComplete="current-password" placeholder="비밀번호" value={delPassword} onChange={(e) => setDelPassword(e.target.value)} className={FIELD} />}
                <button type="button" data-delete-account disabled={busy || confirm !== DELETE_CONFIRM || (hasPassword && !delPassword)}
                  className="h-8 shrink-0 rounded-md border border-rec px-3 text-xs font-semibold text-rec hover:bg-rec hover:text-body disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-rec"
                  onClick={() => run(async () => { await deleteAccount(hasPassword ? delPassword : null); forgetSession(); onClose(); onNotice('계정 삭제를 접수했습니다 — 유예 기간 안에 로그인하면 되살릴 수 있습니다'); })}>계정 삭제</button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 클라우드 저장 — **얹는 기능이지 문지기가 아니다.**
 *
 * 로그인하지 않아도 편집기는 그대로 돈다 (`plan.md` 6: DAW 는 무료). 여기는
 * "서버에 저장/열기"만 더한다. 로그인을 강요하면 처음 온 사람이 곡을 만들어 보기도
 * 전에 벽을 만난다.
 *
 * 저장은 **`If-Match` 낙관적 잠금**이다. 충돌은 오류가 아니라 정상적으로 일어나는
 * 일이라(다른 탭, 다른 기기) 예외로 던지지 않고 결과로 받아 사용자에게 고르게 한다.
 */

import { useCallback, useEffect, useState } from 'react';

import { forgetSession } from '../api/client.ts';
import { ApiError, isQuotaError } from '../api/errors.ts';
import { logout } from '../api/auth.ts';
import { fetchMe, songsRemaining, type Me } from '../api/me.ts';
import {
  createProject,
  listProjects,
  openProject,
  saveProject,
  type ProjectSummary,
} from '../api/projects.ts';
import { getSession, onSessionChange } from '../api/session.ts';
import { deserializeProject, serializeProject } from '../model/persistence.ts';
import type { Project } from '../model/project.ts';
import { navigate } from './route.ts';

const btn = 'rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40';

export interface CloudPanelProps {
  project: Project;
  onOpen: (project: Project) => void;
  onNotice: (text: string) => void;
}

export function CloudPanel({ project, onOpen, onNotice }: CloudPanelProps) {
  const [signedIn, setSignedIn] = useState(getSession() !== null);
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 서버에서 연 곡의 id·버전. 저장할 때 `If-Match` 로 쓴다 */
  const [linked, setLinked] = useState<{ id: string; head: string } | null>(null);

  useEffect(() => onSessionChange((s) => setSignedIn(s !== null)), []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [profile, list] = await Promise.all([fetchMe(), listProjects()]);
      setMe(profile);
      setItems(list.items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '목록을 가져오지 못했습니다');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open && signedIn) void refresh();
  }, [open, signedIn, refresh]);

  if (!signedIn) {
    return (
      <button type="button" className={btn} onClick={() => navigate('/login')}>
        로그인
      </button>
    );
  }

  const doSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const doc = JSON.parse(serializeProject(project)) as Record<string, unknown>;
      if (linked) {
        const result = await saveProject(linked.id, linked.head, doc, project.name);
        if (!result.ok) {
          // **충돌을 조용히 덮지 않는다.** 다른 곳에서 먼저 저장했다
          setError('다른 곳에서 먼저 저장했습니다. 목록에서 다시 열어 주세요');
          return;
        }
        setLinked({ id: result.project.id, head: result.project.head_version_id ?? '' });
      } else {
        const created = await createProject(project.name, doc);
        setLinked({ id: created.id, head: created.head_version_id ?? '' });
      }
      onNotice('클라우드에 저장했습니다');
      await refresh();
    } catch (e) {
      if (isQuotaError(e)) {
        // **만든 곡은 계속 쓸 수 있다**는 것을 반드시 함께 말한다 —
        // 안 그러면 사용자는 작업물을 잃은 줄 안다 (`SERVER_PAYMENTS.md` 7절)
        setError(`${e.message} — 이미 만든 곡은 계속 편집·내보내기할 수 있습니다`);
      } else {
        setError(e instanceof ApiError ? e.message : '저장하지 못했습니다');
      }
    } finally {
      setBusy(false);
    }
  };

  const doOpen = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const detail = await openProject(id);
      if (!detail.document) throw new ApiError(0, 'empty', '아직 저장된 내용이 없습니다');
      onOpen(deserializeProject(JSON.stringify(detail.document)));
      setLinked({ id: detail.id, head: detail.head_version_id ?? '' });
      setOpen(false);
      onNotice(`'${detail.name}' 을 열었습니다`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '열지 못했습니다');
    } finally {
      setBusy(false);
    }
  };

  const workspace = me?.workspaces[0];
  const left = workspace ? songsRemaining(workspace) : null;

  return (
    <div className="relative flex items-center gap-2">
      <button type="button" className={btn} disabled={busy} onClick={doSave}>
        클라우드 저장
      </button>
      <button type="button" className={btn} onClick={() => setOpen(!open)}>
        내 곡
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-80 rounded border border-neutral-700 bg-neutral-900 p-3 shadow-xl">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="truncate text-sm text-neutral-300">{me?.email}</span>
            <button
              type="button"
              className="text-xs text-neutral-500 underline"
              onClick={async () => { await logout(); forgetSession(); setOpen(false); }}
            >
              로그아웃
            </button>
          </div>

          {workspace && (
            <p className="mb-2 text-xs text-neutral-500">
              {left === null
                ? '무제한'
                : `무료로 ${left}곡 더 만들 수 있습니다 (${workspace.plan_code})`}
            </p>
          )}

          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          {busy && <p className="mb-2 text-xs text-neutral-500">불러오는 중…</p>}

          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {items.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => doOpen(p.id)}
                  className="w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-800"
                >
                  {p.name}
                  <span className="ml-2 text-xs text-neutral-500">
                    {new Date(p.updated_at).toLocaleDateString()}
                  </span>
                </button>
              </li>
            ))}
            {!busy && items.length === 0 && (
              <li className="px-2 py-1.5 text-sm text-neutral-500">아직 저장한 곡이 없습니다</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

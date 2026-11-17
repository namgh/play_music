import { useState } from 'react';

import type { Project } from '../model/project.ts';
import { TEMPLATES, projectFromTemplate } from '../model/templates.ts';
import {
  browserKv, deleteVersion, getProject, listProjects, listVersions, loadVersion, putProject, removeProject, saveVersion,
} from '../editor/library.ts';

/**
 * 곡 고르기 — 템플릿으로 새 곡 · 최근 곡 · 지금 곡의 버전 (Logic 프로젝트 고르기 · 대안,
 * `LOGIC_PARITY.md` 1-1). 화면 가운데 판으로 뜬다.
 */

export interface ProjectPanelProps {
  project: Project;
  onOpen: (project: Project, message: string) => void;
  onClose: () => void;
}

const H = 'mb-2 text-[11px] font-semibold text-ink-3';
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? '방금' : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`;
};

export function ProjectPanel({ project, onOpen, onClose }: ProjectPanelProps) {
  const [tick, setTick] = useState(0); // 보관함을 바꾼 뒤 다시 읽게
  const [versionName, setVersionName] = useState('');
  const recent = listProjects(browserKv).filter((e) => e.id !== project.id);
  const versions = listVersions(browserKv, project.id);
  void tick;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6" onClick={onClose}>
      <div role="dialog" aria-label="곡 고르기" onClick={(e) => e.stopPropagation()}
        className="grid max-h-full w-full max-w-5xl grid-cols-[1.4fr_1fr] gap-5 overflow-hidden rounded-2xl border border-rule bg-body p-5 shadow-2xl">
        <div className="min-h-0 overflow-y-auto">
          <div className="mb-4 flex items-baseline gap-2">
            <h2 className="font-disp text-xl text-ink">새 곡</h2>
            <span className="text-[11px] text-ink-3">편성으로 시작합니다 — 지금 곡은 최근 곡에 남습니다</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                data-template={t.id}
                onClick={() => {
                  putProject(browserKv, project, Date.now());
                  onOpen(projectFromTemplate(t), `"${t.name}" 템플릿으로 새 곡을 시작했습니다`);
                }}
                className="flex flex-col gap-1 rounded-xl border border-rule bg-panel p-3 text-left hover:border-ink"
              >
                <span className="text-sm font-semibold text-ink">{t.name}</span>
                <span className="text-[11px] text-ink-2">{t.description}</span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {t.tracks.map((tr) => (
                    <i key={tr.name} className={`h-1.5 w-5 rounded-full bg-${({ j1: 't1', j2: 't2', j3: 't3', j4: 't4', j5: 't5', j6: 't6' } as Record<string, string>)[tr.color]}`} />
                  ))}
                </span>
                <span className="font-num text-[13px] text-ink-3">{t.bpm} BPM · {t.bars}마디{t.key ? ` · ${t.key.tonic}${t.key.mode === 'minor' ? 'm' : ''}` : ''}</span>
              </button>
            ))}
          </div>

          <h3 className={`${H} mt-6`}>최근 곡</h3>
          {recent.length === 0 && <p className="text-xs text-ink-3">아직 없습니다 — 새 곡을 시작하면 지금 곡이 여기 남습니다</p>}
          <ul className="divide-y divide-rule rounded-xl border border-rule">
            {recent.map((e) => (
              <li key={e.id} className="flex items-center gap-2 px-3 py-2" data-recent={e.name}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{e.name}</span>
                  <span className="text-[11px] text-ink-3">트랙 {e.tracks} · {e.bars}마디 · {ago(e.updatedAt)}</span>
                </span>
                <button type="button" className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink"
                  onClick={() => {
                    const p = getProject(browserKv, e.id);
                    if (!p) return;
                    putProject(browserKv, project, Date.now());
                    onOpen(p, `"${p.name}" 을 열었습니다`);
                  }}>열기</button>
                <button type="button" aria-label={`${e.name} 보관함에서 지우기`} className="h-7 rounded-md border border-rule px-2 text-xs text-ink-3 hover:text-rec"
                  onClick={() => { removeProject(browserKv, e.id); setTick((x) => x + 1); }}>✕</button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex min-h-0 flex-col overflow-y-auto rounded-xl bg-panel p-4">
          <div className="mb-3 flex items-center">
            <h2 className="flex-1 font-disp text-base text-ink">버전 — {project.name}</h2>
            <button type="button" onClick={onClose} className="h-7 rounded-md border border-rule bg-body px-2.5 text-xs text-ink-2">닫기</button>
          </div>
          <p className="mb-3 text-[11px] text-ink-3">지금 상태에 이름을 붙여 남깁니다 (Logic 의 대안). 마음껏 고친 뒤 돌아올 수 있어요.</p>
          <div className="mb-3 flex gap-1.5">
            <input aria-label="버전 이름" value={versionName} onChange={(e) => setVersionName(e.target.value)} placeholder="예: 브리지 바꾸기 전"
              className="h-8 min-w-0 flex-1 rounded-md border border-rule bg-body px-2 text-xs text-ink" />
            <button type="button" onClick={() => { saveVersion(browserKv, project, versionName, Date.now()); setVersionName(''); setTick((x) => x + 1); }}
              className="h-8 rounded-md border border-ink bg-ink px-3 text-xs text-body">남기기</button>
          </div>
          {versions.length === 0 && <p className="text-xs text-ink-3">남긴 버전이 없습니다</p>}
          <ul className="space-y-1.5">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center gap-2 rounded-lg border border-rule bg-body px-2.5 py-2" data-version={v.name}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-ink">{v.name}</span>
                  <span className="text-[10px] text-ink-3">{ago(v.savedAt)}</span>
                </span>
                <button type="button" className="h-7 rounded-md border border-rule bg-panel px-2 text-xs text-ink hover:border-ink"
                  title="이 버전으로 돌아갑니다 — 지금 상태는 '되돌아가기 전' 버전으로 남겨 둡니다"
                  onClick={() => {
                    const p = loadVersion(browserKv, project.id, v.id);
                    if (!p) return;
                    saveVersion(browserKv, project, '되돌아가기 전', Date.now());
                    onOpen(p, `"${v.name}" 버전으로 돌아갔습니다`);
                  }}>돌아가기</button>
                <button type="button" aria-label={`${v.name} 버전 지우기`} className="h-7 rounded-md border border-rule px-2 text-xs text-ink-3 hover:text-rec"
                  onClick={() => { deleteVersion(browserKv, project.id, v.id); setTick((x) => x + 1); }}>✕</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

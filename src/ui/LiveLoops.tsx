import { useState } from 'react';

import type { Project, TrackId } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { positionAt } from '../model/meter.ts';
import { addScenes, arrangeScenes, captureScene, clearCell, performanceProject, removeScene, scenesFromSections } from '../editor/liveLoops.ts';
import type { LiveState } from '../editor/liveLoops.ts';

/**
 * 라이브 루프 화면 — 트랙 × 장면 격자 (Logic Live Loops, `LOGIC_PARITY.md` 1-5).
 *
 * 칸을 누르면 그 트랙이 그 칸으로 바뀌고(트랙마다 하나), 장면 머리의 ▶ 는 그 줄 전부.
 * 연주는 `performanceProject` 로 만든 연주용 곡을 반복 재생한다. 연주한 장면 순서를
 * "편곡으로" 보내면 곡 끝에 차례로 붙는다.
 */

export interface LiveLoopsProps {
  editor: ProjectEditor;
  /** 연주용 곡을 재생한다 (곡을 바꾸지 않는다) */
  onPerform: (performance: Project | null) => void;
  playing: boolean;
  onNotice: (message: string) => void;
}

export function LiveLoops({ editor, onPerform, playing, onNotice }: LiveLoopsProps) {
  const { project } = editor;
  const scenes = project.liveScenes ?? [];
  const [state, setState] = useState<LiveState>({});
  const [played, setPlayed] = useState<string[]>([]);

  const perform = (next: LiveState, sceneForLog?: string) => {
    setState(next);
    if (sceneForLog) setPlayed((p) => (p[p.length - 1] === sceneForLog ? p : [...p, sceneForLog]));
    const any = Object.values(next).some(Boolean);
    onPerform(any ? performanceProject(project, next).project : null);
  };

  const launchScene = (id: string) => {
    const scene = scenes.find((s) => s.id === id)!;
    perform(Object.fromEntries(project.tracks.map((t) => [t.id, scene.cells.some((c) => c.trackId === t.id) ? id : null])) as LiveState, id);
  };
  const toggleCell = (trackId: TrackId, sceneId: string) => {
    perform({ ...state, [trackId]: state[trackId] === sceneId ? null : sceneId });
  };

  const barsOf = (ticks: number) => positionAt(project, Math.max(0, ticks - 1)).bar + 1;

  return (
    <section className="flex min-h-0 flex-col gap-3" data-live-loops>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-disp text-lg leading-none text-ink">라이브 루프</h2>
        <span className="text-[11px] text-ink-3">칸 = 트랙 하나의 반복 조각 · 칸을 누르면 그 트랙이 바뀌고, ▶ 는 장면 전체</span>
        <span className="flex-1" />
        <button type="button" disabled={(project.sections ?? []).length === 0}
          onClick={() => { editor.commit(addScenes(project, scenesFromSections(project))); onNotice('편곡 구간마다 장면을 만들었습니다'); }}
          className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink disabled:opacity-40"
          title="편곡 구간(인트로·벌스…)마다 장면 하나">구간에서 장면 만들기</button>
        <button type="button" disabled={!project.loop}
          onClick={() => { editor.commit(addScenes(project, [captureScene(project, project.loop!.startTick, project.loop!.endTick, `장면 ${scenes.length + 1}`)])); }}
          className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink disabled:opacity-40"
          title="반복 구간(⌘L)의 음을 새 장면으로">반복 구간을 장면으로</button>
        <button type="button" disabled={!playing && !Object.values(state).some(Boolean)}
          onClick={() => perform({})} className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink disabled:opacity-40">모두 멈춤</button>
        <button type="button" disabled={played.length === 0}
          onClick={() => {
            editor.commit(arrangeScenes(project, played));
            onNotice(`연주한 장면 ${played.length}개를 곡 끝에 붙였습니다`);
            setPlayed([]);
          }}
          title="연주한 장면 순서대로 곡 끝에 붙인다"
          className="h-7 rounded-md border border-ink bg-ink px-2.5 text-xs text-body disabled:opacity-40">편곡으로 ({played.length})</button>
      </div>

      {scenes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-rule p-6 text-sm text-ink-3">
          장면이 없습니다. <b>구간에서 장면 만들기</b>로 지금 곡의 구간을 칸으로 옮기거나, 반복 구간을 잡고 <b>반복 구간을 장면으로</b>를 누르세요.
        </p>
      ) : (
        <div className="overflow-auto rounded-xl bg-screen p-3">
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `10rem repeat(${scenes.length}, minmax(7.5rem, 1fr))` }}>
            <div />
            {scenes.map((s) => {
              const on = project.tracks.length > 0 && project.tracks.every((t) => (state[t.id] ?? null) === (s.cells.some((c) => c.trackId === t.id) ? s.id : null));
              return (
                <div key={s.id} className="flex items-center gap-1" data-scene={s.name}>
                  <button type="button" onClick={() => launchScene(s.id)} aria-label={`${s.name} 장면 재생`}
                    className={`flex h-8 flex-1 items-center gap-1.5 truncate rounded-md px-2 text-left text-xs font-semibold ${on ? 'bg-acc text-acc-ink' : 'bg-screen-2 text-sink hover:bg-grid-2'}`}>
                    <span>▶</span>{s.name}
                  </button>
                  <button type="button" aria-label={`${s.name} 장면 지우기`} onClick={() => editor.commit(removeScene(project, s.id))}
                    className="h-8 w-6 rounded-md text-[11px] text-sink-3 hover:text-rec">✕</button>
                </div>
              );
            })}
            {project.tracks.map((t) => [
              <div key={`${t.id}-name`} className="flex items-center truncate text-xs text-sink">{t.name}</div>,
              ...scenes.map((s) => {
                const cell = s.cells.find((c) => c.trackId === t.id);
                const active = state[t.id] === s.id;
                if (!cell) return <div key={`${t.id}-${s.id}`} className="h-14 rounded-md border border-dashed border-grid" />;
                const span = Math.max(1, cell.lengthTick);
                return (
                  <div key={`${t.id}-${s.id}`} className="relative" data-cell={`${t.name}:${s.name}`}>
                    <button type="button" onClick={() => toggleCell(t.id, s.id)} aria-pressed={active}
                      className={`relative h-14 w-full overflow-hidden rounded-md text-left ${active ? 'bg-acc/30 ring-2 ring-acc' : 'bg-screen-2 hover:bg-grid-2'}`}>
                      {/* 칸 안의 음 미리보기 — 피아노 롤을 아주 작게 */}
                      {cell.notes.map((n) => (
                        <i key={n.id} style={{ left: `${(n.startTick / span) * 100}%`, width: `${Math.max(2, (n.lengthTick / span) * 100)}%`, top: `${100 - (((n.pitch.midi % 36) + 2) / 40) * 100}%` }}
                          className={`absolute h-[3px] rounded-full ${active ? 'bg-acc' : 'bg-sink-2'}`} />
                      ))}
                      <span className="absolute bottom-1 left-1.5 font-num text-[11px] text-sink-3">{barsOf(cell.lengthTick)}마디 · {cell.notes.length}음</span>
                    </button>
                    <button type="button" aria-label="칸 비우기" onClick={() => editor.commit(clearCell(project, s.id, t.id))}
                      className="absolute right-1 top-1 text-[10px] text-sink-3 hover:text-rec">✕</button>
                  </div>
                );
              }),
            ])}
          </div>
        </div>
      )}
      {played.length > 0 && (
        <p className="text-[11px] text-ink-3">연주한 순서: {played.map((id) => scenes.find((s) => s.id === id)?.name ?? '?').join(' → ')}</p>
      )}
    </section>
  );
}

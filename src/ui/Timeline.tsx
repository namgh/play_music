import { useState } from 'react';

import type { ClipId, Project, TrackId } from '../model/project.ts';
import { countEditedNotes } from '../model/project.ts';
import { ticksPerBar } from '../model/time.ts';
import { addClip, deleteClip, duplicateClip, moveClip, resizeClip } from '../editor/edits.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';

/**
 * 타임라인 — 트랙별로 클립을 늘어놓는다. 시안은 `mockup/studio-v2.html` 의 테이프 레인.
 *
 * 클립이 여러 개여야 곡 구조(인트로·A·B)를 만들 수 있다. 트랙당 하나만 다루면
 * "곡 하나를 끝낸다"(`plan.md` 5-1 Phase 1 완료 조건)가 성립하지 않는다.
 */

const LANE_HEIGHT = 40;
const TRACK_COLORS: Record<string, string> = {
  j1: 'bg-teal-500/70 border-teal-300',
  j2: 'bg-amber-500/70 border-amber-300',
  j3: 'bg-violet-500/70 border-violet-300',
  j4: 'bg-rose-500/70 border-rose-300',
  j5: 'bg-sky-500/70 border-sky-300',
  j6: 'bg-lime-500/70 border-lime-300',
};

export interface TimelineProps {
  editor: ProjectEditor;
  selectedTrackId: TrackId | null;
  selectedClipId: ClipId | null;
  playheadTick: number | null;
  onSelect: (trackId: TrackId, clipId: ClipId) => void;
}

export function Timeline({
  editor, selectedTrackId, selectedClipId, playheadTick, onSelect,
}: TimelineProps) {
  const { project } = editor;
  const barTicks = ticksPerBar(project.timeSignature);
  const totalTicks = project.lengthBars * barTicks;
  const pct = (ticks: number) => `${(ticks / totalTicks) * 100}%`;

  /**
   * 클립 끌기 (`ROADMAP.md` P1). **마디 단위로 스냅한다** — 곡 구조를 짜는
   * 단위가 마디이고, 자유 위치로 두면 몇 틱씩 어긋난 클립이 쌓인다.
   *
   * 드래그 시작 시점의 프로젝트에서 계산한다. 매 프레임 누적하면 오차가 쌓인다.
   */
  const [clipDrag, setClipDrag] = useState<{
    clipId: ClipId; trackId: TrackId; startX: number; originTick: number; origin: Project;
  } | null>(null);

  const beginClipDrag = (
    event: React.PointerEvent<HTMLElement>,
    trackId: TrackId,
    clipId: ClipId,
    startTick: number,
  ) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setClipDrag({ clipId, trackId, startX: event.clientX, originTick: startTick, origin: project });
  };

  const onClipDragMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!clipDrag) return;
    const lane = (event.currentTarget as HTMLElement).closest('[data-lane]');
    if (!lane) return;
    const width = lane.getBoundingClientRect().width;
    if (width <= 0) return;

    const deltaTicks = ((event.clientX - clipDrag.startX) / width) * totalTicks;
    const snapped = Math.round((clipDrag.originTick + deltaTicks) / barTicks) * barTicks;
    if (snapped === clipDrag.originTick) {
      editor.preview(clipDrag.origin);
      return;
    }
    try {
      editor.preview(moveClip(clipDrag.origin, clipDrag.clipId, { startTick: snapped }));
    } catch {
      // 겹치는 자리면 그냥 안 움직인다. 조용히 밀어 주면 놓은 자리와 달라진다
    }
  };

  const endClipDrag = () => {
    if (!clipDrag) return;
    setClipDrag(null);
    // 드래그 전체를 언두 한 단계로 만든다
    editor.commitCurrent();
  };

  /** 빈 곳을 누르면 그 마디에서 시작하는 클립을 만든다 */
  const onLaneClick = (trackId: TrackId, event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-clip]')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const bar = Math.max(0, Math.min(project.lengthBars - 1, Math.floor(ratio * project.lengthBars)));

    const length = Math.min(4, project.lengthBars - bar) * barTicks;
    try {
      const { project: next, clipId } = addClip(project, {
        trackId,
        startTick: bar * barTicks,
        lengthTick: length,
        label: `${bar + 1}마디`,
      });
      editor.commit(next);
      onSelect(trackId, clipId);
    } catch {
      // 겹치는 자리 — 아무 일도 하지 않는다 (에러를 띄우면 오히려 시끄럽다)
    }
  };

  return (
    <section>
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">타임라인</h2>
        <span className="text-xs text-neutral-500">
          빈 곳을 클릭해 클립 추가 · 클립을 클릭해 편집 · 끝을 끌어 길이 조절
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-800">
        {/* 마디 눈금 */}
        <div className="relative flex h-6 border-b border-neutral-800 bg-neutral-900/60">
          <div className="w-32 shrink-0 border-r border-neutral-800" />
          <div className="relative flex-1">
            {Array.from({ length: project.lengthBars }, (_, bar) => (
              <span
                key={bar}
                style={{ left: pct(bar * barTicks) }}
                className="absolute top-0 border-l border-neutral-800 pl-1 font-mono text-[10px] text-neutral-500"
              >
                {bar + 1}
              </span>
            ))}
          </div>
        </div>

        {project.tracks.map((track) => (
          <div key={track.id} className="flex border-b border-neutral-800 last:border-b-0">
            <button
              type="button"
              onClick={() => {
                const first = track.clips[0];
                if (first) onSelect(track.id, first.id);
              }}
              style={{ height: LANE_HEIGHT }}
              className={`flex w-32 shrink-0 items-center gap-2 border-r border-neutral-800 px-2 text-left text-xs ${
                track.id === selectedTrackId ? 'bg-neutral-900' : ''
              }`}
            >
              <span className={`h-4 w-1 rounded-sm ${TRACK_COLORS[track.color]?.split(' ')[0] ?? 'bg-neutral-600'}`} />
              <span className="min-w-0 flex-1 truncate text-neutral-300">{track.name}</span>
              {track.mute && <span className="text-amber-400">M</span>}
              {track.solo && <span className="text-teal-300">S</span>}
            </button>

            <div
              data-lane
              onClick={(event) => onLaneClick(track.id, event)}
              style={{ height: LANE_HEIGHT }}
              className="relative flex-1 cursor-copy bg-neutral-950"
            >
              {track.clips.map((clip) => {
                const selected = clip.id === selectedClipId;
                const edited = countEditedNotes(clip);
                return (
                  <div
                    key={clip.id}
                    data-clip
                    style={{ left: pct(clip.startTick), width: pct(clip.lengthTick) }}
                    className={`absolute inset-y-1 flex items-center overflow-hidden rounded border px-1.5 text-[10px] ${
                      TRACK_COLORS[track.color] ?? 'border-neutral-600 bg-neutral-700'
                    } ${selected ? 'ring-2 ring-white/70' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(track.id, clip.id)}
                      onPointerDown={(event) => beginClipDrag(event, track.id, clip.id, clip.startTick)}
                      onPointerMove={onClipDragMove}
                      onPointerUp={endClipDrag}
                      onPointerCancel={endClipDrag}
                      title="끌어서 옮깁니다"
                      className="min-w-0 flex-1 cursor-grab truncate text-left font-medium text-black/80"
                    >
                      {clip.label || '클립'}
                      <span className="ml-1 opacity-70">
                        {clip.notes.length}음{edited > 0 ? ` · ${edited} 수정` : ''}
                      </span>
                      {clip.locked && <span className="ml-1">🔒</span>}
                    </button>
                    <button
                      type="button"
                      aria-label="클립 복제"
                      title="바로 뒤에 복제"
                      onClick={() => {
                        try {
                          const next = duplicateClip(project, clip.id);
                          editor.commit(next.project);
                          onSelect(track.id, next.clipId);
                        } catch {
                          // 뒤에 자리가 없으면 아무 일도 하지 않는다 — 조용히 밀면
                          // 사용자가 의도하지 않은 곳에 붙는다
                        }
                      }}
                      className="px-1 text-black/60 hover:text-black"
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      aria-label="클립 삭제"
                      onClick={() => editor.commit(deleteClip(project, clip.id))}
                      className="px-1 text-black/60 hover:text-black"
                    >
                      ✕
                    </button>
                    <span
                      role="slider"
                      aria-label="클립 길이"
                      aria-valuenow={clip.lengthTick}
                      tabIndex={0}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        const lane = event.currentTarget.parentElement!.parentElement!;
                        const rect = lane.getBoundingClientRect();
                        const origin = project;
                        const move = (e: PointerEvent) => {
                          const ratio = (e.clientX - rect.left) / rect.width;
                          const endTick = ratio * totalTicks;
                          const bars = Math.max(1, Math.round((endTick - clip.startTick) / barTicks));
                          editor.preview(resizeClip(origin, clip.id, bars * barTicks));
                        };
                        const up = () => {
                          window.removeEventListener('pointermove', move);
                          window.removeEventListener('pointerup', up);
                          editor.commitCurrent();
                        };
                        window.addEventListener('pointermove', move);
                        window.addEventListener('pointerup', up);
                      }}
                      className="h-full w-1.5 cursor-ew-resize bg-black/25"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {playheadTick !== null && (
          <div className="relative">
            <div className="pointer-events-none absolute inset-x-32 -top-px">
              <div
                style={{ left: pct(playheadTick) }}
                className="absolute h-2 w-px bg-teal-300"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

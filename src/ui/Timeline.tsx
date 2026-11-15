import { useState } from 'react';

import type { ClipId, Project, TrackId } from '../model/project.ts';
import { countEditedNotes } from '../model/project.ts';
import { ticksPerBar } from '../model/time.ts';
import { addClip, addTrack, deleteClip, deleteTrack, duplicateClip, moveClip, resizeClip, updateTrack }
  from '../editor/edits.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import {
  INSTRUMENT_CATALOG, instrumentsByCategory, playableInstrumentIds,
} from '../instruments/definitions.ts';
import { useInstruments } from '../instruments/useInstruments.ts';
import { resolveInstrument } from '../instruments/resolve.ts';
import { LevelMeter } from './LevelMeter.tsx';

/**
 * 타임라인 — 트랙별로 클립을 늘어놓는다. 시안은 `mockup/studio-v2.html` 의 테이프 레인.
 *
 * 클립이 여러 개여야 곡 구조(인트로·A·B)를 만들 수 있다. 트랙당 하나만 다루면
 * "곡 하나를 끝낸다"(`plan.md` 5-1 Phase 1 완료 조건)가 성립하지 않는다.
 */

/**
 * 한 행의 높이. **왼쪽 트랙 설정과 오른쪽 클립 레인이 같은 행을 쓴다.**
 *
 * 전에는 트랙 목록과 타임라인이 따로 있었고, 둘 다 트랙마다 한 줄씩 늘어나서
 * 16트랙이면 합쳐 1200px 을 먹었다 — 피아노롤이 그만큼 밀렸다. 좌우로 붙이면
 * 세로가 절반이 되고, 무엇보다 **한 트랙의 설정과 그 트랙의 클립이 같은 줄에**
 * 놓여 눈이 오가지 않는다 (DAW 들이 이 형태인 이유다).
 *
 * 컨트롤이 h-7(28px)이므로 44 면 위아래 여백이 8px씩 남는다.
 */
const LANE_HEIGHT = 44;
/** 왼쪽 설정 칸의 폭. 눈금 줄과 각 행이 **같은 값**을 써야 세로선이 이어진다 */
const NAME_COL = 'w-[27rem]';

const INSTRUMENT_IDS = playableInstrumentIds();
const INSTRUMENT_GROUPS = instrumentsByCategory();
const instrumentName = (id: string) =>
  INSTRUMENT_CATALOG.find((e) => e.id === id)?.name ?? id;

// 켜짐/꺼짐 스타일을 한 문자열에 섞지 않는다 — 색 배경일 때는 같은 계열의 어두운 글자
const TOGGLE_BASE = 'h-7 w-7 shrink-0 rounded border text-xs font-semibold';
const TOGGLE_OFF = 'border-rule bg-body text-ink-3 hover:border-ink-3';
const MUTE_ON = 'border-acc bg-acc text-acc-ink';
const SOLO_ON = 'border-ink bg-ink text-body';
/**
 * 트랙 색 → 테마 토큰 t1–t6 (`index.css`). 클립은 화면 판 위에서 옅은 바탕 + 진한 머리띠,
 * 색 띠는 트랙 헤더 왼쪽에 같은 색으로 — 두 곳의 색이 같아야 눈으로 짝을 짓는다
 */
const TRACK_COLORS: Record<string, { strip: string; clip: string; head: string }> = {
  j1: { strip: 'bg-t1', clip: 'bg-t1/20', head: 'bg-t1' },
  j2: { strip: 'bg-t2', clip: 'bg-t2/20', head: 'bg-t2' },
  j3: { strip: 'bg-t3', clip: 'bg-t3/20', head: 'bg-t3' },
  j4: { strip: 'bg-t4', clip: 'bg-t4/20', head: 'bg-t4' },
  j5: { strip: 'bg-t5', clip: 'bg-t5/20', head: 'bg-t5' },
  j6: { strip: 'bg-t6', clip: 'bg-t6/20', head: 'bg-t6' },
};
const FALLBACK_COLOR = { strip: 'bg-ink-3', clip: 'bg-sink-3/30', head: 'bg-sink-3' };

export interface TimelineProps {
  editor: ProjectEditor;
  selectedTrackId: TrackId | null;
  selectedClipId: ClipId | null;
  playheadTick: number | null;
  onSelect: (trackId: TrackId, clipId: ClipId) => void;
  /** 클립이 없는 트랙을 고를 때 — `onSelect` 는 클립을 요구한다 */
  onSelectTrack: (trackId: TrackId) => void;
  /** 트랙 레벨 미터. 없으면 미터를 그리지 않는다 */
  readLevel?: (trackId: TrackId | null) => { peak: number; rms: number } | null;
}

export function Timeline({
  editor, selectedTrackId, selectedClipId, playheadTick, onSelect, onSelectTrack, readLevel,
}: TimelineProps) {
  const { project } = editor;
  // 이 곡이 쓰는 악기만 불러온다. 이름은 카탈로그에 있어 목록은 안 기다린다
  const { registry, ready } = useInstruments(project.tracks.map((t) => t.instrumentId));

  const onAddTrack = () => {
    const instrumentId = INSTRUMENT_IDS[project.tracks.length % INSTRUMENT_IDS.length]!;
    const added = addTrack(project, { name: instrumentName(instrumentId), instrumentId });
    // 클립을 같이 만든다 — 없으면 피아노롤에 찍을 곳이 없어 "만들었는데 못 쓴다"가 된다
    const withClip = addClip(added.project, {
      trackId: added.trackId,
      startTick: 0,
      lengthTick: project.lengthBars * ticksPerBar(project.timeSignature),
      label: instrumentName(instrumentId),
    });
    editor.commit(withClip.project);
    onSelectTrack(added.trackId);
  };
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
      <div className="mb-2 flex items-center gap-3">
        <div className={`flex ${NAME_COL} shrink-0 items-center justify-between gap-2 pr-2`}>
          <h2 className="font-disp text-lg leading-none text-ink">
            트랙 <span className="text-ink-3">{project.tracks.length}</span>
          </h2>
          <button
            type="button"
            onClick={onAddTrack}
            className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3"
          >
            ＋ 트랙 추가
          </button>
        </div>
        <span className="min-w-0 truncate text-[11px] text-ink-3">
          빈 곳을 클릭해 클립 추가 · 클립을 클릭해 편집 · 끝을 끌어 길이 조절
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-rule">
        {/* 마디 눈금 */}
        <div className="relative flex h-7 border-b border-grid">
          <div className={`${NAME_COL} shrink-0 border-r border-rule bg-body`} />
          <div className="relative flex-1 bg-screen">
            {Array.from({ length: project.lengthBars }, (_, bar) => (
              <span
                key={bar}
                style={{ left: pct(bar * barTicks) }}
                className="absolute inset-y-0 flex items-center border-l border-grid pl-1.5 font-num text-[13px] text-sink-2"
              >
                {bar + 1}
              </span>
            ))}
          </div>
        </div>

        {project.tracks.length === 0 && (
          <p className="bg-body p-4 text-sm text-ink-3">
            트랙이 없습니다. 위의 <b>＋ 트랙 추가</b>를 누르면 악기와 클립이 함께 만들어집니다.
          </p>
        )}

        {project.tracks.map((track) => (
          <div key={track.id} className="flex border-b border-grid last:border-b-0">
            {/* 왼쪽 칸 = 이 트랙의 설정. 오른쪽 레인과 **같은 행**이라 눈이 오가지 않는다 */}
            <div
              style={{ height: LANE_HEIGHT }}
              className={`flex ${NAME_COL} shrink-0 items-center gap-1.5 border-r border-rule px-2 ${
                track.id === selectedTrackId ? 'bg-panel' : 'bg-body'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectTrack(track.id)}
                aria-label={`${track.name} 선택`}
                className={`h-7 shrink-0 rounded-sm ${
                  (TRACK_COLORS[track.color] ?? FALLBACK_COLOR).strip
                } ${track.id === selectedTrackId ? 'w-2 ring-2 ring-ink ring-offset-1 ring-offset-panel' : 'w-1.5'}`}
              />
              <select
                value={track.instrumentId}
                aria-label={`${track.name} 악기`}
                onChange={(event) => editor.commit(updateTrack(project, track.id, {
                  instrumentId: event.target.value,
                  name: instrumentName(event.target.value),
                  toneId: 'default',
                  toneParams: null,
                }))}
                className="min-w-0 flex-1 rounded-md border border-rule bg-body px-2 py-1 text-sm text-ink"
              >
                {INSTRUMENT_GROUPS.map((group) => (
                  <optgroup key={group.category} label={group.category}>
                    {group.instruments.map((instrument) => (
                      <option key={instrument.id} value={instrument.id}>{instrument.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <select
                value={track.toneId}
                aria-label={`${track.name} 음색`}
                onChange={(event) =>
                  editor.commit(updateTrack(project, track.id, { toneId: event.target.value }))}
                className="w-20 shrink-0 rounded-md border border-rule bg-body px-1.5 py-1 text-xs text-ink"
              >
                {/* 음색은 정의가 와야 안다 — 오는 동안은 지금 고른 것만 보여 준다 */}
                {(ready
                  ? Object.keys(resolveInstrument(track.instrumentId, registry).tones)
                  : [track.toneId]
                ).map((tone) => (
                  <option key={tone} value={tone}>{tone === 'default' ? '기본' : tone}</option>
                ))}
              </select>
              <button
                type="button"
                aria-pressed={track.mute}
                onClick={() => editor.commit(updateTrack(project, track.id, { mute: !track.mute }))}
                className={`${TOGGLE_BASE} ${track.mute ? MUTE_ON : TOGGLE_OFF}`}
              >M</button>
              <button
                type="button"
                aria-pressed={track.solo}
                onClick={() => editor.commit(updateTrack(project, track.id, { solo: !track.solo }))}
                className={`${TOGGLE_BASE} ${track.solo ? SOLO_ON : TOGGLE_OFF}`}
              >S</button>
              <input
                type="range"
                min={0} max={1} step={0.01}
                value={track.gain}
                aria-label={`${track.name} 레벨`}
                onChange={(event) =>
                  editor.preview(updateTrack(project, track.id, { gain: Number(event.target.value) }))}
                onPointerUp={() => editor.commitCurrent()}
                className="w-16 shrink-0 accent-ink"
              />
              {/* **페이더 바로 옆에 둔다.** 어느 트랙이 큰지 보고 그 자리에서
                  줄일 수 있어야 의미가 있다 — 멀리 있으면 안 본다 */}
              {readLevel && (
                <LevelMeter
                  className="w-12 shrink-0"
                  label={`${track.name} 레벨`}
                  read={() => readLevel(track.id)}
                />
              )}
              <button
                type="button"
                onClick={() => editor.commit(deleteTrack(project, track.id))}
                aria-label={`${track.name} 삭제`}
                className="h-7 w-7 shrink-0 rounded border border-rule text-xs text-ink-3 hover:border-rec hover:text-rec"
              >✕</button>
            </div>

            <div
              data-lane
              onClick={(event) => onLaneClick(track.id, event)}
              style={{ height: LANE_HEIGHT }}
              className="relative flex-1 cursor-copy bg-screen"
            >
              {track.clips.map((clip) => {
                const selected = clip.id === selectedClipId;
                const edited = countEditedNotes(clip);
                return (
                  <div
                    key={clip.id}
                    data-clip
                    style={{ left: pct(clip.startTick), width: pct(clip.lengthTick) }}
                    className={`absolute inset-y-1 flex items-center overflow-hidden rounded-md pl-1.5 pt-2 text-[10px] ${
                      (TRACK_COLORS[track.color] ?? FALLBACK_COLOR).clip
                    } ${selected ? 'ring-[1.5px] ring-acc' : ''}`}
                  >
                    <i className={`pointer-events-none absolute inset-x-0 top-0 h-1.5 ${(TRACK_COLORS[track.color] ?? FALLBACK_COLOR).head}`} />
                    <button
                      type="button"
                      onClick={() => onSelect(track.id, clip.id)}
                      onPointerDown={(event) => beginClipDrag(event, track.id, clip.id, clip.startTick)}
                      onPointerMove={onClipDragMove}
                      onPointerUp={endClipDrag}
                      onPointerCancel={endClipDrag}
                      title="끌어서 옮깁니다"
                      className="min-w-0 flex-1 cursor-grab truncate text-left font-semibold text-sink"
                    >
                      {clip.label || '클립'}
                      <span className="ml-1 font-normal text-sink-2">
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
                      className="px-1 text-sink-2 hover:text-sink"
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      aria-label="클립 삭제"
                      onClick={() => editor.commit(deleteClip(project, clip.id))}
                      className="px-1 text-sink-2 hover:text-sink"
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
                      className="h-full w-1.5 cursor-ew-resize bg-sink/15 hover:bg-sink/40"
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
                className="absolute h-2 w-px bg-acc"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

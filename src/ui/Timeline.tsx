import { Fragment, useEffect, useRef, useState } from 'react';
import { Menu, MenuButton, type MenuAction } from './Menu.tsx';

import { GlobalTracks } from './GlobalTracks.tsx';
import { usePeaks } from './audioUi.ts';
import { AutomationLane } from './AutomationLane.tsx';
import type { InstrumentParamSpec } from '../audio/automation.ts';
import { lanePoints, recorderStep, simplifyLane, trimAutomation, withLanePoints, writeAutomation } from '../editor/automationEdits.ts';
import { automationValueAtTick } from '../audio/automation.ts';
import { PPQ } from '../model/time.ts';
import { toggleStackFlag, ungroupStack, updateStack } from '../editor/tracks.ts';
import type { GlobalSelection } from './GlobalTracks.tsx';
import { barLines } from '../model/meter.ts';
import { projectLengthTicks } from '../model/factory.ts';

import type { AutomationTarget, ClipId, Project, Track, TrackId, TrackStack, AutomationPoint } from '../model/project.ts';
import { countEditedNotes } from '../model/project.ts';
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
const NAME_COL = 'w-[24rem]';

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
  /** 트랙 악기의 파라미터 선언·지금 값 — 오토메이션 레인이 악기 파라미터를 고를 수 있게 */
  instrumentFor?: ((track: Track) => { specs: Record<string, InstrumentParamSpec>; params: Record<string, number | string> } | null) | undefined;
  selectedTrackId: TrackId | null;
  selectedClipId: ClipId | null;
  playheadTick: number | null;
  onSelect: (trackId: TrackId, clipId: ClipId) => void;
  /** 클립이 없는 트랙을 고를 때 — `onSelect` 는 클립을 요구한다 */
  onSelectTrack: (trackId: TrackId) => void;
  /** 트랙 레벨 미터. 없으면 미터를 그리지 않는다 */
  readLevel?: (trackId: TrackId | null) => { peak: number; rms: number } | null;
  /**
   * 고른 클립·트랙에 대한 동작 — 우클릭 메뉴와 "클립 ▾" "트랙 ▾" 단추가 같은 목록을 연다
   * (`UX_REDESIGN.md` 3). 커서 위치를 알아야 해서(나누기) 목록은 `App` 이 만든다
   */
  clipMenu: MenuAction[];
  trackMenu: MenuAction[];
  /** 글로벌 트랙(구간·마커·코드·박자/조성)에서 고른 것 */
  globalSelection: GlobalSelection;
  onGlobalSelect: (selection: GlobalSelection) => void;
  /** 커서를 곡 기준 틱으로 옮긴다 */
  onSeek: (tick: number) => void;
  /** 눈금자를 끄는 동안 — 지나간 구간(`from`→`to`)의 음을 들려준다 (스크럽) */
  onScrub?: ((from: number, to: number) => void) | undefined;
  onNotice: (message: string) => void;
}

export function Timeline({
  instrumentFor,
  editor, selectedTrackId, selectedClipId, playheadTick, onSelect, onSelectTrack, readLevel, clipMenu, trackMenu,
  globalSelection, onGlobalSelect, onSeek, onNotice, onScrub,
}: TimelineProps) {
  // 스크럽 — 눈금자를 누른 채 끌면 그 자리 소리. 끌었으면 마지막 자리로 옮기고 마디 클릭은 무시한다
  const scrub = useRef<{ x: number; tick: number; moved: boolean } | null>(null);
  const scrubbed = useRef(false);
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
      lengthTick: totalTicks,
      label: instrumentName(instrumentId),
    });
    editor.commit(withClip.project);
    onSelectTrack(added.trackId);
  };
  // 박자 변화가 있으면 마디 길이가 제각각이다 — 마디 경계는 전부 박자 지도에서 온다
  const lines = barLines(project, project.lengthBars);
  const totalTicks = projectLengthTicks(project);
  const pct = (ticks: number) => `${(ticks / totalTicks) * 100}%`;
  // 스택은 머리 줄 하나 + (펼쳤으면) 멤버. 숨긴 트랙은 "숨긴 트랙" 을 켰을 때만
  const [showHidden, setShowHidden] = useState(false);
  /** 트랙별로 펼친 오토메이션 레인과 그 대상 — 보기 설정 */
  const [autoOpen, setAutoOpen] = useState<Partial<Record<TrackId, AutomationTarget>>>({});
  /**
   * 재생 중 기록 상태 (트랙별). ref 에 둔다 — 매 프레임 바뀌는데 그때마다 다시
   * 그리면 안 된다. 기록한 곡선은 미리보기로 쌓다가 재생이 멈출 때 한 번에 확정한다
   * (언두 한 단계).
   */
  const recording = useRef(new Map<TrackId, {
    lastTick: number | null; latched: boolean; touching: boolean; value: number;
    /** 트림: 잡기 시작한 자리와 그때의 곡선 — 매 프레임 원래 곡선에서 다시 곱한다(겹쳐 곱해지지 않게) */
    trimFrom?: number | undefined; trimOrig?: AutomationPoint[] | undefined;
  }>());
  const recorded = useRef(false);
  useEffect(() => {
    if (playheadTick === null) {
      if (recorded.current) {
        // 프레임마다 찍힌 점을 정리해서 확정한다
        let tidy = project;
        for (const id of recording.current.keys()) tidy = simplifyLane(tidy, id, 'volume');
        editor.preview(tidy);
        editor.commitCurrent();
      }
      recorded.current = false;
      recording.current.clear();
      return;
    }
    let next = project;
    for (const track of project.tracks) {
      const mode = track.automationMode ?? 'read';
      if (mode === 'read') continue;
      const st = recording.current.get(track.id)
        ?? { lastTick: null, latched: false, touching: false, value: automationValueAtTick(lanePoints(project, track.id, 'volume'), playheadTick) };
      const step = recorderStep(mode, st, { tick: playheadTick, touching: st.touching });
      recording.current.set(track.id, { ...st, ...step.next });
      if (mode === 'trim') {
        if (!st.touching) { recording.current.set(track.id, { ...st, ...step.next, trimFrom: undefined, trimOrig: undefined }); continue; }
        const from = st.trimFrom ?? playheadTick;
        const orig = st.trimOrig ?? lanePoints(project, track.id, 'volume');
        recording.current.set(track.id, { ...st, ...step.next, trimFrom: from, trimOrig: orig });
        if (playheadTick > from) {
          next = trimAutomation(withLanePoints(next, track.id, 'volume', orig), track.id, 'volume', { fromTick: from, toTick: playheadTick }, st.value);
        }
        continue;
      }
      if (step.write && step.write.toTick > step.write.fromTick) {
        next = writeAutomation(next, track.id, 'volume', step.write, st.value);
      }
    }
    if (next !== project) {
      recorded.current = true;
      editor.preview(next);
    }
    // 재생 헤드가 움직일 때만 돈다 — project 를 넣으면 미리보기가 다시 불러 무한히 돈다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadTick]);
  /** 글로벌 트랙 줄 (Logic 의 G) — 보기 설정이라 저장하지 않는다 */
  // 기본은 숨김 — 편곡 영역 높이의 1/3 을 늘 차지하면 트랙이 안 보인다. 한 번 켜면 기억한다
  const [showGlobals, setShowGlobalsRaw] = useState(() => { try { return localStorage.getItem('ui-globals') === '1'; } catch { return false; } });
  const setShowGlobals = (next: boolean | ((v: boolean) => boolean)) => setShowGlobalsRaw((v) => {
    const value = typeof next === 'function' ? next(v) : next;
    try { localStorage.setItem('ui-globals', value ? '1' : '0'); } catch { /* 저장 못 해도 보기는 바뀐다 */ }
    return value;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      if (e.code === 'KeyG' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); setShowGlobals((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** 우클릭 메뉴 — 누른 것을 먼저 고르고(목록이 고른 것 기준이다) 그 자리에 연다 */
  const [contextMenu, setContextMenu] = useState<{ kind: 'clip' | 'track'; x: number; y: number } | null>(null);
  const pickedTrack = project.tracks.find((t) => t.id === selectedTrackId) ?? null;
  const pickedClip = pickedTrack?.clips.find((c) => c.id === selectedClipId) ?? null;
  const clipMenuAll: MenuAction[] = [
    ...clipMenu,
    {
      id: 'clip.duplicate', label: '바로 뒤에 복제', separator: true, disabled: !pickedClip,
      run: () => {
        try {
          const next = duplicateClip(project, pickedClip!.id);
          editor.commit(next.project);
          onSelect(pickedTrack!.id, next.clipId);
        } catch { onNotice('뒤에 자리가 없어 복제하지 못했습니다'); }
      },
    },
    { id: 'clip.delete', label: '클립 삭제', disabled: !pickedClip, run: () => editor.commit(deleteClip(project, pickedClip!.id)) },
  ];
  const trackMenuAll: MenuAction[] = [
    ...trackMenu,
    // 음색(프리셋) — 이름 칸에 늘 있던 선택 칸을 여기로. 이름이 잘리지 않게 자리를 내준다
    ...(pickedTrack && ready && Object.keys(resolveInstrument(pickedTrack.instrumentId, registry).tones).length > 1 ? [{
      id: 'track.tone', label: '음색', separator: true,
      options: Object.keys(resolveInstrument(pickedTrack.instrumentId, registry).tones).map((tone) => ({
        label: tone === 'default' ? '기본' : tone,
        checked: pickedTrack.toneId === tone,
        run: () => editor.commit(updateTrack(project, pickedTrack.id, { toneId: tone })),
      })),
    } satisfies MenuAction] : []),
    { id: 'track.delete', label: '트랙 삭제', separator: true, disabled: !pickedTrack, run: () => editor.commit(deleteTrack(project, pickedTrack!.id)) },
  ];
  const hiddenCount = project.tracks.filter((t) => t.hidden).length;
  const visibleRows: ({ kind: 'track'; track: Track } | { kind: 'stack'; stack: TrackStack; members: Track[] })[] = [];
  {
    const seenStacks = new Set<string>();
    for (const track of project.tracks) {
      const stack = track.stackId ? project.stacks?.find((s) => s.id === track.stackId) : undefined;
      if (stack && !seenStacks.has(stack.id)) {
        seenStacks.add(stack.id);
        visibleRows.push({ kind: 'stack', stack, members: project.tracks.filter((t) => t.stackId === stack.id) });
      }
      if (stack?.collapsed) continue;
      if (track.hidden && !showHidden) continue;
      visibleRows.push({ kind: 'track', track });
    }
  }
  /** 가장 가까운 마디 경계로 */
  const snapToBar = (tick: number) => [...lines.map((l) => l.tick), totalTicks]
    .reduce((best, t) => (Math.abs(t - tick) < Math.abs(best - tick) ? t : best), 0);

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
    const snapped = snapToBar(clipDrag.originTick + deltaTicks);
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
    const tick = ((event.clientX - rect.left) / rect.width) * totalTicks;
    const line = lines.reduce((found, l) => (l.tick <= tick ? l : found), lines[0]!);
    const bar = line.bar;

    const length = (lines[Math.min(lines.length, bar + 4)]?.tick ?? totalTicks) - line.tick;
    try {
      const { project: next, clipId } = addClip(project, {
        trackId,
        startTick: line.tick,
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
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <div className="flex shrink-0 items-center gap-2 pr-1">
          <h2 className="mr-2 font-disp text-lg leading-none text-ink">
            트랙 <span className="text-ink-3">{project.tracks.length}</span>
          </h2>
          {hiddenCount > 0 && (
            <button
              type="button"
              aria-pressed={showHidden}
              onClick={() => setShowHidden((v) => !v)}
              className={`h-6 rounded border px-1.5 text-[11px] ${showHidden ? 'border-ink bg-ink text-body' : 'border-rule bg-panel text-ink-2'}`}
            >숨긴 트랙 {hiddenCount}</button>
          )}
          <button
            type="button"
            onClick={onAddTrack}
            className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3"
          >
            ＋ 트랙
          </button>
          <button
            type="button"
            onClick={() => {
              const added = addTrack(project, { name: `오디오 ${project.tracks.filter((t) => t.kind === 'audio').length + 1}`, instrumentId: 'acoustic-guitar' });
              editor.commit({ ...added.project, tracks: added.project.tracks.map((t) => (t.id === added.trackId ? { ...t, kind: 'audio' as const } : t)) });
              onSelectTrack(added.trackId);
            }}
            title="마이크로 녹음하거나 오디오 파일을 놓는 트랙"
            className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3"
          >＋ 오디오</button>
        </div>
        {/* 도구는 넘치면 옆으로 스크롤한다 — 줄바꿈하면 트랙 영역이 밀려 내려간다 */}
        <MenuButton label="클립" actions={clipMenuAll} title="고른 클립에 하는 일 — 클립을 우클릭해도 같은 목록이 열립니다" />
        <MenuButton label="트랙" actions={trackMenuAll} title="고른 트랙에 하는 일 — 트랙 이름 칸을 우클릭해도 같은 목록이 열립니다" />
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={showGlobals}
          onClick={() => setShowGlobals((v) => !v)}
          title="구간·마커·코드·템포 줄을 보이거나 숨깁니다 (G)"
          className={`h-7 shrink-0 rounded-md border px-2 text-xs ${showGlobals ? 'border-ink bg-ink text-body' : 'border-rule bg-panel text-ink-2'}`}
        >글로벌</button>
      </div>

      <div className="overflow-hidden rounded-xl border border-rule">
        {/* 마디 눈금 */}
        <div className="relative flex h-7 border-b border-grid">
          <div className={`${NAME_COL} shrink-0 border-r border-rule bg-body`} />
          <div
            className="relative flex-1 bg-screen"
            data-ruler
            title="누르면 그 마디로 · 누른 채 끌면 스크럽(지나가는 음이 들린다)"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              scrub.current = { x: e.clientX, tick: ((e.clientX - r.left) / r.width) * totalTicks, moved: false };
            }}
            onPointerMove={(e) => {
              const s = scrub.current;
              if (!s || e.buttons === 0) return;
              if (!s.moved && Math.abs(e.clientX - s.x) < 4) return;
              if (!s.moved) { s.moved = true; e.currentTarget.setPointerCapture(e.pointerId); }
              const r = e.currentTarget.getBoundingClientRect();
              const tick = Math.max(0, Math.min(totalTicks, ((e.clientX - r.left) / r.width) * totalTicks));
              onScrub?.(s.tick, tick);
              s.tick = tick;
              onSeek(tick);
            }}
            onPointerUp={() => {
              if (scrub.current?.moved) scrubbed.current = true;
              scrub.current = null;
            }}
          >
            {lines.map((line) => {
              const keyChange = (project.keyChanges ?? []).find((k) => k.tick === line.tick);
              const picked = globalSelection?.kind === 'bar' && globalSelection.bar === line.bar;
              return (
                <button
                  key={line.bar}
                  type="button"
                  data-bar={line.bar + 1}
                  onClick={() => {
                    if (scrubbed.current) { scrubbed.current = false; return; }
                    onGlobalSelect(picked ? null : { kind: 'bar', bar: line.bar });
                    onSeek(line.tick);
                  }}
                  title={`${line.bar + 1}마디 — 눌러서 이 마디부터의 박자·조성을 바꿉니다`}
                  style={{ left: pct(line.tick), width: pct(line.lengthTick) }}
                  className={`absolute inset-y-0 flex items-center gap-1 overflow-hidden border-l border-grid pl-1.5 text-left font-num text-[13px] ${
                    picked ? 'bg-acc/25 text-sink' : 'text-sink-2 hover:text-sink'}`}
                >
                  {line.bar + 1}
                  {(line.changed || (line.bar === 0 && (project.signatureChanges?.length ?? 0) > 0)) && (
                    <span className="rounded-sm bg-grid-2 px-1 text-[10px] text-acc-2">
                      {line.timeSignature.num}/{line.timeSignature.den}
                    </span>
                  )}
                  {keyChange && (
                    <span className="rounded-sm bg-grid-2 px-1 text-[10px] text-sink">
                      {keyChange.key.tonic}{keyChange.key.mode === 'minor' ? 'm' : ''}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {showGlobals && <GlobalTracks
          editor={editor}
          lines={lines}
          totalTicks={totalTicks}
          nameCol={NAME_COL}
          selection={globalSelection}
          onSelect={onGlobalSelect}
          onSeek={onSeek}
          onNotice={onNotice}
        />}

        {project.tracks.length === 0 && (
          <p className="bg-body p-4 text-sm text-ink-3">
            트랙이 없습니다. 위의 <b>＋ 트랙</b>를 누르면 악기와 클립이 함께 만들어집니다.
          </p>
        )}

        {visibleRows.map((row) => row.kind === 'stack' ? (
          <div key={row.stack.id} data-stack={row.stack.id} className="flex border-b border-grid">
            <div style={{ height: 32 }} className={`flex ${NAME_COL} shrink-0 items-center gap-1.5 border-r border-rule bg-panel px-2`}>
              <button
                type="button"
                aria-label={row.stack.collapsed ? `${row.stack.name} 펼치기` : `${row.stack.name} 접기`}
                onClick={() => editor.commit(updateStack(project, row.stack.id, { collapsed: !row.stack.collapsed }))}
                className="h-6 w-6 shrink-0 rounded border border-rule bg-body text-[11px] text-ink-2"
              >{row.stack.collapsed ? '▸' : '▾'}</button>
              <input
                aria-label="스택 이름"
                value={row.stack.name}
                onChange={(e) => editor.preview(updateStack(project, row.stack.id, { name: e.target.value || ' ' }))}
                onBlur={() => editor.commitCurrent()}
                className="h-6 w-36 min-w-0 rounded border border-transparent bg-transparent px-1 text-xs font-semibold text-ink hover:border-rule"
              />
              <span className="text-[11px] text-ink-3">{row.members.length}트랙</span>
              <span className="flex-1" />
              <button type="button" title="스택 전체 뮤트" onClick={() => editor.commit(toggleStackFlag(project, row.stack.id, 'mute'))}
                className={`${TOGGLE_BASE} ${row.members.every((t) => t.mute) ? MUTE_ON : TOGGLE_OFF}`}>M</button>
              <button type="button" title="스택 전체 솔로" onClick={() => editor.commit(toggleStackFlag(project, row.stack.id, 'solo'))}
                className={`${TOGGLE_BASE} ${row.members.every((t) => t.solo) ? SOLO_ON : TOGGLE_OFF}`}>S</button>
              <button type="button" title="스택을 풀고 트랙을 그대로 둡니다"
                onClick={() => editor.commit(ungroupStack(project, row.stack.id))}
                className="h-6 shrink-0 rounded border border-rule bg-body px-1.5 text-[11px] text-ink-2 hover:border-ink-3">풀기</button>
            </div>
            {/* 접혔을 때도 어디에 음악이 있는지는 보여 준다 — 멤버 클립을 겹쳐 그린다 */}
            <div style={{ height: 32 }} className="relative flex-1 bg-screen-2">
              {row.members.flatMap((t) => t.clips.map((c) => (
                <span key={c.id} style={{ left: pct(c.startTick), width: pct(c.lengthTick) }}
                  className={`absolute inset-y-2 rounded-sm opacity-60 ${(TRACK_COLORS[c.color ?? t.color] ?? FALLBACK_COLOR).head}`} />
              )))}
            </div>
          </div>
        ) : ((track) => (<Fragment key={track.id}>
          <div data-track={track.name} className={`flex border-b border-grid last:border-b-0 ${track.hidden ? 'opacity-50' : ''}`}>
            {/* 왼쪽 칸 = 이 트랙의 설정. 오른쪽 레인과 **같은 행**이라 눈이 오가지 않는다 */}
            <div
              style={{ height: LANE_HEIGHT }}
              data-track-head
              onContextMenu={(e) => { e.preventDefault(); onSelectTrack(track.id); setContextMenu({ kind: 'track', x: e.clientX, y: e.clientY }); }}
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
              {track.stackId && <span aria-hidden="true" className="-ml-1 h-7 w-1.5 shrink-0 border-l border-dashed border-ink-3" />}
              {track.locked && <span title="보호됨 — 고칠 수 없습니다" className="shrink-0 text-[11px]">🔒</span>}
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
                onChange={(event) => {
                  const value = Number(event.target.value);
                  // 재생 중이고 기록 모드면 페이더가 **볼륨 곡선**을 쓴다 (Logic 과 같다)
                  if (playheadTick !== null && (track.automationMode ?? 'read') !== 'read') {
                    const st = recording.current.get(track.id) ?? { lastTick: null, latched: false, touching: false, value };
                    recording.current.set(track.id, { ...st, touching: true, value: value / Math.max(0.001, track.gain) });
                    return;
                  }
                  editor.preview(updateTrack(project, track.id, { gain: value }));
                }}
                onPointerUp={() => {
                  const st = recording.current.get(track.id);
                  if (st) recording.current.set(track.id, { ...st, touching: false });
                  else editor.commitCurrent();
                }}
                className="w-12 shrink-0 accent-ink"
              />
              {/* **페이더 바로 옆에 둔다.** 어느 트랙이 큰지 보고 그 자리에서
                  줄일 수 있어야 의미가 있다 — 멀리 있으면 안 본다 */}
              {readLevel && (
                <LevelMeter
                  className="w-9 shrink-0"
                  label={`${track.name} 레벨`}
                  read={() => readLevel(track.id)}
                />
              )}
              <button
                type="button"
                aria-pressed={autoOpen[track.id] !== undefined}
                aria-label={`${track.name} 오토메이션`}
                title="오토메이션 곡선 보기 (볼륨·팬·이펙트)"
                onClick={() => setAutoOpen((m) => {
                  const next = { ...m };
                  if (next[track.id]) delete next[track.id];
                  // 곡선이 이미 있는 대상부터 연다 — 없으면 볼륨
                  else next[track.id] = track.automation[0]?.target ?? 'volume';
                  return next;
                })}
                className={`h-7 w-7 shrink-0 rounded border text-xs font-semibold ${
                  autoOpen[track.id] ? 'border-acc bg-acc text-acc-ink'
                    : track.automation.length > 0 ? 'border-acc text-ink' : 'border-rule text-ink-3 hover:border-ink-3'}`}
              >A</button>
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
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(track.id, clip.id); setContextMenu({ kind: 'clip', x: e.clientX, y: e.clientY }); }}
                    style={{ left: pct(clip.startTick), width: pct(clip.lengthTick) }}
                    data-muted={clip.muted ? 'true' : undefined}
                    className={`absolute inset-y-1 flex items-center overflow-hidden rounded-md pl-1.5 pt-2 text-[10px] ${
                      (TRACK_COLORS[clip.color ?? track.color] ?? FALLBACK_COLOR).clip
                    } ${selected ? 'ring-[1.5px] ring-acc' : ''} ${clip.muted ? 'opacity-40' : ''}`}
                  >
                    <i className={`pointer-events-none absolute inset-x-0 top-0 h-1.5 ${(TRACK_COLORS[clip.color ?? track.color] ?? FALLBACK_COLOR).head}`} />
                    {clip.audio && <ClipWave assetId={clip.audio.assetId} from={clip.audio.offsetSec / clip.audio.assetSec} />}
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
                      <span className={clip.muted ? 'line-through' : ''}>{clip.audio ? '🎙 ' : ''}{clip.label || '클립'}</span>
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
                          // 끝을 가장 가까운 마디 경계에 — 박자가 바뀌어도 마디 단위로 맞는다
                          const end = Math.max(snapToBar(endTick), lines.find((l) => l.tick > clip.startTick)?.tick ?? totalTicks);
                          editor.preview(resizeClip(origin, clip.id, end - clip.startTick));
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
          {autoOpen[track.id] && (
            <AutomationLane
              editor={editor}
              track={track}
              instrument={instrumentFor?.(track) ?? null}
              target={autoOpen[track.id]!}
              onTarget={(target) => setAutoOpen((m) => ({ ...m, [track.id]: target }))}
              nameCol={NAME_COL}
              totalTicks={totalTicks}
              snap={(tick) => Math.round(tick / (PPQ / 4)) * (PPQ / 4)}
            />
          )}
        </Fragment>))(row.track))}

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
      {contextMenu && (
        <Menu
          actions={contextMenu.kind === 'clip' ? clipMenuAll : trackMenuAll}
          x={contextMenu.x} y={contextMenu.y}
          label={contextMenu.kind === 'clip' ? '클립' : '트랙'}
          onClose={() => setContextMenu(null)}
        />
      )}
    </section>
  );
}

/** 오디오 클립 안의 파형 — 쓰는 구간부터 */
function ClipWave({ assetId, from }: { assetId: string; from: number }) {
  const p = usePeaks(assetId, 160);
  if (!p) return null;
  const start = Math.floor(from * p.length);
  const bars = [...p.slice(start)];
  return (
    <svg viewBox={`0 0 ${bars.length} 20`} preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-0.5 top-3 h-auto w-full opacity-70">
      {bars.map((v, i) => <rect key={i} x={i} y={10 - v * 10} width={0.8} height={Math.max(0.3, v * 20)} fill="currentColor" className="text-sink" />)}
    </svg>
  );
}

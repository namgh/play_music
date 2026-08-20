import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudPanel } from './ui/CloudPanel.tsx';

import { BRAND } from './brand.ts';
import {
  addClip, addTrack, copyNotes, deleteNotes, duplicateNotes, moveNotes, pasteNotes,
  moveNotesToTrack, quantizeNotes, setKey, setLoop, setLoopEnabled, setSwing, setTempo,
  setTempoChange,
} from './editor/edits.ts';
import { useProjectEditor } from './editor/useProjectEditor.ts';
import { downloadProject, loadAutosave, readProjectFile, saveAutosave } from './editor/projectStorage.ts';
import { decodeMidi, encodeMidi } from './model/midi.ts';
import { createEmptyProject } from './model/factory.ts';
import type { ClipId, MusicalKey, Note, Project, TrackId } from './model/project.ts';
import { NOTE_NAMES } from './model/pitch.ts';
import { PPQ, ticksPerBar, ticksToBarBeat } from './model/time.ts';
import { createRegistry, playableInstrumentIds } from './instruments/definitions.ts';
import { resolveInstrument } from './instruments/resolve.ts';
import { ENGINE_LABELS, useAudioEngine } from './audio/useAudioEngine.ts';
import { PianoRoll } from './ui/PianoRoll.tsx';
import { EditorToolbar } from './ui/EditorToolbar.tsx';
import { collectGhosts } from './ui/ghostNotes.ts';
import type { GhostMode } from './ui/ghostNotes.ts';
import { clampRange, rangeOfNotes } from './ui/noteRange.ts';
import type { FoldMode, NoteRange } from './ui/noteRange.ts';
import { VelocityLane } from './ui/VelocityLane.tsx';
import { PitchCurveLane } from './ui/PitchCurveLane.tsx';
import { NoteInspector } from './ui/NoteInspector.tsx';
import { TrackList } from './ui/TrackList.tsx';
import { TuningLab } from './ui/TuningLab.tsx';
import { Timeline } from './ui/Timeline.tsx';
import { Mixer } from './ui/Mixer.tsx';

const registry = createRegistry();

/** 트랙·악기가 없을 때 쓰는 음역. 화면이 비지 않게만 하면 된다 */
const FALLBACK_RANGE = { low: 36, high: 84 };

const GRID_OPTIONS: { label: string; ticks: number }[] = [
  { label: '1/4', ticks: PPQ },
  { label: '1/8', ticks: PPQ / 2 },
  { label: '1/16', ticks: PPQ / 4 },
  { label: '1/32', ticks: PPQ / 8 },
];

const VIEWS = [
  ['editor', '편집기'],
  ['mixer', '믹서'],
  ['tuning', '튜닝 도구'],
] as const;
type View = (typeof VIEWS)[number][0];

/** 빈 프로젝트에 트랙 하나 + 클립 하나. 아무것도 없으면 찍을 곳이 없다 */
function starterProject(): Project {
  const empty = createEmptyProject('새 프로젝트');
  empty.tempo.bpm = 96;
  empty.lengthBars = 8;

  const instrumentId = playableInstrumentIds()[0] ?? 'acoustic-guitar';
  const withTrack = addTrack(empty, {
    name: resolveInstrument(instrumentId, registry).name,
    instrumentId,
  });
  const withClip = addClip(withTrack.project, {
    trackId: withTrack.trackId,
    startTick: 0,
    lengthTick: 4 * ticksPerBar(empty.timeSignature),
    label: '클립 1',
  });
  return withClip.project;
}

export function App() {
  // 자동 저장이 있으면 그것으로 시작한다 — 새로고침으로 작업이 사라지면 안 된다
  const editor = useProjectEditor(useMemo(() => loadAutosave() ?? starterProject(), []));
  const { project, selection } = editor;

  const [selectedTrackId, setSelectedTrackId] = useState<TrackId | null>(project.tracks[0]?.id ?? null);
  const [selectedClipId, setSelectedClipId] = useState<ClipId | null>(
    project.tracks[0]?.clips[0]?.id ?? null,
  );
  const [gridTicks, setGridTicks] = useState(PPQ / 4);
  /**
   * 새로 찍는 음의 길이. **격자와 분리한다** — 16분 격자에 정확히 맞추면서
   * 4분음표를 넣고 싶은 건 흔한 요구인데, 묶여 있으면 매번 늘려야 했다
   */
  const [noteLengthTicks, setNoteLengthTicks] = useState(PPQ / 4);
  /** 피아노롤 줌. 8마디만 돼도 가로가 화면 밖으로 나가서 필요하다 */
  const [zoomX, setZoomX] = useState(1);
  const [zoomY, setZoomY] = useState(1);
  /** 새로 찍는 음의 세기. 예전에는 전부 기본값으로 들어갔다 */
  const [inputVelocity, setInputVelocity] = useState(0.8);
  const [view, setView] = useState<View>('editor');
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const midiInput = useRef<HTMLInputElement | null>(null);

  /**
   * 편집 커서 (클립 기준 틱). **두 기능이 이걸 공유한다** —
   * "어디부터 재생하나"와 "어디에 붙여넣나"는 같은 개념이다 (`WORKPLAN.md` 2-6).
   */
  const [cursorTick, setCursorTick] = useState(0);
  /** 앱 안 클립보드. OS 클립보드를 쓰지 않는다 (권한·형식 협상 대비 얻는 게 적다) */
  const clipboard = useRef<Note[]>([]);
  const [clipboardSize, setClipboardSize] = useState(0);
  /** 메트로놈은 곡이 아니라 도구다 — 프로젝트에 저장하지 않고 내보내기에도 안 섞인다 */
  const [metronome, setMetronome] = useState(false);
  /**
   * **클립별** 표시 음역. **곡이 아니라 보기 설정**이라 프로젝트에 저장하지 않는다
   * (`plan.md` 5-4 — 프로젝트 데이터는 곡 자체다).
   *
   * 트랙이 아니라 클립으로 기억하는 이유: "1절은 저음, 2절은 고음" 이 같은 트랙의
   * 다른 클립이다. 트랙으로 묶으면 2절을 고음으로 바꾼 순간 1절 화면도 같이 바뀐다
   * (음 자체는 안 바뀌지만 매번 다시 맞춰야 한다).
   */
  const [rangeByClip, setRangeByClip] = useState<Record<string, NoteRange>>({});
  /** 안 쓰는 줄 접기. 보기 설정이라 저장하지 않는다 */
  const [fold, setFold] = useState<FoldMode>('off');
  /**
   * 트랙별 고스트 모드 (숨김 / 표시 / 편집).
   *
   * Cubase 13 Key Editor 처럼 **표시와 편집을 나눈다** — 멜로디를 보면서 베이스를
   * 쓰는 게 기본 동작이고, 그때 멜로디를 실수로 건드리면 안 된다.
   */
  const [ghostModes, setGhostModes] = useState<Record<string, GhostMode>>({});

  const engine = useAudioEngine(project, registry);

  const track = project.tracks.find((t) => t.id === selectedTrackId) ?? project.tracks[0] ?? null;
  const clip = track?.clips.find((c) => c.id === selectedClipId) ?? track?.clips[0] ?? null;
  const instrument = track ? resolveInstrument(track.instrumentId, registry) : null;

  // 자동 저장 — 편집이 멈춘 뒤 잠깐 기다렸다 쓴다 (매 편집마다 쓰면 낭비다)
  useEffect(() => {
    const timer = setTimeout(() => saveAutosave(project), 600);
    return () => clearTimeout(timer);
  }, [project]);

  // 삭제된 트랙을 가리키고 있으면 살아 있는 것으로 옮긴다
  useEffect(() => {
    if (selectedTrackId && !project.tracks.some((t) => t.id === selectedTrackId)) {
      setSelectedTrackId(project.tracks[0]?.id ?? null);
      setSelectedClipId(project.tracks[0]?.clips[0]?.id ?? null);
    }
  }, [project.tracks, selectedTrackId]);

  const audition = useCallback(
    (midi: number, cents: number) => {
      if (track) void engine.audition(track.id, midi, cents);
    },
    [engine, track],
  );

  // 메트로놈 상태를 엔진에 반영한다. `engine` 전체가 아니라 setter 에만 의존한다 —
  // `engine` 은 렌더마다 새 객체라 매 렌더 실행된다
  const engineSetMetronome = engine.setMetronome;
  useEffect(() => { engineSetMetronome(metronome); }, [engineSetMetronome, metronome]);

  // --- 복사 · 붙여넣기 · 복제 -------------------------------------------------

  const doCopy = useCallback(() => {
    const picked = copyNotes(project, selection);
    if (picked.length === 0) return;
    clipboard.current = picked;
    setClipboardSize(picked.length);
    setNotice(`${picked.length}개 복사`);
  }, [project, selection]);

  const doPaste = useCallback(() => {
    if (!clip || clipboard.current.length === 0) return;
    try {
      const { project: next, noteIds } = pasteNotes(project, clip.id, clipboard.current, cursorTick);
      editor.commit(next);
      editor.select(noteIds);
      setNotice(`${noteIds.length}개 붙여넣기`);
    } catch (err) {
      setNotice(`붙여넣기 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [clip, cursorTick, editor, project]);

  const doDuplicate = useCallback(() => {
    if (selection.length === 0) return;
    const { project: next, noteIds } = duplicateNotes(project, selection);
    if (noteIds.length === 0) return;
    editor.commit(next);
    editor.select(noteIds);
  }, [editor, project, selection]);

  /** 선택 구간을 루프로 잡는다. 선택이 없으면 클립 전체 */
  const loopFromSelection = useCallback(() => {
    if (!clip) return;
    const notes = clip.notes.filter((n) => selection.includes(n.id));
    const startTick = notes.length > 0 ? Math.min(...notes.map((n) => n.startTick)) : 0;
    const endTick = notes.length > 0
      ? Math.max(...notes.map((n) => n.startTick + n.lengthTick))
      : clip.lengthTick;
    editor.commit(setLoop(project, { startTick, endTick, enabled: true }));
  }, [clip, editor, project, selection]);

  const onOpenFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const loaded = await readProjectFile(file);
      editor.commit(loaded);
      setSelectedTrackId(loaded.tracks[0]?.id ?? null);
      setSelectedClipId(loaded.tracks[0]?.clips[0]?.id ?? null);
      editor.select([]);
      setNotice(`"${loaded.name}" 을 열었습니다 (트랙 ${loaded.tracks.length}개)`);
    } catch (err) {
      setNotice(`열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 단축키
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

      const meta = event.metaKey || event.ctrlKey;
      if (meta) {
        switch (event.key.toLowerCase()) {
          case 's':
            event.preventDefault();
            downloadProject(project);
            setNotice('파일로 저장했습니다');
            return;
          case 'z':
            event.preventDefault();
            if (event.shiftKey) editor.redo();
            else editor.undo();
            return;
          case 'c':
            event.preventDefault();
            doCopy();
            return;
          case 'v':
            event.preventDefault();
            doPaste();
            return;
          case 'd':
            event.preventDefault();
            doDuplicate();
            return;
          case 'a':
            event.preventDefault();
            if (clip) editor.select(clip.notes.map((n) => n.id));
            return;
          case 'l':
            event.preventDefault();
            loopFromSelection();
            return;
          default:
            break;
        }
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        // **커서부터 재생한다.** 예전에는 항상 0 이라 8마디 곡의 7마디를 고치려면
        // 매번 앞 6마디를 다 들어야 했다
        if (engine.state === 'playing') engine.stop();
        else void engine.play(cursorTick + (clip?.startTick ?? 0));
        return;
      }
      if (event.key === 'Escape') {
        editor.select([]);
        return;
      }
      if (selection.length === 0) return;

      switch (event.key) {
        case 'Backspace':
        case 'Delete':
          event.preventDefault();
          editor.commit(deleteNotes(project, selection));
          editor.select([]);
          break;
        case 'ArrowUp':
          event.preventDefault();
          editor.commit(moveNotes(project, selection, { semitones: event.shiftKey ? 12 : 1 }));
          break;
        case 'ArrowDown':
          event.preventDefault();
          editor.commit(moveNotes(project, selection, { semitones: event.shiftKey ? -12 : -1 }));
          break;
        case 'ArrowLeft':
          event.preventDefault();
          editor.commit(moveNotes(project, selection, { ticks: -gridTicks }));
          break;
        case 'ArrowRight':
          event.preventDefault();
          editor.commit(moveNotes(project, selection, { ticks: gridTicks }));
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    clip, cursorTick, doCopy, doDuplicate, doPaste, editor, engine, gridTicks,
    loopFromSelection, project, selection,
  ]);

  // 재생 중에는 커서가 재생 위치를 따라간다 — 멈춘 자리에서 다시 시작하려면 필요하다
  useEffect(() => {
    if (engine.state !== 'playing' || engine.playheadTick === null || !clip) return;
    setCursorTick(Math.max(0, engine.playheadTick - clip.startTick));
  }, [clip, engine.playheadTick, engine.state]);

  const instrumentRange = instrument ? clampRange(instrument.range) : FALLBACK_RANGE;

  /** 지금 클립의 표시 음역. 기억된 게 없으면 악기 음역 */
  const viewRange: NoteRange = (clip && rangeByClip[clip.id]) ?? instrumentRange;

  const setViewRange = useCallback((next: NoteRange) => {
    if (!clip) return;
    setRangeByClip((prev) => ({ ...prev, [clip.id]: next }));
  }, [clip]);

  /**
   * 처음 여는 클립은 **그 클립의 음에 맞춰** 시작한다. 악기 음역(5옥타브일 수 있다)으로
   * 열면 매번 손으로 좁혀야 한다.
   *
   * `clip.id` 에만 의존한다 — 음 목록에 의존하면 편집할 때마다 화면이 튄다.
   */
  useEffect(() => {
    if (!clip || rangeByClip[clip.id]) return;
    const midis = clip.notes.map((n) => n.pitch.midi);
    setRangeByClip((prev) => (
      prev[clip.id] ? prev : { ...prev, [clip.id]: rangeOfNotes(midis, instrumentRange) }
    ));
    // eslint 규칙보다 의도가 우선이다: 음이 바뀔 때 다시 맞추면 안 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id]);

  /** 다른 트랙의 음을 이 클립의 좌표계로 옮겨 놓은 것 */
  const ghosts = useMemo(
    () => (clip ? collectGhosts(project, track?.id ?? null, clip, ghostModes) : []),
    [clip, ghostModes, project, track?.id],
  );

  const setGhostMode = useCallback((trackId: string, mode: GhostMode) => {
    setGhostModes((prev) => ({ ...prev, [trackId]: mode }));
  }, []);

  const barTicks = ticksPerBar(project.timeSignature);

  const position = engine.playheadTick === null
    ? '1.1.00'
    : (() => {
        const bb = ticksToBarBeat(Math.max(0, engine.playheadTick), project.timeSignature);
        return `${bb.bar}.${bb.beat}.${Math.floor(bb.fraction * 100).toString().padStart(2, '0')}`;
      })();

  return (
    <div className="min-h-dvh bg-neutral-950 text-neutral-200">
      <div className="mx-auto max-w-[1400px] px-6 py-8">
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-white">{BRAND.name}</h1>
          {BRAND.isPlaceholder && <span className="text-xs text-neutral-500">이름 임시</span>}
          <input
            aria-label="프로젝트 이름"
            value={project.name}
            onChange={(e) => editor.preview({ ...project, name: e.target.value })}
            onBlur={() => editor.commitCurrent()}
            className="rounded border border-transparent bg-transparent px-2 py-1 text-sm text-neutral-300 hover:border-neutral-800 focus:border-neutral-700"
          />
          <span className="flex-1" />
          {engine.engineKind && (
            <span className="font-mono text-xs text-neutral-500">
              DSP: {ENGINE_LABELS[engine.engineKind]}
            </span>
          )}
        </header>

        <nav className="mt-5 flex gap-1 border-b border-neutral-800">
          {VIEWS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm ${
                view === id
                  ? 'border-teal-300 text-white'
                  : 'border-transparent text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* 트랜스포트 — 어느 화면에서든 보인다 */}
        <section className="mt-6 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 p-3">
          <button
            type="button"
            onClick={() => (engine.state === 'playing'
              ? engine.stop()
              : void engine.play(cursorTick + (clip?.startTick ?? 0)))}
            className="rounded-md bg-teal-300 px-5 py-2 text-sm font-semibold text-teal-950 hover:bg-teal-200"
          >
            {engine.state === 'playing' ? '정지' : '재생'}
          </button>
          <button
            type="button"
            onClick={() => { engine.stop(); setCursorTick(0); }}
            title="맨 앞으로"
            className="rounded border border-neutral-700 px-2.5 py-2 text-sm text-neutral-300"
          >처음</button>
          <span className="w-20 text-center font-mono text-sm text-neutral-300">{position}</span>

          <button
            type="button"
            onClick={() => setMetronome((on) => !on)}
            aria-pressed={metronome}
            title="메트로놈"
            className={`rounded border px-2.5 py-1.5 text-sm ${
              metronome
                ? 'border-teal-600 bg-teal-950/60 text-teal-200'
                : 'border-neutral-700 text-neutral-400'
            }`}
          >메트로놈</button>

          <button
            type="button"
            onClick={() => {
              if (project.loop === null) loopFromSelection();
              else editor.commit(setLoopEnabled(project, !project.loop.enabled));
            }}
            aria-pressed={project.loop?.enabled ?? false}
            title="반복 구간 (⌘L 로 선택 구간을 잡습니다)"
            className={`rounded border px-2.5 py-1.5 text-sm ${
              project.loop?.enabled
                ? 'border-teal-600 bg-teal-950/60 text-teal-200'
                : 'border-neutral-700 text-neutral-400'
            }`}
          >반복</button>
          {project.loop && (
            <span className="font-mono text-xs text-neutral-300">
              {(project.loop.startTick / barTicks + 1).toFixed(2)}–
              {(project.loop.endTick / barTicks + 1).toFixed(2)}
              <button
                type="button"
                onClick={() => editor.commit(setLoop(project, null))}
                className="ml-1.5 text-neutral-400 hover:text-neutral-100"
                title="반복 구간 지우기"
              >지우기</button>
            </span>
          )}

          <label className="ml-2 text-xs text-neutral-500" htmlFor="bpm">BPM</label>
          <input
            id="bpm"
            type="number"
            min={20} max={300}
            value={project.tempo.bpm}
            onChange={(e) => editor.commit(setTempo(project, Number(e.target.value)))}
            className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm"
          />
          <label className="ml-2 text-xs text-neutral-500" htmlFor="bars">마디</label>
          <input
            id="bars"
            type="number"
            min={1} max={512}
            value={project.lengthBars}
            onChange={(e) =>
              editor.commit({ ...project, lengthBars: Math.max(1, Math.round(Number(e.target.value))) })}
            className="w-16 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-sm"
          />

          <label className="ml-2 text-xs text-neutral-500" htmlFor="grid">격자</label>
          <select
            id="grid"
            value={gridTicks}
            onChange={(e) => setGridTicks(Number(e.target.value))}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
          >
            {GRID_OPTIONS.map((option) => (
              <option key={option.label} value={option.ticks}>{option.label}</option>
            ))}
          </select>

          {/* 음 길이 — **격자와 다른 축이다.** 16분 격자에 4분음표를 찍을 수 있어야 한다 */}
          <label className="ml-2 text-xs text-neutral-500" htmlFor="notelen">음 길이</label>
          <select
            id="notelen"
            value={noteLengthTicks}
            onChange={(e) => setNoteLengthTicks(Number(e.target.value))}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
            title="새로 찍는 음의 길이 (Alt 를 누르면 격자에 안 맞춥니다)"
          >
            {GRID_OPTIONS.map((option) => (
              <option key={option.label} value={option.ticks}>{option.label}</option>
            ))}
          </select>

          {/* 스윙 — **곡의 성격이라 프로젝트에 저장된다** */}
          <label className="ml-2 text-xs text-neutral-500" htmlFor="swing">스윙</label>
          <input
            id="swing"
            type="range"
            min={0}
            max={0.6}
            step={0.05}
            value={project.swing ?? 0}
            onChange={(e) => editor.commit(setSwing(project, Number(e.target.value)))}
            className="w-20"
            title={`뒷박을 ${Math.round((project.swing ?? 0) * 100)}% 뒤로 (1/3 이 삼잇단)`}
          />

          {/* 템포 변화 — 커서 위치에 지점을 놓는다 */}
          <button
            type="button"
            onClick={() => {
              const at = cursorTick + (clip?.startTick ?? 0);
              if (at <= 0) {
                setNotice('곡 시작 템포는 BPM 칸에서 바꿉니다');
                return;
              }
              const existing = (project.tempo.changes ?? []).find((c) => c.tick === at);
              if (existing) {
                editor.commit(setTempoChange(project, at, null));
                setNotice('템포 변화를 지웠습니다');
                return;
              }
              editor.commit(setTempoChange(project, at, project.tempo.bpm));
              setNotice('커서 위치에 템포 변화를 놓았습니다 — BPM 칸에서 값을 바꾸세요');
            }}
            className="rounded border border-neutral-700 px-2 py-1 text-sm"
            title="커서 위치에 템포 변화를 놓거나 지웁니다"
          >템포 변화{(project.tempo.changes?.length ?? 0) > 0 ? ` (${project.tempo.changes!.length})` : ''}</button>

          {/* 세기 — 찍을 때 적용된다 */}
          <label className="ml-2 text-xs text-neutral-500" htmlFor="vel">세기</label>
          <input
            id="vel"
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={inputVelocity}
            onChange={(e) => setInputVelocity(Number(e.target.value))}
            className="w-20"
            title={`새로 찍는 음의 세기 ${Math.round(inputVelocity * 100)}%`}
          />

          {/* 줌 — 가로는 마디를, 세로는 줄을 늘린다 */}
          <span className="ml-2 text-xs text-neutral-500">확대</span>
          <button
            type="button"
            onClick={() => setZoomX((z) => Math.max(0.25, z / 1.5))}
            className="rounded border border-neutral-700 px-2 py-1 text-sm"
            title="가로 축소"
          >가로 −</button>
          <button
            type="button"
            onClick={() => setZoomX((z) => Math.min(8, z * 1.5))}
            className="rounded border border-neutral-700 px-2 py-1 text-sm"
            title="가로 확대"
          >＋</button>
          <button
            type="button"
            onClick={() => setZoomY((z) => Math.max(0.5, z / 1.3))}
            className="rounded border border-neutral-700 px-2 py-1 text-sm"
            title="세로 축소"
          >세로 −</button>
          <button
            type="button"
            onClick={() => setZoomY((z) => Math.min(4, z * 1.3))}
            className="rounded border border-neutral-700 px-2 py-1 text-sm"
            title="세로 확대"
          >＋</button>

          {/* 조성 — 피아노롤 스케일 표시용. 렌더에는 영향이 없다 */}
          <label className="ml-2 text-xs text-neutral-500" htmlFor="key">조성</label>
          <select
            id="key"
            value={project.key === null ? '' : `${project.key.tonic}|${project.key.mode}`}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') { editor.commit(setKey(project, null)); return; }
              const [tonic, mode] = raw.split('|');
              editor.commit(setKey(project, { tonic: tonic!, mode: mode as MusicalKey['mode'] }));
            }}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
          >
            <option value="">없음</option>
            {NOTE_NAMES.map((tonic) => (
              <option key={`${tonic}-major`} value={`${tonic}|major`}>{tonic} 장조</option>
            ))}
            {NOTE_NAMES.map((tonic) => (
              <option key={`${tonic}-minor`} value={`${tonic}|minor`}>{tonic} 단조</option>
            ))}
          </select>

          <span className="flex-1" />

          <button
            type="button"
            disabled={selection.length === 0}
            onClick={doCopy}
            title="복사 (⌘C)"
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
          >복사</button>
          <button
            type="button"
            disabled={clipboardSize === 0}
            onClick={doPaste}
            title="커서 위치에 붙여넣기 (⌘V)"
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
          >붙여넣기{clipboardSize > 0 ? ` (${clipboardSize})` : ''}</button>

          {/* 선택한 음을 다른 트랙으로 — 드럼에 잘못 찍었을 때 지우고 다시 찍지 않아도 된다 */}
          {selection.length > 0 && project.tracks.length > 1 && (
            <select
              value=""
              aria-label="선택한 음을 다른 트랙으로"
              onChange={(e) => {
                if (!e.target.value) return;
                try {
                  editor.commit(moveNotesToTrack(project, selection, e.target.value as TrackId));
                  setNotice(`${selection.length}개를 옮겼습니다`);
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : String(err));
                }
              }}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
            >
              <option value="">트랙으로 이동…</option>
              {project.tracks
                .filter((t) => t.id !== track?.id)
                .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}

          <button type="button" disabled={!editor.canUndo} onClick={editor.undo}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40">되돌리기</button>
          <button type="button" disabled={!editor.canRedo} onClick={editor.redo}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40">다시 실행</button>
          <button
            type="button"
            disabled={selection.length === 0}
            onClick={() => editor.commit(quantizeNotes(project, selection, gridTicks))}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm disabled:opacity-40"
          >퀀타이즈</button>

          <span className="mx-1 h-6 w-px bg-neutral-800" />

          <button
            type="button"
            onClick={() => { downloadProject(project); setNotice('파일로 저장했습니다'); }}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm"
          >저장</button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm"
          >열기</button>

          {/* 클라우드는 **얹는 기능**이다 — 로그인하지 않아도 위의 파일 저장·열기는 그대로 된다 */}
          <CloudPanel
            project={project}
            onOpen={(loaded) => editor.commit(loaded)}
            onNotice={setNotice}
          />
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => { void onOpenFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          {/* MIDI — 없으면 다른 DAW 와 단절돼 사용자가 갇힌다 (`ROADMAP.md` P3) */}
          <button
            type="button"
            onClick={() => {
              const { bytes, droppedCents } = encodeMidi(project);
              const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/midi' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = `${project.name || 'project'}.mid`;
              link.click();
              URL.revokeObjectURL(url);
              // **버렸다고 알린다.** 조용히 반올림하면 "정밀한 음정"이라는 주장과 어긋난다
              setNotice(droppedCents > 0
                ? `MIDI 로 내보냈습니다 — 센트가 있는 음 ${droppedCents}개는 반올림됐습니다 `
                  + '(MIDI 규격이 정수 음정만 담습니다)'
                : 'MIDI 로 내보냈습니다');
            }}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm"
          >MIDI 내보내기</button>
          <button
            type="button"
            onClick={() => midiInput.current?.click()}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm"
          >MIDI 가져오기</button>
          <input
            ref={midiInput}
            type="file"
            accept=".mid,.midi,audio/midi"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              try {
                const loaded = decodeMidi(
                  new Uint8Array(await file.arrayBuffer()),
                  file.name.replace(/\.midi?$/i, ''),
                );
                editor.commit(loaded);
                setSelectedTrackId(loaded.tracks[0]?.id ?? null);
                setSelectedClipId(loaded.tracks[0]?.clips[0]?.id ?? null);
                editor.select([]);
                setNotice(`"${loaded.name}" 을 가져왔습니다 (트랙 ${loaded.tracks.length}개). `
                  + '악기는 전부 어쿠스틱 기타로 시작합니다 — 트랙마다 바꾸세요');
              } catch (err) {
                setNotice(`MIDI 를 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
              }
            }}
          />

          <button
            type="button"
            disabled={engine.exporting}
            onClick={() => void engine.exportWav()}
            className="rounded border border-teal-700 px-3 py-1.5 text-sm text-teal-200 disabled:opacity-40"
          >{engine.exporting ? '내보내는 중…' : 'WAV 내보내기'}</button>
        </section>

        {/* 피크 경고 — 조용히 잘린 파일이 나가는 것을 막는다 (`ROADMAP.md` P3) */}
        {engine.clipWarning && (
          <p className="mt-3 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
            {engine.clipWarning}
          </p>
        )}

        {(engine.error || notice) && (
          <p
            className={`mt-3 rounded-md border px-4 py-3 text-sm ${
              engine.error
                ? 'border-red-900 bg-red-950/50 text-red-300'
                : 'border-neutral-800 text-neutral-400'
            }`}
          >
            {engine.error ?? notice}
            {!engine.error && (
              <button type="button" onClick={() => setNotice(null)} className="ml-3 text-xs underline">
                닫기
              </button>
            )}
          </p>
        )}

        {view === 'tuning' && <div className="mt-6"><TuningLab /></div>}
        {view === 'mixer' && <div className="mt-6"><Mixer editor={editor} /></div>}

        {view === 'editor' && (
          <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="min-w-0 space-y-6">
              <TrackList
                editor={editor}
                selectedTrackId={track?.id ?? null}
                onSelectTrack={(id) => {
                  setSelectedTrackId(id);
                  setSelectedClipId(project.tracks.find((t) => t.id === id)?.clips[0]?.id ?? null);
                }}
              />

              <Timeline
                editor={editor}
                selectedTrackId={track?.id ?? null}
                selectedClipId={clip?.id ?? null}
                playheadTick={engine.playheadTick}
                onSelect={(trackId, clipId) => { setSelectedTrackId(trackId); setSelectedClipId(clipId); }}
              />

              {track && clip && instrument ? (
                <section>
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                      음 편집기
                    </h2>
                    <span className="text-xs text-neutral-500">
                      {track.name} · {clip.label || '클립'} · {clip.notes.length}개
                      {selection.length > 0 ? ` · ${selection.length}개 선택` : ''}
                    </span>
                  </div>
                  <div className="mb-2">
                    <EditorToolbar
                      fold={fold}
                      onFold={setFold}
                      hasKey={project.key !== null}
                      range={viewRange}
                      instrumentRange={instrumentRange}
                      noteMidis={clip.notes.map((n) => n.pitch.midi)}
                      onRange={setViewRange}
                      ghosts={ghosts}
                      onGhostMode={setGhostMode}
                    />
                  </div>

                  <PianoRoll
                    editor={editor}
                    clip={clip}
                    range={viewRange}
                    instrumentRange={instrumentRange}
                    fold={fold}
                    ghosts={ghosts}
                    gridTicks={gridTicks}
            noteLengthTicks={noteLengthTicks}
            zoomX={zoomX}
            zoomY={zoomY}
            velocity={inputVelocity}
                    playheadTick={engine.playheadTick}
                    cursorTick={cursorTick}
                    onMoveCursor={setCursorTick}
                    musicalKey={project.key}
                    onAudition={audition}
                  />

                  <div className="mt-2 space-y-2">
                    <VelocityLane editor={editor} clip={clip} onAudition={audition} />
                    <PitchCurveLane editor={editor} clip={clip} onAudition={audition} />
                  </div>

                  <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                    빈 곳 클릭 = 음 추가 · 끌기 = 범위 선택 · Shift+클릭 = 선택 추가 ·
                    눈금 클릭 = 재생 위치 · Space = 커서부터 재생 ·
                    ⌘C/⌘V 복사·붙여넣기 · ⌘D 복제 · ⌘A 전체 선택 · ⌘L 선택 구간 반복 ·
                    ↑↓ 반음 · Delete 삭제 · Esc 선택 해제
                  </p>
                </section>
              ) : (
                <p className="rounded-lg border border-dashed border-neutral-800 p-6 text-sm text-neutral-500">
                  트랙과 클립을 만들면 편집기가 열립니다.
                </p>
              )}
            </div>

            <NoteInspector editor={editor} onAudition={audition} />
          </div>
        )}
      </div>
    </div>
  );
}

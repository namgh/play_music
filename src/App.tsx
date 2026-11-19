import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CloudPanel } from './ui/CloudPanel.tsx';

import { BRAND } from './brand.ts';
import {
  addClip, addNote, addTrack, copyNotes, resizeClip, deleteNotes, duplicateNotes, duplicateTrack, joinClips, moveNotes,
  moveTrack, nextClipOnTrack, pasteNotes, repeatClip, splitClip, updateClip,
  moveNotesToTrack, quantizeNotes, setKey, setLoop, setLoopEnabled, setSwing, setTempo,
  setTempoChange,
} from './editor/edits.ts';
import { useProjectEditor } from './editor/useProjectEditor.ts';
import { loadAutosave, readProjectFile, saveAutosave, saveProjectFile } from './editor/projectStorage.ts';
import { decodeMidi, encodeMidi } from './model/midi.ts';
import { createEmptyProject, projectLengthTicks } from './model/factory.ts';
import type { ClipId, MusicalKey, Note, Project, StackId, TrackId } from './model/project.ts';
import { NOTE_NAMES, pitchName } from './model/pitch.ts';
import { PPQ, secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from './model/time.ts';
import { positionAt } from './model/meter.ts';
import { adjacentMarkerTick, keyAt, tapTempo } from './editor/arrangement.ts';
import { ExportPanel } from './ui/ExportPanel.tsx';
import { SoundBrowser } from './ui/SoundBrowser.tsx';
import { PlaySurface } from './ui/PlaySurface.tsx';
import { EventList } from './ui/EventList.tsx';
import { StepSequencer } from './ui/StepSequencer.tsx';
import { SmartControls } from './ui/SmartControls.tsx';
import { ProjectPanel } from './ui/ProjectPanel.tsx';
import { LiveLoops } from './ui/LiveLoops.tsx';
import { Assistant } from './ui/Assistant.tsx';
import { ScoreView } from './ui/ScoreView.tsx';
import { AudioEditor } from './ui/AudioEditor.tsx';
import { VideoPanel } from './ui/VideoPanel.tsx';
import { putAsset } from './audio/assets.ts';
import { importAudioBytes, MicRecorder, placeAudio } from './ui/audioUi.ts';
import { bounceInPlace, freezeTrack, unfreezeTrack } from './editor/freeze.ts';
import { aliasToCopy, makeAlias } from './editor/aliases.ts';
import { notesInSpan } from './editor/scrub.ts';
import { applyPunch, commitRecording, compFromTake, NoteRecorder, playedToNotes, punchAudioWindow, switchTake } from './editor/recording.ts';
import { SettingsPanel } from './ui/SettingsPanel.tsx';
import { useMidiInput } from './audio/midiInput.ts';
import { resolveCommand } from './ui/shortcuts.ts';
import { effectiveBindings, loadSettings, saveSettings } from './ui/settings.ts';
import type { AppSettings } from './ui/settings.ts';
import { browserKv, putProject } from './editor/library.ts';
import { extractVoice, forceLegato, humanize, removeOverlaps, scaleQuantize, scaleVelocity } from './editor/noteTools.ts';
import type { NoteColorMode } from './ui/PianoRoll.tsx';
import { createStack, setTrackFlag, setTrackStack } from './editor/tracks.ts';
import type { GlobalSelection } from './ui/GlobalTracks.tsx';
import { INSTRUMENT_CATALOG, playableInstrumentIds } from './instruments/definitions.ts';
import { useInstruments } from './instruments/useInstruments.ts';
import { instrumentParams, resolveInstrument } from './instruments/resolve.ts';
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
import { TuningLab } from './ui/TuningLab.tsx';
import { Timeline } from './ui/Timeline.tsx';
import { Mixer } from './ui/Mixer.tsx';
import { ThemePanel, useThemeState } from './ui/ThemePanel.tsx';
import {
  IconEditor, IconExport, IconFolder, IconGrid, IconLoop, IconSpark, IconMetronome, IconMixer, IconPalette, IconPlay, IconRedo,
  IconRewind, IconStop, IconTuning, IconUndo,
} from './ui/icons.tsx';


/** 트랙·악기가 없을 때 쓰는 음역. 화면이 비지 않게만 하면 된다 */
const FALLBACK_RANGE = { low: 36, high: 84 };
/** 편집이 멈춘 뒤 저장까지 — 끄는 동안 매 프레임 쓰지 않을 만큼만 */
const AUTOSAVE_DELAY_MS = 150;

/**
 * 상단 바의 둥근 기기 버튼. 몸체(밝은 패널) 위에 놓인다.
 * 켜짐은 잉크색 바탕 — 포인트색은 재생 위치·선택에만 쓴다 (`index.css`)
 */
const ROUND_BTN =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rule bg-panel text-ink'
  + ' hover:border-ink-3 disabled:opacity-40';
const ROUND_ON = 'border-ink bg-ink text-body';

/** 툴바의 작은 입력칸 */
const FIELD = 'h-7 rounded-md border border-rule bg-panel px-2 text-xs text-ink';
const TOOL_BTN = 'h-7 shrink-0 whitespace-nowrap rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3 disabled:opacity-40';
/** 파일 메뉴의 한 줄 */
const MENU_ITEM = 'flex h-9 w-full items-center rounded-lg px-3 text-left text-sm text-ink hover:bg-panel';

const GRID_OPTIONS: { label: string; ticks: number }[] = [
  { label: '1/4', ticks: PPQ },
  { label: '1/8', ticks: PPQ / 2 },
  { label: '1/16', ticks: PPQ / 4 },
  { label: '1/32', ticks: PPQ / 8 },
];

const VIEWS = [
  ['editor', '편집기', IconEditor],
  ['mixer', '믹서', IconMixer],
  ['live', '라이브 루프', IconGrid],
  ['assistant', '도우미', IconSpark],
  ['tuning', '튜닝 도구', IconTuning],
] as const;
type View = (typeof VIEWS)[number][0];

/** 빈 프로젝트에 트랙 하나 + 클립 하나. 아무것도 없으면 찍을 곳이 없다 */
function starterProject(): Project {
  const empty = createEmptyProject('새 프로젝트');
  empty.tempo.bpm = 96;
  empty.lengthBars = 8;

  const instrumentId = playableInstrumentIds()[0] ?? 'acoustic-guitar';
  const withTrack = addTrack(empty, {
    name: INSTRUMENT_CATALOG.find((e) => e.id === instrumentId)?.name ?? instrumentId,
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
  const editor = useProjectEditor(
    useMemo(() => loadAutosave() ?? starterProject(), []),
    { onBlocked: (reason) => setNotice(reason) },
  );
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
  /** 글로벌 트랙(구간·마커·코드·마디)에서 고른 것 — 보기 상태라 저장하지 않는다 */
  const [globalSelection, setGlobalSelection] = useState<GlobalSelection>(null);
  /** LCD 위치 표시 — 마디.박 또는 분:초 */
  const [lcdMode, setLcdMode] = useState<'bars' | 'time'>('bars');
  const taps = useRef<number[]>([]);
  /** 단축키 처리기가 늘 최신 마커 이동을 부르게 */
  const jumpMarkerRef = useRef<(d: 1 | -1) => void>(() => {});
  /**
   * 녹음 — 재생하면서 건반·MIDI 로 친 것을 받는다 (`recording.ts`). 멈추면 클립에 넣는다.
   * 받는 틱은 재생 헤드를 ref 로 읽는다 — 키 처리기가 매 프레임 다시 만들어지지 않게
   */
  const [recordMode, setRecordMode] = useState<'replace' | 'overdub'>('replace');
  /** 펀치 인/아웃 — 켜면 반복 구간 안에서 친 것만 녹음 (`PARITY_ROUND2.md` 4) */
  const [punch, setPunch] = useState(false);
  type PunchRange = { from: number; to: number } | null;
  const recording = useRef<{ recorder: NoteRecorder; clipId: ClipId; fromTick: number; started: boolean; punch: PunchRange } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const playheadRef = useRef<number | null>(null);
  /** 상단 바에서 열린 띄움 창. 한 번에 하나만 */
  const [menu, setMenu] = useState<'file' | 'theme' | 'export' | null>(null);
  const theme = useThemeState();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const midiInput = useRef<HTMLInputElement | null>(null);
  const audioInput = useRef<HTMLInputElement | null>(null);
  const videoInput = useRef<HTMLInputElement | null>(null);
  /** 마이크 녹음 (오디오 트랙) */
  /**
   * Flashback (Logic Capture as Recording, `PARITY_ROUND2.md` 5) — 녹음을 안 눌렀어도 **재생하며 친 것**을
   * 계속 받아 둔다. 재생을 새로 시작할 때마다 비운다. "담기" 를 누르면 고른 클립에 녹음처럼 들어간다
   */
  const flashback = useRef<{ recorder: NoteRecorder; fromTick: number } | null>(null);
  const mic = useRef<{ recorder: MicRecorder; fromTick: number; trackId: TrackId; punch: PunchRange } | null>(null);

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
  /** 카운트인 — 메트로놈처럼 도구 설정이다 */
  const [countIn, setCountIn] = useState(false);
  /** 음 색 — 보기 설정 */
  const [noteColor, setNoteColor] = useState<NoteColorMode>('edit');
  /** 오른쪽 칸 탭 — 보기 설정 */
  const [sideTab, setSideTab] = useState<'inspect' | 'controls' | 'browse'>('inspect');
  /** 연주 칸(건반) — 보기 설정 */
  const [playOpen, setPlayOpen] = useState(false);
  /** 클립 편집기 보기 — 피아노 롤 / 이벤트 목록 */
  const [editorView, setEditorView] = useState<'roll' | 'steps' | 'list' | 'score'>('roll');
  /** 곡 고르기 판 */
  const [projectsOpen, setProjectsOpen] = useState(false);
  /** 앱 설정 — 곡이 아니라 작업 환경 (`settings.ts`) */
  const [settings, setSettingsState] = useState<AppSettings>(() => loadSettings());
  const setSettings = useCallback((next: AppSettings) => { setSettingsState(next); saveSettings(next); }, []);
  const bindings = useMemo(() => effectiveBindings(settings), [settings]);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  // **이 곡이 쓰는 악기만 불러온다.** 1000개를 다 받을 이유가 없다 —
  // 목록·이름은 카탈로그에 있어서 기다리지 않는다
  const { registry, ready: instrumentsReady } = useInstruments(
    project.tracks.map((t) => t.instrumentId),
  );
  const engine = useAudioEngine(project, registry);
  // MIDI 입력 — 설정에서 장치를 골랐거나 설정 창이 열려 있을 때만 켠다(처음에 권한을 묻는다)
  const [midiLast, setMidiLast] = useState<string | null>(null);
  const midiNoteRef = useRef<(midi: number, velocity: number) => void>(() => {});
  const midiOffRef = useRef<(midi: number) => void>(() => {});
  const midiDevice = useMidiInput(settings.midiInputId !== null || settingsOpen, settings.midiInputId, (m) => {
    if (m?.kind === 'noteOn') {
      setMidiLast(`${pitchName({ midi: m.midi, cents: 0 })} · 세기 ${Math.round(m.velocity * 127)}`);
      midiNoteRef.current(m.midi, m.velocity);
    }
    if (m?.kind === 'noteOff') midiOffRef.current(m.midi);
  });

  // **튜닝 도구로 넘어가면 곡 재생을 멈춘다.** 그 화면은 자체 엔진으로 소리를 내므로
  // 곡이 계속 흐르면 둘이 겹쳐 들리고, 그 상태로는 음색을 판정할 수 없다
  useEffect(() => {
    if (view === 'tuning') engine.stop();
  }, [view]);

  const track = project.tracks.find((t) => t.id === selectedTrackId) ?? project.tracks[0] ?? null;
  const clip = track?.clips.find((c) => c.id === selectedClipId) ?? track?.clips[0] ?? null;
  const instrument =
    track && instrumentsReady ? resolveInstrument(track.instrumentId, registry) : null;

  // 실시간 저장 — 편집이 멈추면 곧바로 쓴다. 끄는 중(드래그)에는 매 프레임
  // 직렬화하지 않도록 아주 짧게만 모은다
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'failed'>('saved');
  const unsaved = useRef<typeof project | null>(null);
  const flushSave = useCallback(() => {
    const pending = unsaved.current;
    if (!pending) return;
    unsaved.current = null;
    setSaveState(saveAutosave(pending) ? 'saved' : 'failed');
    // 보관함(최근 곡)에도 — 실패해도 자동 저장은 이미 됐으니 조용히 넘긴다
    try { putProject(browserKv, pending, Date.now()); } catch { /* 저장소가 찼다 */ }
  }, []);
  const firstRender = useRef(true);
  useEffect(() => {
    // 처음 뜰 때는 방금 읽어 온 것과 같으므로 다시 쓰지 않는다
    if (firstRender.current) { firstRender.current = false; return; }
    unsaved.current = project;
    setSaveState('pending');
    const timer = setTimeout(flushSave, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [project, flushSave]);
  // **창을 닫거나 탭을 떠나는 순간에는 기다리지 않고 쓴다.** 타이머만 믿으면
  // 마지막 편집 직후 닫았을 때 그 편집이 사라진다
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushSave(); };
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flushSave);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flushSave]);

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

  // MIDI 건반 → 고른 트랙으로 연주, 녹음 중이면 받는다
  midiNoteRef.current = (midi, velocity) => {
    // 누르는 동안 울리고 떼면 멈춘다 (화면 건반·자판·MIDI 건반이 모두 여기로)
    if (track) void engine.liveOn(track.id, midi, velocity);
    if (recording.current && playheadRef.current !== null) recording.current.recorder.noteOn(midi, velocity, playheadRef.current);
    else if (flashback.current && playheadRef.current !== null) flashback.current.recorder.noteOn(midi, velocity, playheadRef.current);
  };
  midiOffRef.current = (midi) => {
    if (track) engine.liveOff(track.id, midi);
    if (recording.current && playheadRef.current !== null) recording.current.recorder.noteOff(midi, playheadRef.current);
    else if (flashback.current && playheadRef.current !== null) flashback.current.recorder.noteOff(midi, playheadRef.current);
  };
  playheadRef.current = engine.playheadTick;

  // 재생을 시작할 때마다 Flashback 을 새로 받는다 (녹음 중이면 녹음이 받는다)
  useEffect(() => {
    if (engine.state === 'playing' && !recording.current) {
      flashback.current = { recorder: new NoteRecorder(), fromTick: engine.playheadTick ?? 0 };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.state]);
  const captureFlashback = () => {
    const fb = flashback.current;
    if (!fb || fb.recorder.played.length === 0) { setNotice('담을 연주가 없습니다 — 재생하면서 건반을 치면 녹음을 안 눌렀어도 받아 둡니다'); return; }
    if (!clip || !track) { setNotice('담을 클립을 고르세요'); return; }
    if (track.locked) { setNotice(`"${track.name}" 트랙은 보호돼 있습니다`); return; }
    const stopTick = lastPlayhead.current ?? fb.fromTick;
    const played = fb.recorder.finish(stopTick);
    const notes = playedToNotes(played, clip.startTick);
    if (notes.length === 0) { setNotice('고른 클립 자리에서 친 음이 없습니다'); return; }
    const first = Math.min(...played.map((p) => p.onTick));
    runEdit(() => {
      editor.commit(commitRecording(project, clip.id, notes, recordMode, { from: first - clip.startTick, to: stopTick - clip.startTick }));
      setNotice(`방금 연주 ${notes.length}음을 담았습니다 (Flashback)`);
    });
    flashback.current = null;
  };

  // 재생이 멈추면 녹음을 클립에 넣는다 (정지 버튼·Space·곡 끝 어느 쪽이든)
  useEffect(() => {
    const rec = recording.current;
    if (!rec) return;
    if (engine.state === 'playing') { rec.started = true; return; }
    if (!rec.started) return;
    recording.current = null;
    setIsRecording(false);
    const found = project.tracks.flatMap((t) => t.clips).find((c) => c.id === rec.clipId);
    if (!found) return;
    const stopTick = lastPlayhead.current ?? rec.fromTick;
    const raw = rec.recorder.finish(stopTick);
    const played = rec.punch ? applyPunch(raw, rec.punch.from, rec.punch.to) : raw;
    const notes = playedToNotes(played, found.startTick);
    if (notes.length === 0) { setNotice('녹음된 음이 없습니다'); return; }
    runEdit(() => {
      // 펀치면 바꾸는 범위도 구간만 — 구간 밖의 옛 음은 그대로 둔다
      const range = rec.punch
        ? { from: rec.punch.from - found.startTick, to: rec.punch.to - found.startTick }
        : { from: rec.fromTick - found.startTick, to: stopTick - found.startTick };
      editor.commit(commitRecording(project, rec.clipId, notes, recordMode, range));
      setNotice(`${notes.length}음을 녹음했습니다${recordMode === 'replace' ? ' — 바뀐 음은 테이크로 남겼습니다' : ''}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.state]);
  /** 오디오 트랙 녹음 — 마이크로 받아 재생이 멈추면 클립으로 */
  const startMic = async () => {
    if (!track) return;
    try {
      const recorder = new MicRecorder();
      await recorder.start();
      const from = cursorTick + (clip?.startTick ?? 0);
      mic.current = { recorder, fromTick: from, trackId: track.id, punch: punchRange() };
      setIsRecording(true);
      void engine.play(from, { countInBars: 0 });
    } catch (err) {
      setNotice(`마이크를 열지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  useEffect(() => {
    const m = mic.current;
    if (!m || engine.state === 'playing') return;
    mic.current = null;
    setIsRecording(false);
    void (async () => {
      try {
        const bytes = await m.recorder.stop();
        const { assetId, seconds } = await importAudioBytes(bytes);
        const name = `녹음 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
        const p0 = projectRef.current;
        if (m.punch) {
          // 펀치: 녹음한 소리에서 구간 부분만 클립으로 (앞뒤는 잘라 둔다 — 지우지 않으니 다듬기로 되살릴 수 있다)
          const fromSec = ticksToSeconds(m.fromTick, p0.tempo);
          const win = punchAudioWindow(fromSec, seconds, ticksToSeconds(m.punch.from, p0.tempo), ticksToSeconds(m.punch.to, p0.tempo));
          if (!win) { setNotice('펀치 구간 안에서 녹음된 소리가 없습니다'); return; }
          const at = Math.max(m.fromTick, m.punch.from);
          const placed = placeAudio(p0, { assetId, seconds, name, atTick: at, trackId: m.trackId });
          const lengthTick = Math.max(1, secondsToTicks(ticksToSeconds(at, p0.tempo) + win.lengthSec, p0.tempo) - at);
          editor.commit({
            ...placed.project,
            tracks: placed.project.tracks.map((t) => (t.id !== placed.trackId ? t : {
              ...t,
              clips: t.clips.map((c) => (c.audio?.assetId === assetId && c.startTick === at ? { ...c, lengthTick, audio: { ...c.audio, offsetSec: win.offsetSec } } : c)),
            })),
          });
          setNotice(`펀치 구간 ${win.lengthSec.toFixed(1)}초를 녹음했습니다`);
          return;
        }
        const placed = placeAudio(p0, { assetId, seconds, name, atTick: m.fromTick, trackId: m.trackId });
        editor.commit(placed.project);
        setNotice(`오디오 ${seconds.toFixed(1)}초를 녹음했습니다`);
      } catch (err) {
        setNotice(`녹음을 저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.state]);
  const projectRef = useRef(project);
  projectRef.current = project;
  const lastPlayhead = useRef<number | null>(null);
  if (engine.playheadTick !== null) lastPlayhead.current = engine.playheadTick;

  /** 펀치가 켜져 있으면 반복 구간 (없으면 알리고 펀치 없이) */
  const punchRange = (): PunchRange => {
    if (!punch) return null;
    if (!project.loop) { setNotice('펀치 구간이 없습니다 — 눈금자에서 반복 구간을 먼저 정하세요. 이번엔 전부 녹음합니다'); return null; }
    return { from: project.loop.startTick, to: project.loop.endTick };
  };

  const startRecording = () => {
    if (track?.kind === 'audio') { void startMic(); return; }
    if (!clip || !track) { setNotice('녹음할 클립을 고르세요'); return; }
    if (track.locked) { setNotice(`"${track.name}" 트랙은 보호돼 있습니다`); return; }
    const from = cursorTick + clip.startTick;
    recording.current = { recorder: new NoteRecorder(), clipId: clip.id, fromTick: from, started: false, punch: punchRange() };
    setIsRecording(true);
    setPlayOpen(true);
    void engine.play(from, { countInBars: settings.countInBars });
  };

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

  /** 다른 곡으로 — 히스토리를 새로 시작하고 첫 트랙·클립을 고른다 */
  const openProject = (next: Project, message: string) => {
    editor.load(next);
    setSelectedTrackId(next.tracks[0]?.id ?? null);
    setSelectedClipId(next.tracks[0]?.clips[0]?.id ?? null);
    setCursorTick(0);
    setGlobalSelection(null);
    setProjectsOpen(false);
    setNotice(message);
  };

  /** 파일로 저장 — 소리(오디오·영상)가 있으면 묶음 .zip 으로 */
  const saveFile = async () => {
    try {
      const r = await saveProjectFile(project);
      setNotice(r.kind === 'bundle'
        ? `소리까지 묶어 .zip 으로 저장했습니다${r.missing ? ` (이 브라우저에 없는 소리 ${r.missing}개는 빠졌습니다)` : ''}`
        : '파일로 저장했습니다');
    } catch (err) {
      setNotice(`저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onOpenFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const loaded = await readProjectFile(file);
      putProject(browserKv, project, Date.now());
      editor.load(loaded);
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

      // 단축키는 명령 목록에서 찾는다 — 설정에서 바꾼 키도 여기로 온다 (`shortcuts.ts`)
      const command = resolveCommand(bindings, event);
      if (!command) return;
      const needsSelection = ['delete', 'up', 'down', 'octaveUp', 'octaveDown', 'left', 'right'].includes(command);
      if (needsSelection && selection.length === 0) return;
      event.preventDefault();
      switch (command) {
        case 'projects': setProjectsOpen(true); return;
        case 'settings': setSettingsOpen(true); return;
        case 'save': void saveFile(); return;
        case 'undo': editor.undo(); return;
        case 'redo': editor.redo(); return;
        case 'copy': doCopy(); return;
        case 'paste': doPaste(); return;
        case 'duplicate': doDuplicate(); return;
        case 'selectAll': if (clip) editor.select(clip.notes.map((n) => n.id)); return;
        case 'loop': loopFromSelection(); return;
        case 'play':
          // **커서부터 재생한다.** 예전에는 항상 0 이라 8마디 곡의 7마디를 고치려면
          // 매번 앞 6마디를 다 들어야 했다
          if (engine.state === 'playing') engine.stop();
          else void engine.play(cursorTick + (clip?.startTick ?? 0), { countInBars: countIn ? settings.countInBars : 0 });
          return;
        case 'deselect':
          editor.select([]);
          // 글로벌 트랙에서 고른 것도 놓는다 — 그래야 그 줄의 도구(코드 찾기 등)가 돌아온다
          setGlobalSelection(null);
          return;
        case 'metronome': setMetronome((on) => !on); return;
        case 'countIn': setCountIn((on) => !on); return;
        case 'keyboard': setPlayOpen((on) => !on); return;
        case 'mixer': setView('mixer'); return;
        case 'editor': setView('editor'); return;
        case 'prevMarker': jumpMarkerRef.current(-1); return;
        case 'nextMarker': jumpMarkerRef.current(1); return;
        case 'delete': editor.commit(deleteNotes(project, selection)); editor.select([]); return;
        case 'up': editor.commit(moveNotes(project, selection, { semitones: 1 })); return;
        case 'down': editor.commit(moveNotes(project, selection, { semitones: -1 })); return;
        case 'octaveUp': editor.commit(moveNotes(project, selection, { semitones: 12 })); return;
        case 'octaveDown': editor.commit(moveNotes(project, selection, { semitones: -12 })); return;
        case 'left': editor.commit(moveNotes(project, selection, { ticks: -gridTicks })); return;
        case 'right': editor.commit(moveNotes(project, selection, { ticks: gridTicks })); return;
        default: return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    bindings, clip, countIn, cursorTick, doCopy, doDuplicate, doPaste, editor, engine, gridTicks,
    loopFromSelection, project, selection, settings.countInBars,
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

  /** 곡 기준 커서 — 재생 중이면 재생 헤드, 멈춰 있으면 편집 커서 */
  const songCursor = Math.max(0, engine.playheadTick ?? cursorTick + (clip?.startTick ?? 0));
  const here = positionAt(project, songCursor);
  const position = lcdMode === 'bars'
    ? `${here.bar + 1}.${here.beat + 1}.${Math.floor((here.tickInBeat / ticksPerBeat(here.timeSignature)) * 100).toString().padStart(2, '0')}`
    : (() => {
        const sec = ticksToSeconds(songCursor, project.tempo);
        return `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, '0')}.${Math.floor((sec % 1) * 10)}`;
      })();
  const barLabel = (tick: number) => {
    const p = positionAt(project, tick);
    return `${p.bar + 1}.${p.beat + 1}`;
  };

  /**
   * 커서를 곡 기준 틱으로 옮긴다. 커서는 **클립 기준**이라(붙여넣기와 공유 —
   * `WORKPLAN.md` 2-6) 그 자리를 품은 클립을 먼저 고른다: 지금 트랙에서 찾고,
   * 없으면 다른 트랙에서. 아무 클립도 없으면 지금 클립 기준으로 둔다.
   */
  const seek = (tick: number) => {
    const t = Math.max(0, Math.round(tick));
    const contains = (c: { startTick: number; lengthTick: number }) => t >= c.startTick && t < c.startTick + c.lengthTick;
    const own = track?.clips.find(contains);
    const other = own ? null : project.tracks.flatMap((tr) => tr.clips.map((c) => ({ tr, c }))).find((x) => contains(x.c));
    if (own) {
      setSelectedClipId(own.id);
      setCursorTick(t - own.startTick);
    } else if (other) {
      setSelectedTrackId(other.tr.id);
      setSelectedClipId(other.c.id);
      setCursorTick(t - other.c.startTick);
    } else {
      setCursorTick(Math.max(0, t - (clip?.startTick ?? 0)));
    }
    if (engine.state === 'playing') void engine.play(t);
  };
  const jumpMarker = (direction: 1 | -1) => {
    const target = adjacentMarkerTick(project, songCursor + (direction === -1 ? -1 : 0), direction);
    if (target === null) {
      setNotice(direction === 1 ? '뒤에 마커가 없습니다' : '앞에 마커가 없습니다');
      return;
    }
    seek(target);
  };
  jumpMarkerRef.current = jumpMarker;

  const keyLabel = project.key === null ? '없음' : `${project.key.tonic} ${project.key.mode === 'major' ? '장조' : '단조'}`;
  /** 편집 함수가 거절하면(겹침·자리 없음) 조용히 넘기지 않고 이유를 보여 준다 */
  const runEdit = (edit: () => void) => {
    try {
      edit();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const togglePlay = () => (engine.state === 'playing'
    ? engine.stop()
    : void engine.play(cursorTick + (clip?.startTick ?? 0), { countInBars: countIn ? settings.countInBars : 0 }));

  const exportMidi = () => {
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
  };

  return (
    // **화면 높이에 고정한 앱 프레임.** 편집기의 주인공은 피아노롤이므로 트랙이
    // 몇 개든 항상 보여야 한다 — 문서처럼 아래로 쌓으면 16트랙에서 화면 밖으로 밀린다
    <div className="flex h-dvh flex-col overflow-hidden bg-body text-ink">
      {/* 상단 바 — 몸체. 가운데 LCD 만 작은 검은 화면이다 (시안 v4 ②) */}
      <header className="relative flex h-16 shrink-0 items-center gap-3 border-b 2xl:gap-4 border-rule px-5">
        <div className="min-w-0 w-48 shrink-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-disp text-[15px] font-semibold tracking-wide">{BRAND.name}</span>
            {BRAND.isPlaceholder && <span className="text-[11px] text-ink-3">이름 임시</span>}
            <span
              role="status"
              data-save-state={saveState}
              title={saveState === 'failed'
                ? '이 브라우저에 저장하지 못했습니다 (용량 초과 또는 저장소 차단). 파일 메뉴에서 파일로 저장하세요'
                : '고칠 때마다 이 브라우저에 자동으로 저장됩니다'}
              className={`ml-auto shrink-0 text-[11px] ${saveState === 'failed' ? 'font-semibold text-red-600' : 'text-ink-3'}`}
            >
              {saveState === 'saved' ? '저장됨' : saveState === 'pending' ? '저장 중…' : '저장 실패'}
            </span>
          </div>
          <input
            aria-label="곡 이름"
            value={project.name}
            onChange={(e) => editor.preview({ ...project, name: e.target.value })}
            onBlur={() => editor.commitCurrent()}
            className="-ml-1 w-full truncate rounded border border-transparent bg-transparent px-1 text-[11px] text-ink-3 hover:border-rule focus:border-ink-3 focus:text-ink"
          />
        </div>

        {/* 화면 고르기 */}
        <nav className="flex shrink-0 gap-1" aria-label="화면">
          {VIEWS.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-pressed={view === id}
              title={label}
              className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs ${
                view === id ? 'border-ink bg-ink text-body' : 'border-rule bg-panel text-ink-2 hover:border-ink-3'
              }`}
            >
              <Icon size={15} /><span className="hidden 2xl:inline">{label}</span>
            </button>
          ))}
        </nav>

        {/* 재생 — 튜닝 도구에서는 걷는다. 그 화면은 자체 엔진으로 소리를 내서 곡이
            겹쳐 나면 음색을 판정할 수 없다 */}
        {view !== 'tuning' && (
          <div className="flex shrink-0 items-center gap-1 2xl:gap-1.5">
            <button type="button" title="맨 앞으로" onClick={() => { engine.stop(); setCursorTick(0); }} className={ROUND_BTN}>
              <IconRewind />
            </button>
            {/* 마커 이동은 넓은 화면에서만 단추로 — 좁으면 ⌥, ⌥. 로 (단추가 내보내기를 밀어낸다) */}
            <span className="hidden 2xl:contents">
            <button type="button" title="이전 마커로 (⌥,)" aria-label="이전 마커" onClick={() => jumpMarker(-1)} className={ROUND_BTN}>
              <span className="text-[11px] font-semibold">◂M</span>
            </button>
            <button type="button" title="다음 마커로 (⌥.)" aria-label="다음 마커" onClick={() => jumpMarker(1)} className={ROUND_BTN}>
              <span className="text-[11px] font-semibold">M▸</span>
            </button>
            </span>
            <button
              type="button"
              onClick={togglePlay}
              title={engine.state === 'playing' ? '정지 (Space)' : '커서부터 재생 (Space)'}
              className={`${ROUND_BTN} ${ROUND_ON}`}
            >
              {engine.state === 'playing' ? <IconStop /> : <IconPlay />}
            </button>
            <button
              type="button"
              onClick={() => (isRecording ? engine.stop() : startRecording())}
              aria-pressed={isRecording}
              aria-label="녹음"
              title={isRecording ? '녹음 멈추기' : `커서부터 녹음 — 건반 칸·MIDI 건반으로 칩니다 (${recordMode === 'replace' ? '바꿔 녹음: 옛 음은 테이크로' : '겹쳐 녹음'})`}
              className={`${ROUND_BTN} ${isRecording ? 'border-rec bg-rec text-body' : ''}`}
            ><i className={`h-3 w-3 rounded-full ${isRecording ? 'bg-body' : 'bg-rec'}`} /></button>
            {/* 녹음 옵션 — 상단 바가 좁아 두 줄로 (바꿔/겹쳐 · 펀치 / 담기) */}
            <div className="flex shrink-0 flex-col gap-0.5">
              <div className="flex gap-0.5">
                <button
                  type="button"
                  onClick={() => setRecordMode((m) => (m === 'replace' ? 'overdub' : 'replace'))}
                  aria-label="녹음 방식"
                  title="바꿔 녹음(옛 음은 테이크로 남김) / 겹쳐 녹음(더하기)"
                  className="h-[17px] rounded border border-rule bg-panel px-1 text-[10px] leading-none text-ink-2"
                >{recordMode === 'replace' ? '바꿔' : '겹쳐'}</button>
                <button
                  type="button"
                  onClick={() => setPunch((v) => !v)}
                  aria-pressed={punch}
                  aria-label="펀치 인/아웃"
                  title="펀치 인/아웃 — 반복 구간 안에서 친 것만 녹음합니다 (앞뒤는 준비 연주)"
                  className={`h-[17px] rounded border px-1 text-[10px] leading-none ${punch ? 'border-rec bg-rec text-body' : 'border-rule bg-panel text-ink-2'}`}
                >펀치</button>
              </div>
              <button
                type="button"
                onClick={captureFlashback}
                aria-label="방금 연주 담기"
                title="Flashback — 녹음을 안 눌렀어도 재생하며 친 것을 고른 클립에 담습니다"
                className="h-[17px] rounded border border-rule bg-panel px-1 text-[10px] leading-none text-ink-2 w-full"
              >담기</button>
            </div>
            <button
              type="button"
              onClick={() => setMetronome((on) => !on)}
              aria-pressed={metronome}
              title="메트로놈"
              className={`${ROUND_BTN} ${metronome ? ROUND_ON : ''}`}
            ><IconMetronome /></button>
            <button
              type="button"
              onClick={() => setCountIn((on) => !on)}
              aria-pressed={countIn}
              aria-label="카운트인"
              title="재생 전에 한 마디를 세고 시작합니다"
              className={`${ROUND_BTN} ${countIn ? ROUND_ON : ''}`}
            ><span className="font-num text-[13px]">1·2</span></button>
            <button
              type="button"
              onClick={() => setPlayOpen((on) => !on)}
              aria-pressed={playOpen}
              aria-label="건반"
              title="화면 건반 · 자판으로 연주 · 스텝 입력"
              className={`${ROUND_BTN} ${playOpen ? ROUND_ON : ''}`}
            ><span className="text-[13px]">🎹</span></button>
            <button
              type="button"
              onClick={() => {
                if (project.loop === null) loopFromSelection();
                else editor.commit(setLoopEnabled(project, !project.loop.enabled));
              }}
              aria-pressed={project.loop?.enabled ?? false}
              title="반복 구간 (⌘L 로 선택 구간을 잡습니다)"
              className={`${ROUND_BTN} ${project.loop?.enabled ? ROUND_ON : ''}`}
            ><IconLoop /></button>
          </div>
        )}

        {/* LCD — 위치 · 템포 · 조성 · 박자. 여기서 바로 바꾼다 */}
        <div className="flex h-11 shrink-0 items-center gap-3 rounded-[10px] bg-screen px-3 2xl:gap-4 2xl:px-3.5 text-sink">
          <button
            type="button"
            onClick={() => setLcdMode((m) => (m === 'bars' ? 'time' : 'bars'))}
            title={lcdMode === 'bars' ? '마디.박 — 눌러서 분:초로' : '분:초 — 눌러서 마디.박으로'}
            aria-label="재생 위치"
            className="w-[104px] text-left font-num text-[28px] leading-none text-acc-2"
          >{position}</button>
          <span className="h-6 w-px bg-grid-2" />
          <label className="flex flex-col gap-0.5">
            <input
              aria-label="템포 BPM"
              type="number"
              min={20} max={300}
              value={project.tempo.bpm}
              onChange={(e) => editor.commit(setTempo(project, Number(e.target.value)))}
              className="w-12 bg-transparent font-num text-[17px] leading-none text-sink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="flex items-center gap-1 text-[9px] text-sink-3">
              템포
              <button
                type="button"
                onClick={() => {
                  const now = performance.now();
                  taps.current = [...taps.current.slice(-7), now];
                  const bpm = tapTempo(taps.current);
                  if (bpm !== null) editor.commit(setTempo(project, bpm));
                }}
                title="박자에 맞춰 여러 번 누르면 템포를 잽니다"
                className="rounded-sm bg-grid-2 px-1 leading-tight text-sink-2 hover:text-sink"
              >탭</button>
            </span>
          </label>
          <label className="flex flex-col gap-0.5">
            <select
              aria-label="조성"
              value={project.key === null ? '' : `${project.key.tonic}|${project.key.mode}`}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') { editor.commit(setKey(project, null)); return; }
                const [tonic, mode] = raw.split('|');
                editor.commit(setKey(project, { tonic: tonic!, mode: mode as MusicalKey['mode'] }));
              }}
              title={`조성: ${keyLabel} — 피아노롤 스케일 표시용. 소리에는 영향이 없습니다`}
              className="-ml-1 bg-transparent text-[13px] font-semibold leading-none text-sink outline-none"
            >
              <option value="">없음</option>
              {NOTE_NAMES.map((tonic) => (
                <option key={`${tonic}-major`} value={`${tonic}|major`}>{tonic} 장조</option>
              ))}
              {NOTE_NAMES.map((tonic) => (
                <option key={`${tonic}-minor`} value={`${tonic}|minor`}>{tonic} 단조</option>
              ))}
            </select>
            <span className="text-[9px] text-sink-3">조성</span>
          </label>
          <span className="flex flex-col gap-0.5">
            <b className="font-num text-[17px] font-normal leading-none">{here.timeSignature.num}/{here.timeSignature.den}</b>
            <span className="text-[9px] text-sink-3">박자</span>
          </span>
          {project.loop && (
            <>
              <span className="h-6 w-px bg-grid-2" />
              <span className="flex flex-col gap-0.5">
                <b className={`font-num text-[15px] font-normal leading-none ${project.loop.enabled ? 'text-acc-2' : 'text-sink-2'}`}>
                  {barLabel(project.loop.startTick)}–{barLabel(project.loop.endTick)}
                </b>
                <button
                  type="button"
                  onClick={() => editor.commit(setLoop(project, null))}
                  className="text-left text-[9px] text-sink-3 hover:text-sink"
                  title="반복 구간 지우기"
                >반복 · 지우기</button>
              </span>
            </>
          )}
        </div>

        <span className="flex-1" />
        {engine.engineKind && (
          <span className="hidden h-6 items-center gap-1.5 rounded-full border border-rule bg-panel px-2.5 text-[11px] text-ink-2 2xl:flex">
            <i className="h-1.5 w-1.5 rounded-full bg-ok" />{ENGINE_LABELS[engine.engineKind]}
          </span>
        )}

        <div className="flex shrink-0 items-center gap-1 2xl:gap-1.5">
          <button type="button" title="되돌리기 (⌘Z)" disabled={!editor.canUndo} onClick={editor.undo} className={ROUND_BTN}><IconUndo /></button>
          <button type="button" title="다시 실행 (⇧⌘Z)" disabled={!editor.canRedo} onClick={editor.redo} className={ROUND_BTN}><IconRedo /></button>
          <button
            type="button"
            title="파일 — 저장·열기·MIDI·클라우드"
            aria-expanded={menu === 'file'}
            onClick={() => setMenu(menu === 'file' ? null : 'file')}
            className={`${ROUND_BTN} ${menu === 'file' ? ROUND_ON : ''}`}
          ><IconFolder /></button>
          <button
            type="button"
            title="색"
            aria-expanded={menu === 'theme'}
            onClick={() => setMenu(menu === 'theme' ? null : 'theme')}
            className={`${ROUND_BTN} ${menu === 'theme' ? ROUND_ON : ''}`}
          ><IconPalette /></button>
          <button type="button" title="설정 · 단축키 · MIDI 장치 (⌘,)" aria-label="설정" onClick={() => setSettingsOpen(true)} className={ROUND_BTN}>
            <span className="text-[15px]">⚙</span>
          </button>
          {/* 내보내기는 세션의 **끝**이라 이것만 색을 준다 */}
          <button
            type="button"
            disabled={engine.exporting}
            onClick={() => setMenu(menu === 'export' ? null : 'export')}
            aria-expanded={menu === 'export'}
            className="ml-1 flex h-9 items-center gap-2 rounded-full bg-cta px-4 text-[13px] font-semibold text-cta-ink disabled:opacity-50"
          >
            <IconExport />{engine.exporting ? '내보내는 중…' : '내보내기'}
          </button>
        </div>

        {/* 영상 창은 편집기·라이브 루프에서만 — 믹서·도우미에서는 아래쪽 단추를 덮는다 */}
        {project.video && (view === 'editor' || view === 'live') && (
          <VideoPanel editor={editor} songTick={songCursor} playing={engine.state === 'playing'} onNotice={setNotice} />
        )}
        {settingsOpen && (
          <SettingsPanel editor={editor} settings={settings} onSettings={setSettings}
            midi={{ ...midiDevice, lastNote: midiLast }} onClose={() => setSettingsOpen(false)} />
        )}
        {projectsOpen && <ProjectPanel project={project} onOpen={openProject} onClose={() => setProjectsOpen(false)} />}
        {menu === 'export' && (
          <ExportPanel project={project} exporting={engine.exporting} onBounce={engine.bounce} onClose={() => setMenu(null)} />
        )}
        {menu !== null && menu !== 'export' && (
          // 바깥을 누르면 닫는다
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} aria-hidden="true" />
        )}

        {/* 파일 — 한 곡에 몇 번 쓰는 것들. 매분 쓰는 재생·편집과 같은 무게로 두지 않는다 */}
        {menu === 'file' && (
          <div className="scope-body absolute right-24 top-[68px] z-50 w-72 rounded-2xl border border-rule bg-body p-2 shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
            <button type="button" className={MENU_ITEM} onClick={() => { setProjectsOpen(true); setMenu(null); }}>
              새 곡 · 최근 곡 · 버전<span className="ml-auto text-[11px] text-ink-3">⌘O</span>
            </button>
            <div className="my-1 h-px bg-rule" />
            <button type="button" className={MENU_ITEM}
              onClick={() => { void saveFile(); setMenu(null); }}>
              파일로 저장<span className="ml-auto text-[11px] text-ink-3">⌘S</span>
            </button>
            <button type="button" className={MENU_ITEM} onClick={() => { fileInput.current?.click(); setMenu(null); }}>
              파일 열기
            </button>
            <div className="my-1 h-px bg-rule" />
            {/* MIDI — 없으면 다른 DAW 와 단절돼 사용자가 갇힌다 (`ROADMAP.md` P3) */}
            <button type="button" className={MENU_ITEM} onClick={() => { exportMidi(); setMenu(null); }}>MIDI 내보내기</button>
            <button type="button" className={MENU_ITEM} onClick={() => { midiInput.current?.click(); setMenu(null); }}>MIDI 가져오기</button>
            <button type="button" className={MENU_ITEM} onClick={() => { audioInput.current?.click(); setMenu(null); }}>오디오 가져오기<span className="ml-auto text-[11px] text-ink-3">WAV·MP3…</span></button>
            <button type="button" className={MENU_ITEM} onClick={() => { videoInput.current?.click(); setMenu(null); }}>영상 가져오기<span className="ml-auto text-[11px] text-ink-3">MP4·MOV</span></button>
            <div className="my-1 h-px bg-rule" />
            {/* 클라우드는 **얹는 기능**이다 — 로그인하지 않아도 위의 파일 저장·열기는 그대로 된다 */}
            <div className="px-2 py-1.5">
              <CloudPanel project={project} onOpen={(loaded) => editor.commit(loaded)} onNotice={setNotice} />
            </div>
          </div>
        )}
        {menu === 'theme' && <ThemePanel theme={theme} onClose={() => setMenu(null)} />}

        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json,application/zip,.zip"
          aria-label="곡 파일 열기"
          className="hidden"
          onChange={(e) => { void onOpenFile(e.target.files?.[0]); e.target.value = ''; }}
        />
        <input
          ref={videoInput}
          type="file"
          accept="video/*"
          aria-label="영상 파일"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
              setNotice(`"${file.name}" 을 읽는 중…`);
              const bytes = await file.arrayBuffer();
              const assetId = await putAsset(bytes);
              const durationSec = await new Promise<number>((resolve) => {
                const v = document.createElement('video');
                v.preload = 'metadata';
                v.onloadedmetadata = () => { resolve(Number.isFinite(v.duration) ? v.duration : 0); URL.revokeObjectURL(v.src); };
                v.onerror = () => resolve(0);
                v.src = URL.createObjectURL(file);
              });
              editor.commit({ ...project, video: { assetId, name: file.name, durationSec, offsetSec: 0 } });
              setNotice(`영상 "${file.name}" (${durationSec.toFixed(1)}초) — 재생하면 따라 움직입니다`);
            } catch (err) {
              setNotice(err instanceof Error ? err.message : String(err));
            }
          }}
        />
        <input
          ref={audioInput}
          type="file"
          accept="audio/*"
          aria-label="오디오 파일"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
              setNotice(`"${file.name}" 을 읽는 중…`);
              const { assetId, seconds } = await importAudioBytes(await file.arrayBuffer());
              const at = cursorTick + (clip?.startTick ?? 0);
              const placed = placeAudio(project, { assetId, seconds, name: file.name, atTick: at, trackId: track?.kind === 'audio' ? track.id : null });
              editor.commit(placed.project);
              setSelectedTrackId(placed.trackId);
              setSelectedClipId(placed.project.tracks.find((t) => t.id === placed.trackId)?.clips.find((c) => c.audio?.assetId === assetId && c.startTick === at)?.id ?? null);
              setNotice(`"${file.name}" (${seconds.toFixed(1)}초) 을 놓았습니다`);
            } catch (err) {
              setNotice(err instanceof Error ? err.message : String(err));
            }
          }}
        />
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
              putProject(browserKv, project, Date.now());
              editor.load(loaded);
              setSelectedTrackId(loaded.tracks[0]?.id ?? null);
              setSelectedClipId(loaded.tracks[0]?.clips[0]?.id ?? null);
              editor.select([]);
              setNotice(`"${loaded.name}" 을 가져왔습니다 (트랙 ${loaded.tracks.length}개). `
                + 'MIDI 의 악기 지정을 따라 배정했습니다 — 현악·관악처럼 아직 없는 '
                + '악기는 가장 가까운 것으로 대신했으니 트랙마다 바꿔 보세요');
            } catch (err) {
              setNotice(`MIDI 를 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
            }
          }}
        />
      </header>

      {/* 찍고 고치는 것 — 입력 기본값과 편집 동작. 편집기에서만 */}
      {view === 'editor' && (
        <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-rule px-5 text-xs [scrollbar-width:none] [&>label]:shrink-0">
          <label className="text-[11px] text-ink-3" htmlFor="grid">격자</label>
          <select id="grid" value={gridTicks} onChange={(e) => setGridTicks(Number(e.target.value))} className={FIELD}>
            {GRID_OPTIONS.map((option) => <option key={option.label} value={option.ticks}>{option.label}</option>)}
          </select>
          {/* 음 길이 — **격자와 다른 축이다.** 16분 격자에 4분음표를 찍을 수 있어야 한다 */}
          <label className="ml-1 text-[11px] text-ink-3" htmlFor="notelen">음 길이</label>
          <select
            id="notelen"
            value={noteLengthTicks}
            onChange={(e) => setNoteLengthTicks(Number(e.target.value))}
            className={FIELD}
            title="새로 찍는 음의 길이 (Alt 를 누르면 격자에 안 맞춥니다)"
          >
            {GRID_OPTIONS.map((option) => <option key={option.label} value={option.ticks}>{option.label}</option>)}
          </select>
          {/* 스윙 — **곡의 성격이라 프로젝트에 저장된다** */}
          <label className="ml-1 text-[11px] text-ink-3" htmlFor="swing">스윙</label>
          <input
            id="swing" type="range" min={0} max={0.6} step={0.05}
            value={project.swing ?? 0}
            onChange={(e) => editor.commit(setSwing(project, Number(e.target.value)))}
            className="w-20 accent-ink"
            title={`뒷박을 ${Math.round((project.swing ?? 0) * 100)}% 뒤로 (1/3 이 삼잇단)`}
          />
          <span className="w-8 font-num text-sm">{Math.round((project.swing ?? 0) * 100)}%</span>
          {/* 세기 — 찍을 때 적용된다 */}
          <label className="text-[11px] text-ink-3" htmlFor="vel">세기</label>
          <input
            id="vel" type="range" min={0.05} max={1} step={0.05}
            value={inputVelocity}
            onChange={(e) => setInputVelocity(Number(e.target.value))}
            className="w-20 accent-ink"
            title={`새로 찍는 음의 세기 ${Math.round(inputVelocity * 100)}%`}
          />
          <span className="w-8 font-num text-sm">{Math.round(inputVelocity * 127)}</span>
          <label className="text-[11px] text-ink-3" htmlFor="bars">마디</label>
          <input
            id="bars" type="number" min={1} max={512}
            value={project.lengthBars}
            onChange={(e) => editor.commit({ ...project, lengthBars: Math.max(1, Math.round(Number(e.target.value))) })}
            className={`${FIELD} w-14`}
          />
          {/* 템포 변화 — 커서 위치에 지점을 놓는다 */}
          <button
            type="button"
            onClick={() => {
              const at = cursorTick + (clip?.startTick ?? 0);
              if (at <= 0) {
                setNotice('곡 시작 템포는 LCD 의 템포 칸에서 바꿉니다');
                return;
              }
              const existing = (project.tempo.changes ?? []).find((c) => c.tick === at);
              if (existing) {
                editor.commit(setTempoChange(project, at, null));
                setNotice('템포 변화를 지웠습니다');
                return;
              }
              editor.commit(setTempoChange(project, at, project.tempo.bpm));
              setNotice('커서 위치에 템포 변화를 놓았습니다 — LCD 의 템포 칸에서 값을 바꾸세요');
            }}
            className={TOOL_BTN}
            title="커서 위치에 템포 변화를 놓거나 지웁니다"
          >템포 변화{(project.tempo.changes?.length ?? 0) > 0 ? ` (${project.tempo.changes!.length})` : ''}</button>

          <span className="mx-1 h-5 w-px shrink-0 bg-rule" />

          <button type="button" disabled={selection.length === 0} onClick={doCopy} title="복사 (⌘C)" className={TOOL_BTN}>복사</button>
          <button type="button" disabled={clipboardSize === 0} onClick={doPaste} title="커서 위치에 붙여넣기 (⌘V)" className={TOOL_BTN}>
            붙여넣기{clipboardSize > 0 ? ` (${clipboardSize})` : ''}
          </button>
          <button
            type="button"
            disabled={selection.length === 0}
            onClick={() => editor.commit(quantizeNotes(project, selection, gridTicks))}
            className={TOOL_BTN}
          >퀀타이즈</button>
          {/* 음 기능 — Logic 피아노 롤 "기능" 메뉴. 고르면 바로 실행하고 제자리로 돌아온다 */}
          <select
            aria-label="음 기능"
            value=""
            disabled={selection.length === 0}
            onChange={(e) => {
              const action = e.target.value;
              runEdit(() => {
                switch (action) {
                  case 'scale': {
                    if (!project.key) throw new Error('조성을 먼저 정하세요 (LCD 의 조성 칸)');
                    editor.commit(scaleQuantize(project, selection, keyAt(project, (clip?.startTick ?? 0) + cursorTick) ?? project.key));
                    break;
                  }
                  case 'legato': editor.commit(forceLegato(project, selection)); break;
                  case 'overlap': editor.commit(removeOverlaps(project, selection)); break;
                  case 'louder': editor.commit(scaleVelocity(project, selection, 1.1)); break;
                  case 'softer': editor.commit(scaleVelocity(project, selection, 0.9)); break;
                  case 'human': editor.commit(humanize(project, selection, { timingTicks: PPQ / 32, velocity: 0.06, seed: Date.now() })); break;
                  case 'top':
                  case 'bottom': {
                    const r = extractVoice(project, selection, action);
                    editor.commit(r.project);
                    setNotice(`${r.moved}개를 새 트랙으로 옮겼습니다`);
                    break;
                  }
                  default: break;
                }
              });
            }}
            className={FIELD}
          >
            <option value="">기능…</option>
            <option value="scale">스케일에 맞추기</option>
            <option value="legato">레가토 (다음 음까지)</option>
            <option value="overlap">겹침 없애기</option>
            <option value="louder">세기 +10%</option>
            <option value="softer">세기 −10%</option>
            <option value="human">사람처럼 (조금 흔들기)</option>
            <option value="top">윗성부 떼어내기</option>
            <option value="bottom">아랫성부 떼어내기</option>
          </select>
          <select
            aria-label="음 색"
            value={noteColor}
            onChange={(e) => setNoteColor(e.target.value as NoteColorMode)}
            className={FIELD}
            title="음을 무엇으로 칠할지 — 음정 손댄 것 / 세기 / 음이름"
          >
            <option value="edit">색: 손댄 음</option>
            <option value="velocity">색: 세기</option>
            <option value="pitch">색: 음이름</option>
          </select>
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
              className={FIELD}
            >
              <option value="">트랙으로 이동…</option>
              {project.tracks
                .filter((t) => t.id !== track?.id)
                .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <span className="flex-1" />
          {/* 줌 — 가로는 마디를, 세로는 줄을 늘린다 */}
          <span className="text-[11px] text-ink-3">확대</span>
          <button type="button" onClick={() => setZoomX((z) => Math.max(0.25, z / 1.5))} className={TOOL_BTN} title="가로 축소">가로 −</button>
          <button type="button" onClick={() => setZoomX((z) => Math.min(8, z * 1.5))} className={TOOL_BTN} title="가로 확대">＋</button>
          <button type="button" onClick={() => setZoomY((z) => Math.max(0.5, z / 1.3))} className={TOOL_BTN} title="세로 축소">세로 −</button>
          <button type="button" onClick={() => setZoomY((z) => Math.min(4, z * 1.3))} className={TOOL_BTN} title="세로 확대">＋</button>
        </div>
      )}

      {/* 피크 경고 — 조용히 잘린 파일이 나가는 것을 막는다 (`ROADMAP.md` P3).
          **고칠 방법까지 같이 준다.** 여유 안으로 들어오는 마스터 게인을 계산해 한 번에 적용한다 */}
      {engine.clip && (
        <div className="mx-5 mt-2 flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-rec/40 bg-rec/10 px-4 py-2.5 text-sm text-ink">
          <i className="h-2 w-2 rounded-full bg-rec" />
          <span>피크가 {engine.clip.peakDb.toFixed(1)}dBFS 입니다 — 파일에서 잘렸습니다</span>
          <button
            type="button"
            className="rounded-md border border-ink px-2.5 py-1 text-xs hover:bg-ink hover:text-body"
            onClick={() => {
              // 프로젝트 값을 바꾸므로 미리듣기와 내보내기가 자동으로 같아진다.
              // 되돌리기 한 단계로 취소할 수 있게 commit 으로 넣는다
              editor.commit({ ...project, master: { ...project.master, gain: engine.clip!.suggestedGain } });
            }}
          >
            마스터 {engine.clip.reductionDb.toFixed(1)}dB 내리기
          </button>
          <span className="text-xs text-ink-3">적용한 뒤 다시 내보내세요</span>
        </div>
      )}

      {(engine.error || notice) && (
        <p
          className={`mx-5 mt-2 shrink-0 rounded-xl border px-4 py-2.5 text-sm ${
            engine.error ? 'border-rec/40 bg-rec/10 text-ink' : 'border-rule bg-panel text-ink-2'
          }`}
        >
          {engine.error ?? notice}
          {!engine.error && (
            <button type="button" onClick={() => setNotice(null)} className="ml-3 text-xs underline">닫기</button>
          )}
        </p>
      )}

      {view === 'tuning' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="scope-screen rounded-2xl bg-screen p-5"><TuningLab /></div>
        </div>
      )}
      {view === 'assistant' && (
        <div className="scope-body min-h-0 flex-1 overflow-y-auto p-5">
          <Assistant editor={editor} exporting={engine.exporting} renderMix={engine.renderMix} onNotice={setNotice} />
        </div>
      )}
      {view === 'live' && (
        <div className="scope-body min-h-0 flex-1 overflow-y-auto p-5">
          <LiveLoops editor={editor} onPerform={(p, q) => void engine.perform(p, q)} playing={engine.state === 'playing'} onNotice={setNotice} />
        </div>
      )}
      {view === 'mixer' && (
        <div className="scope-body min-h-0 flex-1 overflow-y-auto p-5">
          <Mixer editor={editor} readLevel={engine.readLevel} readEffectMeters={engine.readEffectMeters} compensationSamples={engine.compensationSamples} />
        </div>
      )}

      {view === 'editor' && (
        <div className="grid min-h-0 flex-1 gap-4 px-5 pb-4 pt-3 lg:grid-cols-[1fr_320px]">
          {/* **왼쪽 열이 세로를 나눠 갖는다.** 편곡 영역은 자기 몫 안에서 스크롤하고,
              남는 높이는 전부 피아노롤이 가져간다 */}
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            {/* 편곡 영역 — 한 행에 트랙 하나 (왼쪽 설정 · 오른쪽 클립 레인) */}
            <div className="shrink-0 overflow-y-auto pr-1 lg:max-h-[42vh]">
              <Timeline
                editor={editor}
                instrumentFor={(t) => {
                  if (!instrumentsReady) return null;
                  const inst = resolveInstrument(t.instrumentId, registry);
                  return { specs: inst.paramSpecs, params: instrumentParams(inst, t.toneId, t.toneParams) };
                }}
                selectedTrackId={track?.id ?? null}
                selectedClipId={clip?.id ?? null}
                playheadTick={engine.playheadTick}
                onSelect={(trackId, clipId) => { setSelectedTrackId(trackId); setSelectedClipId(clipId); }}
                readLevel={engine.readLevel}
                globalSelection={globalSelection}
                onGlobalSelect={setGlobalSelection}
                onSeek={seek}
                onScrub={(from, to) => {
                  // 재생 중에는 스크럽하지 않는다 (재생 소리와 겹친다)
                  if (engine.state === 'playing') return;
                  for (const n of notesInSpan(project, from, to)) void engine.audition(n.trackId, n.midi, 0, n.velocity);
                }}
                onNotice={setNotice}
                tools={<>
          {/* 클립·트랙 조작 — 고른 클립과 트랙에 대해 (`LOGIC_PARITY.md` 3-1 편곡·트랙) */}
          <button
            type="button"
            disabled={!clip || cursorTick <= 0 || cursorTick >= clip.lengthTick}
            onClick={() => runEdit(() => {
              const next = splitClip(project, clip!.id, clip!.startTick + cursorTick);
              editor.commit(next.project);
              setCursorTick(0);
              setSelectedClipId(next.rightId);
            })}
            title="고른 클립을 커서 위치에서 둘로 나눕니다"
            className={TOOL_BTN}
          >나누기</button>
          <button
            type="button"
            disabled={!clip || nextClipOnTrack(project, clip.id) === null}
            onClick={() => runEdit(() => {
              const following = nextClipOnTrack(project, clip!.id)!;
              editor.commit(joinClips(project, [clip!.id, following.id]).project);
            })}
            title="고른 클립을 같은 트랙의 다음 클립과 하나로 합칩니다"
            className={TOOL_BTN}
          >합치기</button>
          <button
            type="button"
            disabled={!clip}
            onClick={() => runEdit(() => {
              const next = repeatClip(project, clip!.id, { untilTick: projectLengthTicks(project) });
              editor.commit(next.project);
              setNotice(`${next.clipIds.length}번 반복했습니다`);
            })}
            title="고른 클립을 곡 끝(또는 다음 클립)까지 되풀이합니다"
            className={TOOL_BTN}
          >반복</button>
          <button
            type="button"
            disabled={!clip || !!clip.audio}
            onClick={() => runEdit(() => {
              if (clip!.aliasOf) {
                editor.commit(aliasToCopy(project, clip!.id));
                setNotice('에일리어스를 보통 클립으로 바꿨습니다 — 이제 원본과 따로 고쳐집니다');
                return;
              }
              const next = makeAlias(project, clip!.id);
              editor.commit(next.project);
              setSelectedClipId(next.clipId);
              setNotice('에일리어스를 만들었습니다 — 원본이나 에일리어스 어느 쪽을 고쳐도 같이 바뀝니다');
            })}
            title={clip?.aliasOf ? '이 에일리어스를 보통 클립(진짜 복사)으로 바꿉니다' : '에일리어스 — 바로 뒤에, 원본을 고치면 같이 바뀌는 복사를 놓습니다'}
            className={TOOL_BTN}
          >{clip?.aliasOf ? '진짜 복사로' : '에일리어스'}</button>
          <button
            type="button"
            disabled={!clip}
            aria-pressed={clip?.muted === true}
            onClick={() => editor.commit(updateClip(project, clip!.id, { muted: !clip!.muted }))}
            title="고른 클립을 지우지 않고 소리만 뺍니다"
            className={`${TOOL_BTN} ${clip?.muted ? 'border-ink bg-ink text-body' : ''}`}
          >{clip?.muted ? '뮤트됨' : '클립 뮤트'}</button>
          <select
            aria-label="클립 색"
            disabled={!clip}
            value={clip?.color ?? ''}
            onChange={(e) => editor.commit(updateClip(project, clip!.id, { color: e.target.value || null }))}
            className={FIELD}
            title="고른 클립만 다른 색으로"
          >
            <option value="">트랙 색</option>
            {['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((c, i) => <option key={c} value={c}>색 {i + 1}</option>)}
          </select>
          <button
            type="button"
            disabled={!track}
            aria-pressed={track?.locked === true}
            onClick={() => editor.commit(setTrackFlag(project, track!.id, 'locked', !track!.locked))}
            title="고른 트랙을 보호합니다 — 클립·음·오토메이션을 고칠 수 없게"
            className={`${TOOL_BTN} ${track?.locked ? 'border-ink bg-ink text-body' : ''}`}
          >{track?.locked ? '보호됨' : '보호'}</button>
          <button
            type="button"
            disabled={!track}
            aria-pressed={track?.hidden === true}
            onClick={() => editor.commit(setTrackFlag(project, track!.id, 'hidden', !track!.hidden))}
            title="고른 트랙을 목록에서 숨깁니다 — 소리는 그대로 납니다"
            className={`${TOOL_BTN} ${track?.hidden ? 'border-ink bg-ink text-body' : ''}`}
          >{track?.hidden ? '숨김' : '숨기기'}</button>
          <select
            aria-label="트랙 스택"
            disabled={!track}
            value={track?.stackId ?? ''}
            onChange={(e) => runEdit(() => {
              const v = e.target.value;
              if (v === 'new') editor.commit(createStack(project, track!.id).project);
              else editor.commit(setTrackStack(project, track!.id, (v || null) as StackId | null));
            })}
            className={FIELD}
            title="고른 트랙을 스택에 넣습니다 — 스택은 접고 한꺼번에 뮤트·솔로합니다"
          >
            <option value="">스택 없음</option>
            {(project.stacks ?? []).map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            <option value="new">＋ 새 스택</option>
          </select>
          <button
            type="button"
            disabled={!track}
            onClick={() => runEdit(() => {
              const next = duplicateTrack(project, track!.id);
              editor.commit(next.project);
              setSelectedTrackId(next.trackId);
              setSelectedClipId(null);
            })}
            title="고른 트랙을 악기·이펙트·클립째 복제해 바로 아래에 놓습니다"
            className={TOOL_BTN}
          >트랙 복제</button>
          <button
            type="button"
            disabled={!track || track.kind === 'audio' || !!track.freezeOf || engine.exporting}
            onClick={() => void (async () => {
              const t = track!;
              setNotice(`"${t.name}" 을 오디오로 렌더하는 중…`);
              const audio = await engine.renderTrack(t.id);
              if (!audio) return;
              runEdit(() => {
                const next = bounceInPlace(projectRef.current, t.id, audio);
                editor.commit(next.project);
                setSelectedTrackId(next.trackId);
                setNotice(`"${t.name}" 을 오디오 트랙으로 바운스했습니다 — 원래 트랙은 뮤트해 두었습니다`);
              });
            })()}
            title="바운스 인 플레이스 — 고른 트랙을 인서트까지 거친 소리로 렌더해 바로 아래 오디오 트랙에 놓고, 원래 트랙은 뮤트"
            className={TOOL_BTN}
          >바운스</button>
          <button
            type="button"
            disabled={!track || track.kind === 'audio' || !!track.freezeOf || engine.exporting}
            aria-pressed={!!track?.frozen}
            onClick={() => void (async () => {
              const t = track!;
              if (t.frozen) { runEdit(() => { editor.commit(unfreezeTrack(projectRef.current, t.id)); setNotice(`"${t.name}" 을 녹였습니다`); }); return; }
              setNotice(`"${t.name}" 을 얼리는 중…`);
              const audio = await engine.renderTrack(t.id);
              if (!audio) return;
              runEdit(() => {
                editor.commit(freezeTrack(projectRef.current, t.id, audio));
                setNotice(`"${t.name}" 을 얼렸습니다 — 렌더한 소리로 재생해 가볍습니다. 고치려면 녹이세요`);
              });
            })()}
            title="프리즈 — 악기·인서트를 오디오로 구워 CPU 를 아낍니다. 얼린 동안은 고칠 수 없고, 다시 누르면 녹습니다"
            className={`${TOOL_BTN} ${track?.frozen ? 'border-ink bg-ink text-body' : ''}`}
          >{track?.frozen ? '❄ 녹이기' : '❄ 프리즈'}</button>
          {(['up', 'down'] as const).map((dir) => {
            const index = track ? project.tracks.indexOf(track) : -1;
            const to = dir === 'up' ? index - 1 : index + 1;
            return (
              <button
                key={dir}
                type="button"
                disabled={!track || to < 0 || to >= project.tracks.length}
                onClick={() => editor.commit(moveTrack(project, track!.id, to))}
                title={dir === 'up' ? '고른 트랙을 한 칸 위로' : '고른 트랙을 한 칸 아래로'}
                aria-label={dir === 'up' ? '트랙 위로' : '트랙 아래로'}
                className={TOOL_BTN}
              >{dir === 'up' ? '▲' : '▼'}</button>
            );
          })}
                </>}
                onSelectTrack={(id) => {
                  setSelectedTrackId(id);
                  setSelectedClipId(project.tracks.find((t) => t.id === id)?.clips[0]?.id ?? null);
                }}
              />
            </div>

            {track && clip && instrument ? (
              <section className="flex min-h-0 flex-1 flex-col">
                <div className="mb-2 flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="font-disp text-lg leading-none">{clip.label || '클립'}</h2>
                  <span className="text-xs text-ink-3">
                    {track.name} · {clip.notes.length}음
                    {selection.length > 0 ? ` · ${selection.length}개 선택` : ''}
                  </span>
                  {(clip.takes?.length ?? 0) > 0 && (
                    <span className="flex items-center gap-1.5" data-takes>
                      <select aria-label="테이크" value="" className="h-6 rounded border border-rule bg-panel px-1 text-[11px]"
                        onChange={(e) => { if (e.target.value) runEdit(() => editor.commit(switchTake(project, clip.id, e.target.value))); }}>
                        <option value="">테이크 {clip.takes!.length}개 · 바꿔 듣기…</option>
                        {clip.takes!.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.notes.length}음)</option>)}
                      </select>
                      <select aria-label="반복 구간만 테이크에서" value="" disabled={!project.loop}
                        title="반복 구간(⌘L)만 그 테이크의 음으로 — 컴핑"
                        className="h-6 rounded border border-rule bg-panel px-1 text-[11px] disabled:opacity-40"
                        onChange={(e) => {
                          const id = e.target.value;
                          if (!id || !project.loop) return;
                          runEdit(() => editor.commit(compFromTake(project, clip.id, id,
                            project.loop!.startTick - clip.startTick, project.loop!.endTick - clip.startTick)));
                        }}>
                        <option value="">구간만 가져오기…</option>
                        {clip.takes!.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </span>
                  )}
                  <span className="flex-1" />
                  {/* 같은 클립을 보는 두 방식 — 그림(피아노 롤) / 숫자(이벤트 목록) */}
                  <div className={`gap-0.5 self-center rounded-md bg-panel p-0.5 ${clip.audio ? 'hidden' : 'flex'}`} role="tablist" aria-label="편집기 보기">
                    {(['roll', 'steps', 'list', 'score'] as const).map((v) => (
                      <button key={v} type="button" role="tab" aria-selected={editorView === v} onClick={() => setEditorView(v)}
                        className={`h-6 rounded px-2 text-[11px] ${editorView === v ? 'bg-body font-semibold text-ink shadow-sm' : 'text-ink-3'}`}
                      >{v === 'roll' ? '피아노 롤' : v === 'steps' ? '스텝' : v === 'list' ? '이벤트 목록' : '악보'}</button>
                    ))}
                  </div>
                </div>
                {!clip.audio && editorView === 'list' && <div className="scope-screen flex min-h-0 flex-1 flex-col"><EventList editor={editor} clip={clip} onAudition={audition} /></div>}
                {clip.audio && <div className="flex min-h-0 flex-1 flex-col"><AudioEditor editor={editor} clip={clip as typeof clip & { audio: NonNullable<typeof clip.audio> }} /></div>}
                {!clip.audio && editorView === 'score' && <div className="flex min-h-0 flex-1 flex-col"><ScoreView project={project} track={track} clip={clip} editor={editor} noteLength={noteLengthTicks} onAudition={(midi) => audition(midi, 0)} /></div>}
                {!clip.audio && editorView === 'steps' && (
                  <div className="scope-screen flex min-h-0 flex-1 flex-col">
                    <StepSequencer editor={editor} track={track} clip={clip} playheadTick={engine.playheadTick}
                      onAudition={(trackId, midi) => void engine.audition(trackId, midi, 0)} />
                  </div>
                )}
                <div className={`scope-screen min-h-0 flex-1 flex-col gap-2 ${editorView === 'roll' && !clip.audio ? 'flex' : 'hidden'}`}>
                  <PianoRoll
                    className="min-h-[11rem] flex-1"
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
                    colorMode={noteColor}
                  />
                  {/* **레인이 양보한다.** 화면이 짧으면 여기가 먼저 줄고, 필요하면
                      안에서 스크롤한다 — 롤이 먼저 줄면 편집 자체를 못 한다 */}
                  <div className="min-h-0 shrink space-y-2 overflow-y-auto">
                    <VelocityLane editor={editor} clip={clip} onAudition={audition} />
                    <PitchCurveLane editor={editor} clip={clip} onAudition={audition} />
                  </div>
                </div>
                {/* 건반 칸이 열리면 이 도움말이 피아노롤을 덮는다 — 그때는 건반 칸이 같은 몫의 도움말을 준다 */}
                <p className={`mt-2 shrink-0 text-[11px] leading-relaxed text-ink-3 ${playOpen ? 'hidden' : ''}`}>
                  빈 곳 클릭 = 음 추가 · 끌기 = 범위 선택 · Shift+클릭 = 선택 추가 ·
                  눈금 클릭 = 재생 위치 · Space = 커서부터 재생 ·
                  ⌘C/⌘V 복사·붙여넣기 · ⌘D 복제 · ⌘A 전체 선택 · ⌘L 선택 구간 반복 ·
                  ↑↓ 반음 · Delete 삭제 · Esc 선택 해제
                </p>
              </section>
            ) : (
              <p className="rounded-xl border border-dashed border-rule p-6 text-sm text-ink-3">
                트랙과 클립을 만들면 편집기가 열립니다.
              </p>
            )}
          </div>

          {/* **오른쪽은 "이 편집기"의 열이다.** 줄 접기·음역·고스트는 화면에 대한
              설정이고, 그 아래가 선택한 음의 인스펙터다 */}
          <aside className="scope-body flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
            {/* 오른쪽 칸 — 음 편집(인스펙터) 과 브라우저(소리 찾기) 를 탭으로 */}
            <div className="flex gap-1 rounded-lg bg-panel p-1" role="tablist" aria-label="오른쪽 칸">
              {(['inspect', 'controls', 'browse'] as const).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={sideTab === tab} onClick={() => setSideTab(tab)}
                  className={`h-7 flex-1 rounded-md text-xs ${sideTab === tab ? 'bg-body font-semibold text-ink shadow-sm' : 'text-ink-3'}`}
                >{tab === 'inspect' ? '음 편집' : tab === 'controls' ? '컨트롤' : '브라우저'}</button>
              ))}
            </div>
            {sideTab === 'controls' && track && (
              <SmartControls
                editor={editor}
                track={track}
                instrument={instrument}
                params={instrument ? instrumentParams(instrument, track.toneId, track.toneParams) : {}}
              />
            )}
            {sideTab === 'browse' && (
              <SoundBrowser
                editor={editor}
                track={track}
                onPreview={(id) => void engine.previewInstrument(id)}
                onSelectTrack={(id) => { setSelectedTrackId(id); setSelectedClipId(null); }}
                onNotice={setNotice}
              />
            )}
            {sideTab === 'inspect' && track && clip && instrument && (
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
            )}
            {sideTab === 'inspect' && <NoteInspector editor={editor} onAudition={audition} />}
          </aside>
        </div>
      )}
      {view === 'editor' && playOpen && (
        <PlaySurface
          musicalKey={project.key}
          pads={project.tracks.filter((t) => INSTRUMENT_CATALOG.find((e) => e.id === t.instrumentId)?.category === '드럼').map((t) => ({ trackId: t.id, name: t.name }))}
          onPad={(trackId, down, velocity) => {
            // 드럼 트랙이 실제로 쓰는 음 높이로 친다 (없으면 C4) — 한 악기 = 한 패드
            const t = project.tracks.find((x) => x.id === trackId);
            const midis = t?.clips.flatMap((c) => c.notes.map((n) => n.pitch.midi)) ?? [];
            const midi = midis.length ? midis.sort((a, b) => midis.filter((m) => m === b).length - midis.filter((m) => m === a).length)[0]! : 60;
            if (down) void engine.liveOn(trackId as TrackId, midi, velocity); else engine.liveOff(trackId as TrackId, midi);
          }}
          onPlay={(midi, velocity) => midiNoteRef.current(midi, velocity)}
          onRelease={(midi) => midiOffRef.current(midi)}
          onStep={(midi, velocity, chord) => {
            if (!clip) { setNotice('찍을 클립이 없습니다 — 트랙 영역에서 클립을 고르세요'); return; }
            runEdit(() => {
              let { project: next, noteId } = addNote(project, { clipId: clip.id, startTick: cursorTick, lengthTick: noteLengthTicks, midi, velocity });
              // 커서가 클립 끝을 넘었으면 클립을 마디 단위로 늘린다 — 안 늘리면 찍은 음이
              // 클립 밖이라 안 보이고 안 들린다 (Logic 도 스텝 입력이 리전을 늘린다)
              const need = cursorTick + noteLengthTicks;
              if (need > clip.lengthTick) {
                const bar = ticksPerBar(project.timeSignature);
                next = resizeClip(next, clip.id, Math.ceil(need / bar) * bar);
              }
              editor.commit(next);
              editor.select([noteId]);
              if (!chord) setCursorTick((t) => t + noteLengthTicks);
            });
          }}
          onRest={() => setCursorTick((t) => t + noteLengthTicks)}
          onClose={() => setPlayOpen(false)}
        />
      )}
    </div>
  );
}

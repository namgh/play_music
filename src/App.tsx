import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BRAND } from './brand.ts';
import { addClip, addTrack, deleteNotes, moveNotes, quantizeNotes, setTempo } from './editor/edits.ts';
import { useProjectEditor } from './editor/useProjectEditor.ts';
import { downloadProject, loadAutosave, readProjectFile, saveAutosave } from './editor/projectStorage.ts';
import { createEmptyProject } from './model/factory.ts';
import type { ClipId, Project, TrackId } from './model/project.ts';
import { PPQ, ticksPerBar, ticksToBarBeat } from './model/time.ts';
import { createRegistry, playableInstrumentIds } from './instruments/definitions.ts';
import { resolveInstrument } from './instruments/resolve.ts';
import { useAudioEngine } from './audio/useAudioEngine.ts';
import { PianoRoll } from './ui/PianoRoll.tsx';
import { NoteInspector } from './ui/NoteInspector.tsx';
import { TrackList } from './ui/TrackList.tsx';
import { TuningLab } from './ui/TuningLab.tsx';
import { Timeline } from './ui/Timeline.tsx';
import { Mixer } from './ui/Mixer.tsx';

const registry = createRegistry();

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
  const [view, setView] = useState<View>('editor');
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

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
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        downloadProject(project);
        setNotice('파일로 저장했습니다');
        return;
      }
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        if (engine.state === 'playing') engine.stop();
        else void engine.play(0);
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
  }, [editor, engine, gridTicks, project, selection]);

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
              DSP: {engine.engineKind === 'rust' ? 'Rust/WASM' : 'TypeScript (대체)'}
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
            onClick={() => (engine.state === 'playing' ? engine.stop() : void engine.play(0))}
            className="rounded-md bg-teal-300 px-5 py-2 text-sm font-semibold text-teal-950 hover:bg-teal-200"
          >
            {engine.state === 'playing' ? '정지' : '재생'}
          </button>
          <span className="w-20 text-center font-mono text-sm text-neutral-300">{position}</span>

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

          <span className="flex-1" />

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
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => { void onOpenFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <button
            type="button"
            disabled={engine.exporting}
            onClick={() => void engine.exportWav()}
            className="rounded border border-teal-700 px-3 py-1.5 text-sm text-teal-200 disabled:opacity-40"
          >{engine.exporting ? '내보내는 중…' : 'WAV 내보내기'}</button>
        </section>

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
                  <div className="mb-2 flex flex-wrap items-baseline gap-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                      음 편집기
                    </h2>
                    <span className="text-xs text-neutral-500">
                      {track.name} · {clip.label || '클립'} · {clip.notes.length}개 ·
                      격자를 클릭해 추가, 드래그로 이동, 오른쪽 끝으로 길이, ↑↓ 반음, Delete 삭제
                    </span>
                  </div>
                  <PianoRoll
                    editor={editor}
                    clip={clip}
                    range={{ low: instrument.range.low, high: instrument.range.high }}
                    gridTicks={gridTicks}
                    playheadTick={engine.playheadTick}
                    onAudition={audition}
                  />
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

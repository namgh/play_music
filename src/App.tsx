import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND } from './brand.ts';
import { createClip, createEmptyProject, createNote, createTrack } from './model/factory.ts';
import type { Project } from './model/project.ts';
import { PPQ, ticksToBarBeat } from './model/time.ts';
import { formatPitch } from './model/pitch.ts';
import { createRegistry, playableInstrumentIds } from './instruments/definitions.ts';
import { resolveInstrument } from './instruments/resolve.ts';
import { BufferRenderer } from './audio/bufferRenderer.ts';

/**
 * 개발용 확인 화면. **제품 UI 가 아니다.**
 *
 * 스튜디오 화면은 impeccable 스킬이 담당하고 (`CLAUDE.md`), 시안은
 * `mockup/studio-v2.html` 에 있다. 여기서는 데이터 → 스케줄러 → 소리 경로가
 * 실제로 동작하는지 귀로 확인할 수 있게만 해 둔다.
 */

const registry = createRegistry();
const INSTRUMENT_IDS = playableInstrumentIds();

/** 간단한 프레이즈 하나. 음정 편집을 확인하려고 한 음만 -14센트 내려 뒀다 */
function demoProject(instrumentId: string): Project {
  const project = createEmptyProject('확인용');
  project.tempo.bpm = 96;
  project.lengthBars = 2;

  const instrument = resolveInstrument(instrumentId, registry);
  const track = createTrack({ name: instrument.name, instrumentId });

  // 악기 음역 안으로 옮긴다 — 베이스와 우쿨렐레는 음역이 겹치지 않는다
  const center = Math.round((instrument.range.low + instrument.range.high) / 2);
  const scale = [0, 2, 4, 5, 7, 5, 4, 2];

  const clip = createClip({ startTick: 0, lengthTick: 8 * PPQ, label: 'DEMO' });
  scale.forEach((step, i) => {
    const note = createNote({
      startTick: i * PPQ,
      lengthTick: PPQ,
      midi: center + step,
      velocity: 0.75,
    });
    if (i === 5) note.pitch = { midi: note.pitch.midi, cents: -14 };
    clip.notes.push(note);
  });

  track.clips.push(clip);
  project.tracks.push(track);
  return project;
}

export function App() {
  const [instrumentId, setInstrumentId] = useState(INSTRUMENT_IDS[1] ?? 'acoustic-guitar');
  const [state, setState] = useState<'stopped' | 'playing'>('stopped');
  const [position, setPosition] = useState('1.1.00');
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const rendererRef = useRef<BufferRenderer | null>(null);

  const project = useMemo(() => demoProject(instrumentId), [instrumentId]);
  const instrument = useMemo(() => resolveInstrument(instrumentId, registry), [instrumentId]);

  const renderer = useCallback((): BufferRenderer => {
    if (!ctxRef.current) ctxRef.current = new AudioContext({ latencyHint: 'interactive' });
    if (!rendererRef.current) rendererRef.current = new BufferRenderer(ctxRef.current, registry);
    return rendererRef.current;
  }, []);

  useEffect(() => () => { rendererRef.current?.dispose(); }, []);

  // 재생 중에는 위치를 갱신한다
  useEffect(() => {
    if (state !== 'playing') return;
    let raf = 0;
    const tick = () => {
      const r = rendererRef.current;
      if (r) {
        const pos = r.getPosition();
        const bb = ticksToBarBeat(Math.max(0, pos.tick), project.timeSignature);
        setPosition(`${bb.bar}.${bb.beat}.${Math.floor(bb.fraction * 100).toString().padStart(2, '0')}`);
        if (bb.bar > project.lengthBars) { r.stop(); setState('stopped'); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, project]);

  const onPlay = async () => {
    setError(null);
    try {
      const r = renderer();
      await ctxRef.current!.resume();
      r.setProject(project);
      r.play(0);
      setState('playing');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onStop = () => {
    rendererRef.current?.stop();
    setState('stopped');
    setPosition('1.1.00');
  };

  const notes = project.tracks[0]!.clips[0]!.notes;

  return (
    <main className="mx-auto max-w-3xl px-6 py-14 text-neutral-200">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          {BRAND.name}
          {BRAND.isPlaceholder && (
            <span className="ml-3 align-middle text-xs font-normal text-neutral-500">이름 임시</span>
          )}
        </h1>
        <p className="mt-3 text-sm/6 text-neutral-400">
          개발용 확인 화면입니다. 제품 UI 가 아니고, 프로젝트 데이터 → 스케줄러 → 소리 경로가
          동작하는지만 봅니다. 스튜디오 화면 시안은 <code className="text-neutral-300">mockup/studio-v2.html</code>.
        </p>
      </header>

      <section className="mt-10 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={state === 'playing' ? onStop : onPlay}
          className="rounded-md bg-teal-300 px-5 py-2 text-sm font-semibold text-teal-950 hover:bg-teal-200"
        >
          {state === 'playing' ? '정지' : '재생'}
        </button>
        <span className="font-mono text-sm text-neutral-400">{position}</span>
        <span className="flex-1" />
        <label className="text-sm text-neutral-500" htmlFor="instrument">악기</label>
        <select
          id="instrument"
          value={instrumentId}
          onChange={(e) => { onStop(); setInstrumentId(e.target.value); }}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          {INSTRUMENT_IDS.map((id) => (
            <option key={id} value={id}>{resolveInstrument(id, registry).name}</option>
          ))}
        </select>
      </section>

      {error && (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          이 악기 — {instrument.lineage.join(' ← ')}
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 border-y border-neutral-800 py-3 text-sm sm:grid-cols-3">
          {Object.entries(instrument.params).map(([key, value]) => {
            const spec = instrument.paramSpecs[key];
            return (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-neutral-500">{spec?.label ?? key}</dt>
                <dd className="font-mono text-neutral-200">
                  {value}{spec?.unit ? ` ${spec.unit}` : ''}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          음 {notes.length}개 · {project.tempo.bpm} BPM
        </h2>
        <ul className="mt-3 divide-y divide-neutral-800 border-y border-neutral-800 text-sm">
          {notes.map((note, i) => (
            <li key={note.id} className="flex items-baseline gap-4 py-2">
              <span className="w-8 font-mono text-neutral-600">{i + 1}</span>
              <span className="font-mono text-neutral-200">{formatPitch(note.pitch, project.tuning)}</span>
              {note.pitch.cents !== 0 && (
                <span className="text-xs text-teal-300">센트 편집됨</span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-neutral-500">
          6번째 음만 -14센트 내려 뒀습니다. 재생하면 그 음이 살짝 낮게 들려야 합니다.
        </p>
      </section>
    </main>
  );
}

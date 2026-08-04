import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LiveEngine } from '../audio/liveEngine.ts';
import wasmUrl from '../generated/dsp.wasm?url';
import { createRegistry, playableInstrumentIds } from '../instruments/definitions.ts';
import { clampParams, instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import type { ParamSpec, ParamValue } from '../instruments/types.ts';
import { NOTE_NAMES } from '../model/pitch.ts';
import { Spectrum } from './Spectrum.tsx';

/**
 * 튜닝 워크플로 도구 (`sound.md` 9-6 M1.5).
 *
 * 이 도구가 없으면 이후 악기 튜닝이 몇 배로 든다. 파라미터 튜닝은 귀로만 잡히고
 * AI 로 압축되지 않는 비용이라, **반복 속도에 먼저 투자**하는 것이 문서의 판단이다.
 *
 * 요구 5개 (9-6):
 *  1. 파라미터 실시간 반영 (재컴파일·재시작 없이) — 워크렛 + `set_params_live`
 *  2. A/B 즉시 전환 (현재 값 ↔ 저장된 스냅샷)
 *  3. 레퍼런스 음원 동시 재생 비교
 *  4. 파라미터 스냅샷 저장/복원
 *  5. 스펙트로그램 실시간 표시
 */

const registry = createRegistry();
const INSTRUMENT_IDS = playableInstrumentIds();
const SNAPSHOT_KEY = 'tuning-snapshots-v1';

type Params = Record<string, ParamValue>;

interface Snapshot {
  name: string;
  instrumentId: string;
  params: Params;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const noteName = (m: number) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

function loadSnapshots(): Snapshot[] {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? (JSON.parse(raw) as Snapshot[]) : [];
  } catch {
    return [];
  }
}

export function TuningLab() {
  const [instrumentId, setInstrumentId] = useState(INSTRUMENT_IDS[1] ?? 'acoustic-guitar');
  const instrument = useMemo(() => resolveInstrument(instrumentId, registry), [instrumentId]);

  const [slotA, setSlotA] = useState<Params>({});
  const [slotB, setSlotB] = useState<Params>({});
  const [active, setActive] = useState<'A' | 'B'>('A');

  const [midi, setMidi] = useState(57);
  const [repeat, setRepeat] = useState(false);
  const [repeatSec, setRepeatSec] = useState(1.5);
  const [snapshots, setSnapshots] = useState<Snapshot[]>(() => loadSnapshots());
  const [status, setStatus] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<LiveEngine | null>(null);
  const referenceRef = useRef<HTMLAudioElement | null>(null);

  const params = active === 'A' ? slotA : slotB;
  const setParams = active === 'A' ? setSlotA : setSlotB;

  // 악기를 바꾸면 두 슬롯을 그 악기의 기본값으로 채운다
  useEffect(() => {
    const base = instrumentParams(instrument, 'default', null);
    setSlotA({ ...base });
    setSlotB({ ...base });
  }, [instrument]);

  const engine = useCallback(async (): Promise<LiveEngine> => {
    if (!ctxRef.current) ctxRef.current = new AudioContext({ latencyHint: 'interactive' });
    const ctx = ctxRef.current;
    if (!engineRef.current) {
      const response = await fetch(wasmUrl);
      engineRef.current = await LiveEngine.create(ctx, { wasmBytes: await response.arrayBuffer() });
      setReady(true);
      setStatus(`워크렛 실행 중 — ${ctx.sampleRate} Hz · Rust/WASM`);
    }
    await ctx.resume();
    return engineRef.current;
  }, []);

  useEffect(() => () => { engineRef.current?.dispose(); }, []);

  const pluck = useCallback(async () => {
    try {
      const live = await engine();
      live.pluck(midiToHz(midi), 0.9, clampParams(instrument, params));
      setStatus(null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [engine, instrument, midi, params]);

  // 파라미터가 바뀌면 **울리고 있는 소리에 바로 반영한다** (요구 1)
  useEffect(() => {
    if (!ready) return;
    engineRef.current?.setParamsLive(clampParams(instrument, params));
  }, [instrument, params, ready]);

  // 반복 연주 — 파라미터를 돌리면서 계속 듣는다
  useEffect(() => {
    if (!repeat) return;
    void pluck();
    const timer = setInterval(() => void pluck(), repeatSec * 1000);
    return () => clearInterval(timer);
  }, [repeat, repeatSec, pluck]);

  const update = (key: string, value: number) => setParams((prev) => ({ ...prev, [key]: value }));

  const swap = () => setActive((slot) => (slot === 'A' ? 'B' : 'A'));

  // A/B 즉시 전환 — Tab (요구 2)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      event.preventDefault();
      swap();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const saveSnapshot = () => {
    const name = `${instrument.name} ${new Date().toLocaleTimeString('ko-KR')}`;
    const next = [{ name, instrumentId, params: { ...params } }, ...snapshots].slice(0, 30);
    setSnapshots(next);
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(next));
  };

  const restoreSnapshot = (snapshot: Snapshot, into: 'A' | 'B') => {
    if (snapshot.instrumentId !== instrumentId) setInstrumentId(snapshot.instrumentId);
    // 악기 변경 이펙트가 슬롯을 덮어쓰므로 한 틱 뒤에 넣는다
    setTimeout(() => {
      (into === 'A' ? setSlotA : setSlotB)({ ...snapshot.params });
      setActive(into);
    }, 0);
  };

  const specs = Object.entries(instrument.paramSpecs) as [string, ParamSpec][];
  const grouped = new Map<string, [string, ParamSpec][]>();
  for (const entry of specs) {
    const group = entry[1].group ?? '기타';
    grouped.set(group, [...(grouped.get(group) ?? []), entry]);
  }

  const differences = specs.filter(([key]) => slotA[key] !== slotB[key]);

  const onReferenceFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !referenceRef.current) return;
    referenceRef.current.src = URL.createObjectURL(file);
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 p-3">
        <button
          type="button"
          onClick={() => void pluck()}
          className="rounded-md bg-teal-300 px-5 py-2 text-sm font-semibold text-teal-950 hover:bg-teal-200"
        >
          뜯기
        </button>
        <button
          type="button"
          aria-pressed={repeat}
          onClick={() => setRepeat((on) => !on)}
          className={`rounded-md border px-3 py-2 text-sm ${
            repeat ? 'border-teal-300 bg-teal-300 text-teal-950' : 'border-neutral-700'
          }`}
        >
          {repeat ? '반복 중' : '반복'}
        </button>
        <input
          type="range" min={0.4} max={4} step={0.1} value={repeatSec}
          aria-label="반복 간격"
          onChange={(e) => setRepeatSec(Number(e.target.value))}
          className="w-24 accent-teal-300"
        />
        <span className="w-12 font-mono text-xs text-neutral-500">{repeatSec.toFixed(1)}s</span>

        <span className="ml-2 text-xs text-neutral-500">음</span>
        <input
          type="range"
          min={instrument.range.low} max={instrument.range.high} step={1}
          value={Math.min(instrument.range.high, Math.max(instrument.range.low, midi))}
          aria-label="시험할 음"
          onChange={(e) => setMidi(Number(e.target.value))}
          className="w-32 accent-teal-300"
        />
        <span className="w-24 font-mono text-xs text-neutral-300">
          {noteName(midi)} · {midiToHz(midi).toFixed(1)}Hz
        </span>

        <span className="flex-1" />
        <select
          value={instrumentId}
          onChange={(e) => setInstrumentId(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
        >
          {INSTRUMENT_IDS.map((id) => (
            <option key={id} value={id}>{resolveInstrument(id, registry).name}</option>
          ))}
        </select>
      </section>

      {status && (
        <p className="rounded-md border border-neutral-800 px-4 py-2 font-mono text-xs text-neutral-400">
          {status}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Spectrum analyser={engineRef.current?.analyser ?? null} fundamentalHz={midiToHz(midi)} />

          <section className="rounded-lg border border-neutral-800 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                A/B 슬롯
              </h2>
              <span className="text-xs text-neutral-500">Tab 으로 즉시 전환</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setActive('A')}
                className={`rounded border px-4 py-1.5 font-mono text-sm ${
                  active === 'A' ? 'border-teal-300 bg-teal-300 text-teal-950' : 'border-neutral-700'
                }`}
              >A</button>
              <button
                type="button"
                onClick={() => setActive('B')}
                className={`rounded border px-4 py-1.5 font-mono text-sm ${
                  active === 'B' ? 'border-teal-300 bg-teal-300 text-teal-950' : 'border-neutral-700'
                }`}
              >B</button>
              <button
                type="button"
                onClick={() => setSlotB({ ...slotA })}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs"
              >A → B 복사</button>
              <button
                type="button"
                onClick={saveSnapshot}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs"
              >스냅샷 저장</button>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              {differences.length === 0
                ? 'A 와 B 가 같습니다 — 한쪽 값을 바꿔 비교하세요.'
                : `차이: ${differences.map(([key, spec]) => `${spec.label} ${slotA[key]} / ${slotB[key]}`).join(' · ')}`}
            </p>
          </section>

          {[...grouped].map(([group, entries]) => (
            <section key={group} className="rounded-lg border border-neutral-800 p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                {group} <span className="text-neutral-600">— 슬롯 {active}</span>
              </h2>
              <div className="mt-3 space-y-3">
                {entries.map(([key, spec]) => {
                  const value = typeof params[key] === 'number' ? (params[key] as number) : 0;
                  return (
                    <div key={key} className="grid grid-cols-[8rem_1fr_5rem] items-center gap-3">
                      <label htmlFor={`p-${key}`} className="text-sm text-neutral-400">{spec.label}</label>
                      <input
                        id={`p-${key}`}
                        type="range"
                        min={spec.min ?? 0}
                        max={spec.max ?? 1}
                        step={((spec.max ?? 1) - (spec.min ?? 0)) / 500}
                        value={value}
                        onChange={(e) => update(key, Number(e.target.value))}
                        className="accent-teal-300"
                      />
                      <span className="text-right font-mono text-xs text-neutral-300">
                        {value.toFixed(spec.type === 'int' || (spec.max ?? 1) > 100 ? 0 : 3)}
                        {spec.unit ? ` ${spec.unit}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <aside className="space-y-6">
          <section className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              레퍼런스 음원
            </h2>
            <p className="mt-2 text-xs text-neutral-500">
              실제 녹음이나 상용 라이브러리 소리를 같이 틀어 비교합니다 (`sound.md` 11-3).
            </p>
            <input
              type="file"
              accept="audio/*"
              onChange={onReferenceFile}
              className="mt-3 w-full text-xs text-neutral-400"
            />
            <audio ref={referenceRef} controls className="mt-3 w-full" />
          </section>

          <section className="rounded-lg border border-neutral-800 p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              스냅샷 {snapshots.length}
            </h2>
            {snapshots.length === 0 ? (
              <p className="mt-2 text-xs text-neutral-500">
                아직 없습니다. 마음에 드는 값이 나오면 저장해 두고 나중 값과 A/B 하세요.
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {snapshots.map((snapshot, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate text-neutral-300">{snapshot.name}</span>
                    <button
                      type="button"
                      onClick={() => restoreSnapshot(snapshot, 'A')}
                      className="rounded border border-neutral-700 px-2 py-0.5 font-mono"
                    >A</button>
                    <button
                      type="button"
                      onClick={() => restoreSnapshot(snapshot, 'B')}
                      className="rounded border border-neutral-700 px-2 py-0.5 font-mono"
                    >B</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-neutral-800 p-4 text-xs text-neutral-500">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              알아 둘 것
            </h2>
            <ul className="mt-2 space-y-1.5">
              <li>슬라이더는 <b className="text-neutral-300">울리고 있는 소리에 바로</b> 반영됩니다.</li>
              <li>
                크게 움직이면 <b className="text-neutral-300">클릭이 납니다</b> — 파라미터 스무딩
                (`sound.md` 6-4)이 아직 없습니다. 소리 판단에는 반복 연주 쪽이 정확합니다.
              </li>
              <li>강성을 올리면 상위 하모닉이 위로 밀립니다(인하모니시티). 스펙트럼에서 보입니다.</li>
              <li>뜯는 위치는 하모닉에 노치를 만듭니다.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

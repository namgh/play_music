import { useCallback, useEffect, useRef, useState } from 'react';

import type { PlayOptions } from './renderer.ts';
import { fadeOutTail, measureBounce, normalizePeak, safeFileName, sliceRange, tpdfDither } from './bounce.ts';
import type { BounceReport } from './bounce.ts';
import { makeZip } from './zip.ts';
import { ticksToSeconds } from '../model/time.ts';
import type { Project, TrackId } from '../model/project.ts';
import { createNote, createTrack, projectLengthTicks } from '../model/factory.ts';
import { loadInstruments } from '../instruments/loader.ts';

const PREVIEW_TRACK = 'trk_preview' as TrackId;
import type { InstrumentDefinition } from '../instruments/types.ts';
import type { AudioRenderer } from './renderer.ts';
import { BufferRenderer } from './bufferRenderer.ts';
import { WorkletRenderer } from './workletRenderer.ts';
import { WasmVoiceEngine } from './voice/wasmEngine.ts';
import wasmUrl from '../generated/dsp.wasm?url';
import fxUrl from '../generated/fx.wasm?url';
import { setFxBytes } from './fxRuntime.ts';
import { encodeWav, peakAmplitude } from './wav.ts';
import { reportClipping, type ClipReport } from './headroom.ts';

/**
 * 오디오 엔진 연결. React 쪽에서 Web Audio 를 아는 유일한 곳이다.
 *
 * `AudioContext` 는 사용자 제스처가 있어야 시작되므로 첫 재생·시청 때 만든다.
 * 미리 만들면 브라우저가 정지 상태로 두고, "재생을 눌렀는데 소리가 안 난다"가 된다.
 *
 * **렌더러는 워크렛이 기본이다** (파라미터 스무딩이 들어간 뒤 경로를 통합했다).
 * 워크렛을 못 쓰는 환경에서는 미리 렌더 방식(`BufferRenderer`)으로 떨어진다 —
 * 소리가 아예 안 나는 것보다는 낫고, 어느 쪽인지 화면에 표시한다.
 */

export type EngineKind = 'worklet' | 'buffer' | 'typescript';

export const ENGINE_LABELS: Record<EngineKind, string> = {
  worklet: 'Rust/WASM · 워크렛',
  buffer: 'Rust/WASM · 미리 렌더',
  typescript: 'TypeScript (대체)',
};

export interface BounceOptions {
  startTick: number;
  endTick: number;
  /** 끝 뒤에 더 담을 꼬리(초) — 리버브·딜레이가 끝까지 울리게 */
  tailSec: number;
  sampleRate: 44100 | 48000;
  bitDepth: 16 | 24;
  /** 피크 노멀라이즈 목표(dBFS). null 이면 안 한다 */
  normalizeDb: number | null;
  /** 트랙마다 따로 (ZIP 으로 묶는다) */
  stems: boolean;
}

export const DEFAULT_BOUNCE: BounceOptions = {
  startTick: 0, endTick: Number.MAX_SAFE_INTEGER, tailSec: 2, sampleRate: 48000, bitDepth: 24, normalizeDb: null, stems: false,
};

export function useAudioEngine(
  project: Project,
  registry: ReadonlyMap<string, InstrumentDefinition>,
) {
  const ctxRef = useRef<AudioContext | null>(null);
  const rendererRef = useRef<AudioRenderer | null>(null);
  const readyRef = useRef<(() => Promise<void>) | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  /** 라이브 루프 연주용 곡 (`liveLoops.ts`). 있으면 렌더러는 이것을 연주한다 */
  const performingRef = useRef<Project | null>(null);

  const [state, setState] = useState<'stopped' | 'playing'>('stopped');
  const [playheadTick, setPlayheadTick] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /** 내보낸 파일이 잘렸는지. null 이면 정상 */
  const [clip, setClip] = useState<ClipReport | null>(null);
  const [engineKind, setEngineKind] = useState<EngineKind | null>(null);

  /**
   * 메트로놈. 렌더러가 아직 없으면 값만 기억해 두고 만들어질 때 반영한다 —
   * `AudioContext` 는 사용자 제스처가 있어야 생기므로 켜는 시점에 없을 수 있다.
   */
  const metronomeRef = useRef(false);
  const setMetronome = useCallback((on: boolean) => {
    metronomeRef.current = on;
    rendererRef.current?.setMetronome(on);
  }, []);

  const ensure = useCallback(async (): Promise<AudioRenderer> => {
    if (!ctxRef.current) ctxRef.current = new AudioContext({ latencyHint: 'interactive' });
    const ctx = ctxRef.current;

    if (!rendererRef.current) {
      let bytes: ArrayBuffer | null = null;
      try {
        bytes = await (await fetch(wasmUrl)).arrayBuffer();
      } catch (err) {
        console.warn('wasm 을 가져오지 못했다', err);
      }
      // 이펙트 코어 — 없으면 Rust 이펙트만 통과로 떨어진다 (나머지는 그대로)
      try {
        setFxBytes(await (await fetch(fxUrl)).arrayBuffer());
      } catch (err) {
        console.warn('fx.wasm 을 가져오지 못했다 — Rust 이펙트는 통과시킨다', err);
      }

      // 1순위: 워크렛 (통합 경로)
      if (bytes) {
        try {
          const renderer = await WorkletRenderer.create(ctx, registry, bytes);
          rendererRef.current = renderer;
          readyRef.current = () => renderer.whenReady();
          setEngineKind('worklet');
        } catch (err) {
          console.warn('워크렛을 쓸 수 없다 — 미리 렌더 방식으로 떨어진다', err);
        }
      }

      // 2순위: 미리 렌더 + Rust 코어
      if (!rendererRef.current) {
        let wasm: WasmVoiceEngine | null = null;
        let factory: ((sampleRate: number) => Promise<WasmVoiceEngine>) | null = null;
        if (bytes) {
          try {
            const owned = bytes;
            wasm = await WasmVoiceEngine.create(owned, ctx.sampleRate);
            factory = (rate: number) => WasmVoiceEngine.create(owned, rate);
          } catch (err) {
            console.warn('Rust 코어 로드 실패 — TS 구현으로 진행한다', err);
          }
        }
        rendererRef.current = new BufferRenderer(ctx, registry, wasm, factory);
        readyRef.current = null;
        setEngineKind(wasm ? 'buffer' : 'typescript');
      }
    }

    await ctx.resume();
    // 워크렛이 wasm 을 준비하기 전에 예약하면 그 음들이 버려진다
    await readyRef.current?.();
    rendererRef.current.setMetronome(metronomeRef.current);
    return rendererRef.current;
  }, [registry]);

  // 편집 결과를 렌더러에 반영한다. 이미 만들어진 뒤에만
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      // 라이브 루프 연주 중이면 연주용 곡을 다시 만들어야 하므로 여기서는 건드리지 않는다
      if (performingRef.current) return;
      renderer.setProject(project);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project]);

  useEffect(() => () => { rendererRef.current?.dispose(); }, []);

  const stop = useCallback(() => {
    rendererRef.current?.stop();
    // 라이브 루프 연주였으면 곡으로 돌아간다
    if (performingRef.current) {
      performingRef.current = null;
      rendererRef.current?.setProject(projectRef.current);
    }
    setState('stopped');
    setPlayheadTick(null);
  }, []);

  const play = useCallback(async (fromTick = 0, options: PlayOptions = {}) => {
    try {
      const renderer = await ensure();
      renderer.setProject(projectRef.current);
      renderer.play(fromTick, options);
      setState('playing');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('stopped');
    }
  }, [ensure]);

  // 재생 위치 갱신
  useEffect(() => {
    if (state !== 'playing') return;
    let raf = 0;
    const step = () => {
      const renderer = rendererRef.current;
      if (renderer) {
        const pos = renderer.getPosition();
        setPlayheadTick(pos.tick);
        if (pos.tick > projectLengthTicks(projectRef.current)) {
          renderer.stop();
          setState('stopped');
          setPlayheadTick(null);
          return;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  /** 편집 중 즉시 들려주기 */
  const audition = useCallback(async (trackId: TrackId, midi: number, cents: number, velocity?: number) => {
    try {
      const renderer = await ensure();
      renderer.setProject(projectRef.current);
      renderer.auditionNote(trackId, createNote({ startTick: 0, midi, cents, ...(velocity === undefined ? {} : { velocity }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ensure]);

  /**
   * 실시간 연주 — 누르는 동안 울린다 (`PARITY_ROUND2.md` 2). 엔진 준비(비동기) 전에 떼면
   * 켜는 신호가 늦게 가서 30초 동안 울리게 된다 — 그래서 누른 건반을 기억하고, 준비가 끝났을 때
   * 이미 뗐으면 짧은 미리 듣기로 대신한다.
   */
  const heldRef = useRef(new Set<string>());
  const liveOn = useCallback(async (trackId: TrackId, midi: number, velocity: number) => {
    const key = `${trackId}:${midi}`;
    heldRef.current.add(key);
    try {
      const renderer = await ensure();
      renderer.setProject(projectRef.current);
      if (!renderer.liveNoteOn || !heldRef.current.has(key)) {
        renderer.auditionNote(trackId, createNote({ startTick: 0, midi, velocity }));
        return;
      }
      renderer.liveNoteOn(trackId, midi, velocity);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ensure]);
  const liveOff = useCallback((trackId: TrackId, midi: number) => {
    heldRef.current.delete(`${trackId}:${midi}`);
    rendererRef.current?.liveNoteOff?.(trackId, midi);
  }, []);

  /**
   * 곡에 없는 악기를 한 음 들려준다 (브라우저 미리 듣기). 렌더러에 **보이지 않는 트랙**
   * 하나를 잠깐 얹는다 — 다음 편집의 `setProject` 가 그 트랙을 치운다.
   */
  const previewInstrument = useCallback(async (instrumentId: string, midi = 60) => {
    try {
      await loadInstruments([instrumentId]);
      const renderer = await ensure();
      const preview = { ...createTrack({ name: '미리 듣기', instrumentId }), id: PREVIEW_TRACK };
      renderer.setProject({ ...projectRef.current, tracks: [...projectRef.current.tracks, preview] });
      // 새 트랙의 워크렛이 wasm 을 준비하기 전에 보낸 음은 버려진다
      await (renderer as { whenReady?: () => Promise<void> }).whenReady?.();
      renderer.auditionNote(PREVIEW_TRACK, createNote({ startTick: 0, midi, velocity: 0.8 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ensure]);

  /**
   * 라이브 루프 연주 — 곡을 바꾸지 않고 연주용 곡을 반복 재생한다. 칸을 바꾸면 **지금
   * 자리(반복 안에서)부터 이어서** — 처음으로 되돌아가면 박이 끊긴다. null 이면 멈추고 곡으로.
   */
  const perform = useCallback(async (performance: Project | null) => {
    try {
      const renderer = await ensure();
      if (!performance) {
        performingRef.current = null;
        renderer.stop();
        renderer.setProject(projectRef.current);
        setState('stopped');
        setPlayheadTick(null);
        return;
      }
      const wasPlaying = performingRef.current !== null;
      performingRef.current = performance;
      const loopEnd = performance.loop?.endTick ?? 1;
      const at = wasPlaying ? (renderer.getPosition().tick % loopEnd) : 0;
      renderer.setProject(performance);
      renderer.play(at);
      setState('playing');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ensure]);

  /** WAV 로 내보내고 다운로드시킨다 (`plan.md` 5-1 Phase 1 완료 조건) */
  /**
   * 미터가 프레임마다 부른다. **렌더러가 아직 없거나 레벨을 못 주면 `null`** 이고,
   * 그때 미터는 조용히 0 으로 남는다 — 대체 렌더러(`BufferRenderer`)는 소리를 미리
   * 만들어 두는 구조라 실시간 레벨이라는 것이 없다.
   *
   * `useCallback` 으로 참조를 고정한다. 프레임마다 부르는 값이 매 렌더 새 함수면
   * 미터가 그때마다 다시 등록된다
   */
  const readLevel = useCallback((trackId: TrackId | null) => {
    const renderer = rendererRef.current;
    return renderer?.readLevel ? renderer.readLevel(trackId) : null;
  }, []);
  const readEffectMeters = useCallback((owner: string | null, index: number) => {
    const renderer = rendererRef.current;
    return renderer?.readEffectMeters ? renderer.readEffectMeters(owner, index) : null;
  }, []);
  const compensationSamples = useCallback(() => rendererRef.current?.compensationSamples?.() ?? 0, []);

  /**
   * 바운스 (Logic Bounce, `LOGIC_PARITY.md` 1-13). 렌더는 언제나 곡 전체를 그리고
   * 범위·노멀라이즈·디더는 그 결과를 다듬는다 (`bounce.ts`). 스템이면 ZIP 하나로.
   */
  /** 곡 전체를 48kHz 로 그려 채널을 돌려준다 — 마스터링 도우미가 잰다 (파일로 내리지 않는다) */
  const renderMix = useCallback(async (): Promise<Float32Array[] | null> => {
    setExporting(true);
    try {
      const renderer = await ensure();
      renderer.setProject(projectRef.current);
      const result = await renderer.exportAudio({ sampleRate: 48000, stems: false });
      return result.buffers[0]?.channels ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setExporting(false);
    }
  }, [ensure]);

  const bounce = useCallback(async (options: BounceOptions = DEFAULT_BOUNCE): Promise<BounceReport | null> => {
    setExporting(true);
    try {
      const renderer = await ensure();
      const project = projectRef.current;
      renderer.setProject(project);
      const result = await renderer.exportAudio({ sampleRate: options.sampleRate, stems: options.stems });
      if (result.buffers.length === 0) throw new Error('내보낼 것이 없다');

      const sr = result.sampleRate;
      const startSec = ticksToSeconds(options.startTick, project.tempo);
      const endSec = ticksToSeconds(options.endTick, project.tempo) + options.tailSec;
      const songEnd = options.endTick >= projectLengthTicks(project);
      let report: BounceReport | null = null;

      const files = result.buffers.map((buffer, index) => {
        let channels = sliceRange(buffer.channels, sr, { startSec, endSec });
        // 곡 중간에서 끊었는데 꼬리도 안 붙였으면 끝에서 "딱" 한다 — 짧게 내린다
        if (!songEnd && options.tailSec === 0) channels = fadeOutTail(channels, sr);
        if (options.normalizeDb !== null) channels = normalizePeak(channels, options.normalizeDb).channels;
        // **피크는 노멀라이즈 뒤에 잰다** — 1 을 넘으면 인코딩에서 잘린다 (`ROADMAP.md` P3)
        if (index === 0) {
          setClip(reportClipping(peakAmplitude(channels), project.master.gain));
          report = measureBounce(channels, sr);
        }
        if (options.bitDepth === 16) channels = tpdfDither(channels, 16);
        const trackName = buffer.trackId === null ? null : project.tracks.find((t) => t.id === buffer.trackId)?.name ?? `트랙 ${index + 1}`;
        const name = `${safeFileName(project.name, 'project')}${trackName ? ` - ${safeFileName(trackName, `트랙 ${index + 1}`)}` : ''}.wav`;
        return { name, data: encodeWav(channels, { sampleRate: sr, bitDepth: options.bitDepth }) };
      });

      const single = files.length === 1 ? files[0]! : null;
      const blob = single
        ? new Blob([single.data as unknown as BlobPart], { type: 'audio/wav' })
        : new Blob([makeZip(files) as unknown as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = single ? single.name : `${safeFileName(project.name, 'project')} - 스템.zip`;
      link.click();
      URL.revokeObjectURL(url);
      setError(null);
      return report;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setExporting(false);
    }
  }, [ensure]);

  /** 예전 단추 — 곡 전체 · 48kHz · 24bit */
  const exportWav = useCallback(() => bounce({
    ...DEFAULT_BOUNCE, endTick: projectLengthTicks(projectRef.current),
  }), [bounce]);

  return {
    state, playheadTick, error, exporting, engineKind, clip, readLevel, readEffectMeters, compensationSamples,
    play, stop, audition, liveOn, liveOff, previewInstrument, perform, exportWav, bounce, renderMix, setMetronome,
  };
}

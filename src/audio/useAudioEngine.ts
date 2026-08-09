import { useCallback, useEffect, useRef, useState } from 'react';

import type { Project, TrackId } from '../model/project.ts';
import { createNote, projectLengthTicks } from '../model/factory.ts';
import type { InstrumentDefinition } from '../instruments/types.ts';
import type { AudioRenderer } from './renderer.ts';
import { BufferRenderer } from './bufferRenderer.ts';
import { WorkletRenderer } from './workletRenderer.ts';
import { WasmVoiceEngine } from './voice/wasmEngine.ts';
import wasmUrl from '../generated/dsp.wasm?url';
import { encodeWav, peakAmplitude } from './wav.ts';

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

export function useAudioEngine(
  project: Project,
  registry: ReadonlyMap<string, InstrumentDefinition>,
) {
  const ctxRef = useRef<AudioContext | null>(null);
  const rendererRef = useRef<AudioRenderer | null>(null);
  const readyRef = useRef<(() => Promise<void>) | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;

  const [state, setState] = useState<'stopped' | 'playing'>('stopped');
  const [playheadTick, setPlayheadTick] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /** 내보낸 파일이 잘렸는지. null 이면 정상 */
  const [clipWarning, setClipWarning] = useState<string | null>(null);
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
      renderer.setProject(project);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project]);

  useEffect(() => () => { rendererRef.current?.dispose(); }, []);

  const stop = useCallback(() => {
    rendererRef.current?.stop();
    setState('stopped');
    setPlayheadTick(null);
  }, []);

  const play = useCallback(async (fromTick = 0) => {
    try {
      const renderer = await ensure();
      renderer.setProject(projectRef.current);
      renderer.play(fromTick);
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
  const audition = useCallback(async (trackId: TrackId, midi: number, cents: number) => {
    try {
      const renderer = await ensure();
      renderer.setProject(projectRef.current);
      renderer.auditionNote(trackId, createNote({ startTick: 0, midi, cents }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ensure]);

  /** WAV 로 내보내고 다운로드시킨다 (`plan.md` 5-1 Phase 1 완료 조건) */
  const exportWav = useCallback(async () => {
    setExporting(true);
    try {
      const renderer = await ensure();
      renderer.setProject(projectRef.current);
      const result = await renderer.exportAudio({ sampleRate: 48000, stems: false });
      const first = result.buffers[0];
      if (!first) throw new Error('내보낼 것이 없다');

      // **피크를 재서 알려 준다.** 1 을 넘으면 인코딩에서 잘리는데, 조용히 잘린
      // 파일이 나가면 사용자는 자기 곡이 그대로 나갔다고 믿는다 (`ROADMAP.md` P3)
      const peak = peakAmplitude(first.channels);
      setClipWarning(peak > 1
        ? `피크가 ${(20 * Math.log10(peak)).toFixed(1)}dBFS 입니다 — 파일에서 잘렸습니다. `
          + '트랙 볼륨이나 마스터 게인을 낮추고 다시 내보내세요'
        : null);

      const bytes = encodeWav(first.channels, { sampleRate: result.sampleRate, bitDepth: 24 });
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${projectRef.current.name || 'project'}.wav`;
      link.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [ensure]);

  return {
    state, playheadTick, error, exporting, engineKind, clipWarning,
    play, stop, audition, exportWav, setMetronome,
  };
}

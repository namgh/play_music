import { useCallback, useEffect, useRef, useState } from 'react';

import type { Project, TrackId } from '../model/project.ts';
import { createNote, projectLengthTicks } from '../model/factory.ts';
import type { InstrumentDefinition } from '../instruments/types.ts';
import { BufferRenderer } from './bufferRenderer.ts';
import { WasmVoiceEngine } from './voice/wasmEngine.ts';
import wasmUrl from '../generated/dsp.wasm?url';
import { encodeWav } from './wav.ts';

/**
 * 오디오 엔진 연결. React 쪽에서 Web Audio 를 아는 유일한 곳이다.
 *
 * `AudioContext` 는 사용자 제스처가 있어야 시작되므로 첫 재생·시청 때 만든다.
 * 미리 만들면 브라우저가 정지 상태로 두고, "재생을 눌렀는데 소리가 안 난다"가 된다.
 */
export function useAudioEngine(
  project: Project,
  registry: ReadonlyMap<string, InstrumentDefinition>,
) {
  const ctxRef = useRef<AudioContext | null>(null);
  const rendererRef = useRef<BufferRenderer | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;

  const [state, setState] = useState<'stopped' | 'playing'>('stopped');
  const [playheadTick, setPlayheadTick] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  /** 어느 DSP 코어가 붙었는지 — 화면에 표시해 두면 wasm 로드 실패를 조용히 넘기지 않는다 */
  const [engineKind, setEngineKind] = useState<'rust' | 'typescript' | null>(null);

  const ensure = useCallback(async (): Promise<BufferRenderer> => {
    if (!ctxRef.current) ctxRef.current = new AudioContext({ latencyHint: 'interactive' });
    const ctx = ctxRef.current;

    if (!rendererRef.current) {
      // Rust DSP 코어를 먼저 붙여 본다. 실패하면 TS 구현으로 떨어진다 —
      // wasm 로드 실패가 "소리가 안 난다"로 이어지면 원인을 찾기 어렵다
      let wasm: WasmVoiceEngine | null = null;
      try {
        const response = await fetch(wasmUrl);
        wasm = await WasmVoiceEngine.create(await response.arrayBuffer(), ctx.sampleRate);
      } catch (err) {
        console.warn('Rust DSP 코어 로드 실패 — TS 구현으로 진행한다', err);
      }
      setEngineKind(wasm ? 'rust' : 'typescript');
      rendererRef.current = new BufferRenderer(ctx, registry, wasm);
    }
    await ctx.resume();
    return rendererRef.current;
  }, [registry]);

  // 편집 결과를 렌더러에 반영한다. 이미 만들어진 뒤에만 — 없으면 만들지 않는다
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

  return { state, playheadTick, error, exporting, engineKind, play, stop, audition, exportWav };
}

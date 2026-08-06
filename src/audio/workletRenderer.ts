/**
 * `AudioRenderer` 의 워크렛 구현 — **하나로 통합된 오디오 경로**.
 *
 * 지금까지 경로가 두 개였다:
 *  - 편집기: 음을 미리 렌더해 `AudioBufferSourceNode` 로 예약 (샘플 정확)
 *  - 튜닝 도구: 워크렛에서 실시간 합성 (파라미터 실시간 반영)
 *
 * 나눠 둔 이유는 **파라미터 스무딩이 없었기 때문**이다 (`sound.md` 6-4).
 * 스무딩 없이 합치면 튜닝 도구의 실시간 변경이 재생 중 클릭으로 새어 나갔다.
 * 스무딩이 들어갔으니 그 이유가 없어졌고, 이제 하나만 남긴다.
 *
 * 워크렛 쪽이 이긴 이유:
 *  - 발음 시각이 여전히 샘플 단위로 정확하다 (워크렛이 블록을 쪼갠다)
 *  - 발음 중 파라미터 변경이 그 음에 반영된다 (미리 렌더로는 불가능했다)
 *  - 긴 음의 렌더 비용이 앞에 몰리지 않는다
 *  - 보이스 관리가 Rust 안에 있어 JS 가 오디오 경로에서 할당하지 않는다
 */

import type {
  AudioRenderer, ExportOptions, ExportResult, InstrumentCapabilities, TransportPosition,
} from './renderer.ts';
import type { EffectSpec, Note, Project, Track, TrackId } from '../model/project.ts';
import { audibleTracks } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { ticksToSeconds } from '../model/time.ts';
import { projectLengthTicks } from '../model/factory.ts';
import { pitchToHz } from '../model/pitch.ts';
import { collectNoteEvents, LookaheadScheduler } from './scheduler.ts';
import type { ScheduledNote } from './scheduler.ts';
import type { InstrumentDefinition, ParamValue } from '../instruments/types.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import type { ResolvedInstrument } from '../instruments/types.ts';
import { curveToParams, WASM_PARAM_ORDER } from './voice/wasmEngine.ts';
import { buildEffectChain } from './effectGraph.ts';
import type { EffectChain } from './effectGraph.ts';
import { renderOfflineWithWorklet } from './offlineExport.ts';

const PUMP_INTERVAL_MS = 25;
const WORKLET_URL = '/ks-worklet.js';
/** 곡 끝 뒤에 남길 여운 — 마지막 음과 리버브 꼬리가 잘리지 않게 */
const EXPORT_TAIL_SEC = 4;

interface TrackRuntime {
  node: AudioWorkletNode;
  gainNode: GainNode;
  panNode: StereoPannerNode;
  effects: EffectChain;
  effectsKey: string;
  instrument: ResolvedInstrument;
  params: Record<string, ParamValue>;
}

export class WorkletRendererError extends Error {}

export class WorkletRenderer implements AudioRenderer {
  private readonly ctx: AudioContext;
  private readonly registry: ReadonlyMap<string, InstrumentDefinition>;
  private readonly wasmBytes: ArrayBuffer;
  private readonly scheduler: LookaheadScheduler;

  private project: Project | null = null;
  private readonly tracks = new Map<TrackId, TrackRuntime>();
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  /** 트랙 워크렛들이 wasm 을 준비했는지. 준비 전에 재생하면 첫 음들이 버려진다 */
  private readonly readyPromises: Promise<void>[] = [];

  private masterGain: GainNode;
  private masterEffects: EffectChain;
  private masterEffectsKey = '';

  private constructor(
    ctx: AudioContext,
    registry: ReadonlyMap<string, InstrumentDefinition>,
    wasmBytes: ArrayBuffer,
  ) {
    this.ctx = ctx;
    this.registry = registry;
    this.wasmBytes = wasmBytes;

    this.masterGain = ctx.createGain();
    this.masterGain.connect(ctx.destination);
    this.masterEffects = buildEffectChain(ctx, []);
    this.masterEffects.output.connect(this.masterGain);

    this.scheduler = new LookaheadScheduler({
      now: () => this.ctx.currentTime,
      scheduleNote: (event, atTime) => this.emit(event, atTime),
    });
  }

  /**
   * 워크렛 모듈을 등록하고 렌더러를 만든다.
   * `wasmBytes` 는 트랙마다 워크렛으로 복사해 넘긴다 — 워크렛 스코프에는 fetch 가 없다.
   */
  static async create(
    ctx: AudioContext,
    registry: ReadonlyMap<string, InstrumentDefinition>,
    wasmBytes: ArrayBuffer,
  ): Promise<WorkletRenderer> {
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
      throw new WorkletRendererError(
        `워크렛 로드 실패 (${WORKLET_URL}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return new WorkletRenderer(ctx, registry, wasmBytes);
  }

  setProject(project: Project): void {
    this.project = project;
    this.masterGain.gain.value = project.master.gain;

    const masterKey = JSON.stringify(project.master.effects);
    if (masterKey !== this.masterEffectsKey) this.rebuildMasterEffects(project.master.effects, masterKey);

    for (const [id, runtime] of this.tracks) {
      if (!project.tracks.some((t) => t.id === id)) {
        this.disposeTrack(runtime);
        this.tracks.delete(id);
      }
    }
    for (const track of project.tracks) this.updateTrack(track);
  }

  updateTrack(track: Track): void {
    const instrument = resolveInstrument(track.instrumentId, this.registry);
    const params = instrumentParams(instrument, track.toneId, track.toneParams);

    let runtime = this.tracks.get(track.id);
    if (!runtime) {
      // 트랙마다 워크렛 노드를 하나 둔다. 보이스 풀이 노드 안에 있으므로
      // 트랙을 섞지 않고 각자의 파라미터로 발음할 수 있다
      const node = new AudioWorkletNode(this.ctx, 'ks-string', { outputChannelCount: [2] });
      this.readyPromises.push(new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new WorkletRendererError('워크렛이 응답하지 않는다')), 10000);
        node.port.onmessage = ({ data }) => {
          if (data?.type === 'ready') { clearTimeout(timer); resolve(); }
        };
      }));
      // 바이트는 노드마다 복사해서 넘긴다 (transfer 하면 두 번째부터 못 쓴다)
      node.port.postMessage({ type: 'load', bytes: this.wasmBytes.slice(0) });

      const gainNode = this.ctx.createGain();
      const panNode = this.ctx.createStereoPanner();
      const effects = buildEffectChain(this.ctx, []);
      node.connect(gainNode).connect(panNode).connect(effects.input);
      effects.output.connect(this.masterEffects.input);

      runtime = { node, gainNode, panNode, effects, effectsKey: '[]', instrument, params };
      this.tracks.set(track.id, runtime);
    }

    runtime.instrument = instrument;
    runtime.params = params;
    runtime.gainNode.gain.value = track.gain;
    runtime.panNode.pan.value = track.pan;

    // **발음 중인 소리에도 파라미터를 반영한다.** 스무딩이 클릭을 막아 준다
    runtime.node.port.postMessage({ type: 'setParams', params: this.encodeParams(params, null) });

    const effectsKey = JSON.stringify(track.effects);
    if (effectsKey !== runtime.effectsKey) {
      runtime.panNode.disconnect();
      runtime.effects.dispose();
      runtime.effects = buildEffectChain(this.ctx, track.effects);
      runtime.effectsKey = effectsKey;
      runtime.panNode.connect(runtime.effects.input);
      runtime.effects.output.connect(this.masterEffects.input);
    }
  }

  /** 모든 트랙 워크렛이 준비될 때까지 기다린다. 재생·시청 전에 호출한다 */
  async whenReady(): Promise<void> {
    await Promise.all(this.readyPromises);
  }

  play(fromTick: Ticks = 0): void {
    if (!this.project) throw new WorkletRendererError('setProject 가 먼저 호출돼야 한다');
    this.stop();
    this.scheduler.start(this.project, fromTick);
    this.pumpTimer = setInterval(() => this.scheduler.pump(), PUMP_INTERVAL_MS);
  }

  stop(): void {
    this.scheduler.stop();
    if (this.pumpTimer !== null) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
    for (const runtime of this.tracks.values()) {
      runtime.node.port.postMessage({ type: 'allOff' });
    }
  }

  seek(tick: Ticks): void {
    const wasPlaying = this.scheduler.isRunning;
    this.stop();
    if (wasPlaying) this.play(tick);
  }

  getPosition(): TransportPosition {
    return {
      tick: this.scheduler.positionTicks(),
      state: this.scheduler.isRunning ? 'playing' : 'stopped',
    };
  }

  auditionNote(trackId: TrackId, note: Note): void {
    const runtime = this.tracks.get(trackId);
    if (!runtime || !this.project) return;
    runtime.node.port.postMessage({
      type: 'noteOn',
      frame: Math.round(this.ctx.currentTime * this.ctx.sampleRate),
      freq: pitchToHz(note.pitch, this.project.tuning),
      velocity: note.velocity,
      params: this.encodeParams(runtime.params, note.pitchCurve),
      gain: 1,
    });
  }

  capabilitiesOf(instrumentId: string): InstrumentCapabilities {
    const instrument = resolveInstrument(instrumentId, this.registry);
    return {
      preserveFormant: instrument.voice === 'sampler',
      physicalParams: instrument.voice === 'waveguide-string' || instrument.voice === 'modal',
      lowestMidi: instrument.range.low,
      highestMidi: instrument.range.high,
    };
  }

  /**
   * 내보내기 — `OfflineAudioContext` + **같은 워크렛**으로 렌더한다.
   * 미리듣기와 같은 코드가 같은 그래프를 만들므로 결과가 일치한다 (`plan.md` 5-2).
   */
  async exportAudio(options: ExportOptions): Promise<ExportResult> {
    if (!this.project) throw new WorkletRendererError('setProject 가 먼저 호출돼야 한다');
    const project = this.project;
    const lengthSec = ticksToSeconds(projectLengthTicks(project), project.tempo) + EXPORT_TAIL_SEC;

    const renderTracks = (tracks: Track[]) =>
      renderOfflineWithWorklet({
        project,
        tracks,
        registry: this.registry,
        wasmBytes: this.wasmBytes,
        sampleRate: options.sampleRate,
        lengthSec,
      });

    if (!options.stems) {
      return {
        sampleRate: options.sampleRate,
        buffers: [{ trackId: null, channels: await renderTracks(audibleTracks(project)) }],
      };
    }

    const buffers: ExportResult['buffers'] = [];
    for (const track of project.tracks) {
      buffers.push({
        trackId: track.id,
        channels: await renderTracks([{ ...track, mute: false, solo: false }]),
      });
    }
    return { sampleRate: options.sampleRate, buffers };
  }

  dispose(): void {
    this.stop();
    for (const runtime of this.tracks.values()) this.disposeTrack(runtime);
    this.tracks.clear();
    this.masterEffects.dispose();
    this.masterGain.disconnect();
  }

  // -------------------------------------------------------------------------

  private encodeParams(
    params: Readonly<Record<string, ParamValue>>,
    curve: Note['pitchCurve'],
  ): number[] {
    const merged = { ...params, ...curveToParams(curve) };
    return WASM_PARAM_ORDER.map((key) => {
      const value = merged[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
  }

  private emit(event: ScheduledNote, atTime: number): void {
    const runtime = this.tracks.get(event.trackId);
    if (!runtime || !this.project) return;
    runtime.node.port.postMessage({
      type: 'noteOn',
      // 프레임 기준으로 넘긴다 — 워크렛이 블록을 쪼개 샘플 단위로 발음한다
      frame: Math.round(atTime * this.ctx.sampleRate),
      freq: pitchToHz(event.note.pitch, this.project.tuning),
      velocity: event.note.velocity,
      params: this.encodeParams(runtime.params, event.pitchCurve),
      gain: 1,
    });
  }

  private rebuildMasterEffects(specs: readonly EffectSpec[], key: string): void {
    const previous = this.masterEffects;
    const next = buildEffectChain(this.ctx, specs);
    next.output.connect(this.masterGain);
    this.masterEffects = next;
    this.masterEffectsKey = key;
    for (const runtime of this.tracks.values()) {
      runtime.effects.output.disconnect();
      runtime.effects.output.connect(next.input);
    }
    previous.dispose();
  }

  private disposeTrack(runtime: TrackRuntime): void {
    runtime.node.port.postMessage({ type: 'allOff' });
    runtime.node.disconnect();
    runtime.gainNode.disconnect();
    runtime.panNode.disconnect();
    runtime.effects.dispose();
  }

  /** 스케줄러가 이 프로젝트에서 무엇을 발음할지 — 디버깅·검증용 */
  previewEvents(fromTick: Ticks, toTick: Ticks): ScheduledNote[] {
    if (!this.project) return [];
    return collectNoteEvents(this.project, fromTick, toTick);
  }
}

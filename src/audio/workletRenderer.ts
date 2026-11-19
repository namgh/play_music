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
import type { EffectSpec, Note, Project, Track, TrackId, BusId } from '../model/project.ts';
import { audibleTracks, vcaScale } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { ticksToSeconds } from '../model/time.ts';
import { projectLengthTicks } from '../model/factory.ts';
import { pitchToHz } from '../model/pitch.ts';
import { collectNoteEvents, LookaheadScheduler } from './scheduler.ts';
import type { ScheduledClick, ScheduledNote } from './scheduler.ts';
import type { InstrumentDefinition, ParamValue } from '../instruments/types.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import type { ResolvedInstrument } from '../instruments/types.ts';
import { scheduleTrackLanes } from './automation.ts';
import { expressionParams } from './articulation.ts';
import {
  curveToParams, noteOffFields, toFreeCurve, variationSeed, WASM_PARAM_ORDER,
} from './voice/wasmEngine.ts';
import { voiceKindIndex } from '../instruments/types.ts';
import { buildEffectChain, updateEffectChain } from './effectGraph.ts';
import type { EffectChain } from './effectGraph.ts';
import { scheduleClick } from './metronome.ts';
import { BusGraph } from './busGraph.ts';
import { markWorkletContext, setTransport } from './fxRuntime.ts';
import { planAudio, scheduleAudioRegions } from './audioRegions.ts';
import { decodeAsset } from './assets.ts';
import { countInSeconds } from './scheduler.ts';
import type { PlayOptions } from './renderer.ts';
import { renderOfflineWithWorklet } from './offlineExport.ts';

const PUMP_INTERVAL_MS = 25;
const WORKLET_URL = '/ks-worklet.js';
/** 곡 끝 뒤에 남길 여운 — 마지막 음과 리버브 꼬리가 잘리지 않게 */
const EXPORT_TAIL_SEC = 4;
/** 미리듣기(건반 클릭·인스펙터) 한 음의 길이 */
const AUDITION_SEC = 0.6;

interface TrackRuntime {
  node: AudioWorkletNode;
  /**
   * 레벨 미터용 탭. **이펙트 뒤, 마스터 합류 직전**이라 이 트랙이 실제로 마스터에
   * 보내는 양을 잰다 — 페이더·팬·이펙트가 다 반영된 값이다.
   *
   * 분석 노드는 신호를 바꾸지 않는다(통과). 소리에 손대지 않고 보기만 하는 것이
   * 중요하다 — 미터를 붙이느라 음질이 달라지면 본말전도다.
   */
  analyser: AnalyserNode;
  voiceKind: number;
  gainNode: GainNode;
  /**
   * 오토메이션 전용 게인 — **이펙트 뒤에 둔다.** 리버브·딜레이가 걸린 트랙에서
   * `gainNode`(이펙트 앞)로 덕킹·게이트를 걸면 리버브에 들어가는 입력만 줄고
   * 이미 만들어진 웨트 꼬리는 그대로 울린다 — 게이트 리버브가 성립하지 않는다.
   * 값은 항상 오토메이션 배율만 담는다(정적 트랙 게인은 `gainNode` 몫)
   */
  automationGain: GainNode;
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
  private masterAnalyser: AnalyserNode;
  /** 미터가 프레임마다 부르므로 버퍼를 재사용한다 — 매번 할당하면 GC 가 튄다 */
  private levelBuffer = new Float32Array(1024);
  private masterEffects: EffectChain;
  private masterEffectsKey = '';
  /** Aux 버스·트랙 출력·센드 (`busGraph.ts`) */
  private busGraph: BusGraph;
  /** 풀어 둔 오디오 에셋 — 재생 순간에 기다리지 않게 미리 (`assets.ts`) */
  private readonly audioBuffers = new Map<string, AudioBuffer>();
  private audioNodes: AudioBufferSourceNode[] = [];
  /** 예약된 메트로놈 오실레이터. 정지할 때 끊어야 한다 */
  private readonly clickNodes = new Set<OscillatorNode>();

  private constructor(
    ctx: AudioContext,
    registry: ReadonlyMap<string, InstrumentDefinition>,
    wasmBytes: ArrayBuffer,
  ) {
    this.ctx = ctx;
    this.registry = registry;
    this.wasmBytes = wasmBytes;

    this.masterGain = ctx.createGain();
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.masterGain.connect(this.masterAnalyser).connect(ctx.destination);
    this.masterEffects = buildEffectChain(ctx, []);
    this.masterEffects.output.connect(this.masterGain);
    this.busGraph = new BusGraph(ctx, this.masterEffects.input);

    this.scheduler = new LookaheadScheduler({
      now: () => this.ctx.currentTime,
      scheduleNote: (event, atTime, durationSec) => this.emit(event, atTime, durationSec),
      // 악기 정의를 아는 것은 렌더러다 — 스케줄러는 층이 달라 몰라야 한다
      // (`plan.md` 5-2). 레가토는 앞 음을 알아야 하므로 스케줄러가 계산한다
      legatoMsFor: (trackId) => Number(this.tracks.get(trackId)?.params.legatoMs) || 0,
      scheduleClick: (click, atTime) => this.emitClick(click, atTime),
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
    markWorkletContext(ctx);
    return new WorkletRenderer(ctx, registry, wasmBytes);
  }

  setMetronome(on: boolean): void {
    this.scheduler.setMetronome(on);
  }

  setProject(project: Project): void {
    this.project = project;
    // 재생 중 루프 구간·템포 변경이 즉시 반영되게 한다. 예약 진행도는 건드리지 않으므로
    // 이미 예약된 음은 그대로 울린다
    this.scheduler.setProject(project);
    this.masterGain.gain.value = project.master.gain;
    setTransport(this.ctx, { bpm: project.tempo.bpm });

    const masterKey = JSON.stringify(project.master.effects);
    if (masterKey !== this.masterEffectsKey) this.rebuildMasterEffects(project.master.effects, masterKey);

    this.busGraph.syncBuses(project);
    this.preloadAudio(project);
    for (const [id, runtime] of this.tracks) {
      if (!project.tracks.some((t) => t.id === id)) {
        this.disposeTrack(runtime);
        this.busGraph.removeTrack(id);
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
      // 몸통·공명현 구성은 개수가 가변이라 파라미터가 아니라 **버퍼**로 간다.
      // 트랙마다 한 번만 보내면 된다 — 음마다 바뀌는 값이 아니다
      node.port.postMessage({
        type: 'voicing',
        bodyModes: instrument.bodyModes,
        sympatheticSemitones: instrument.sympatheticSemitones,
      });

      const gainNode = this.ctx.createGain();
      const automationGain = this.ctx.createGain();
      const panNode = this.ctx.createStereoPanner();
      const effects = buildEffectChain(this.ctx, []);
      // **분석 노드를 고정점으로 둔다.** 이펙트는 바뀌면 다시 연결되는데(아래),
      // 그때마다 탭을 옮기면 한 번 놓치는 순간이 생긴다. 탭은 마스터에 영구히
      // 붙여 두고 이펙트가 여기로 들어오게 한다
      const analyser = this.ctx.createAnalyser();
      // 미터는 파형만 보면 되므로 크게 잡을 이유가 없다. 1024 = 48kHz 에서 21ms
      analyser.fftSize = 1024;
      // 분석 노드 뒤는 버스 그래프가 잇는다 (마스터 또는 버스, 그리고 센드)
      node.connect(gainNode).connect(panNode).connect(effects.input);
      effects.output.connect(automationGain).connect(analyser);

      runtime = {
        node, gainNode, automationGain, panNode, effects, effectsKey: '[]', instrument, params, analyser,
        voiceKind: voiceKindIndex(instrument.voice),
      };
      this.tracks.set(track.id, runtime);
    }

    runtime.instrument = instrument;
    runtime.params = params;
    runtime.voiceKind = voiceKindIndex(instrument.voice);
    runtime.gainNode.gain.value = track.gain * instrument.baseLevel * (this.project ? vcaScale(this.project, track) : 1);
    runtime.panNode.pan.value = track.pan;

    // **발음 중인 소리에도 파라미터를 반영한다.** 스무딩이 클릭을 막아 준다
    runtime.node.port.postMessage({
      type: 'setParams',
      params: this.encodeParams(params, null, runtime.voiceKind),
    });

    const effectsKey = JSON.stringify(track.effects);
    if (effectsKey !== runtime.effectsKey) {
      // 바뀐 칸만 새로 — 입력 노드가 그대로라 팬 → 입력 연결은 살아 있다
      runtime.effects = updateEffectChain(this.ctx, runtime.effects, track.effects);
      runtime.effectsKey = effectsKey;
      runtime.effects.output.connect(runtime.automationGain);
    }
    // 이펙트를 다시 지은 **뒤에** 잇는다 — 체인 지연이 바뀌었으면 지연 보정이 그 값을 써야 한다
    this.busGraph.routeTrack(track, runtime.analyser, runtime.effects.latency ?? 0);
  }

  /** 모든 트랙 워크렛이 준비될 때까지 기다린다. 재생·시청 전에 호출한다 */
  async whenReady(): Promise<void> {
    await Promise.all(this.readyPromises);
  }

  play(fromTick: Ticks = 0, options: PlayOptions = {}): void {
    if (!this.project) throw new WorkletRendererError('setProject 가 먼저 호출돼야 한다');
    this.stop();
    // 카운트인이 있으면 곡(과 오토메이션)이 그만큼 뒤에서 시작한다
    const preRoll = countInSeconds(this.project, fromTick, options.countInBars ?? 0);
    const anchorTime = this.ctx.currentTime + preRoll;
    // 박자 이펙트: 곡 0 초가 놓인 프레임 (템포 변화는 시작 템포로 근사)
    setTransport(this.ctx, {
      anchor: Math.round((anchorTime - ticksToSeconds(fromTick, this.project.tempo)) * this.ctx.sampleRate),
      bpm: this.project.tempo.bpm,
    });
    this.scheduler.start(this.project, fromTick, preRoll);
    this.pumpTimer = setInterval(() => this.scheduler.pump(), PUMP_INTERVAL_MS);
    this.scheduleTrackAutomation(fromTick, anchorTime);
    this.audioNodes = scheduleAudioRegions(this.ctx, planAudio(this.project, fromTick), this.audioBuffers, anchorTime,
      (trackId) => this.tracks.get(trackId)?.panNode ?? null);
  }

  private preloadAudio(project: Project): void {
    for (const t of project.tracks) for (const c of t.clips) {
      const id = c.audio?.assetId;
      if (!id || this.audioBuffers.has(id)) continue;
      void decodeAsset(this.ctx, id).then((b) => { if (b) this.audioBuffers.set(id, b); });
    }
  }

  /**
   * 볼륨 오토메이션을 재생 헤드 위치부터 오디오 클럭에 예약한다.
   * **곡 전체를 이 시점에 한 번에 예약한다** — 음과 달리 룩어헤드가 필요 없다.
   * 값-시간 곡선은 재생을 시작하는 순간 이미 전부 정해져 있기 때문이다.
   */
  private scheduleTrackAutomation(anchorTick: Ticks, anchorTimeSec: number): void {
    if (!this.project) return;
    for (const track of this.project.tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime || track.automation.length === 0) continue;
      scheduleTrackLanes(track, { ...runtime, bindings: runtime.effects.bindings }, this.project.tempo, anchorTick, anchorTimeSec);
    }
  }

  /**
   * 트랙(또는 마스터)의 지금 레벨. **프레임마다 불린다.**
   *
   * 시간 파형으로 잰다 — 진짜 진폭이다. 주파수 눈금은 dB 매핑과 평활 상수가 끼어
   * 있어서 "얼마나 큰가"를 묻는 데는 맞지 않는다 (실제로 그걸로 잘못 읽은 적이 있다).
   *
   * `peak >= 1` 이면 그 지점에서 이미 넘친 것이다. 마스터에서 넘치면 파일이 잘린다.
   */
  readEffectMeters(owner: string | null, index: number): Float32Array | null {
    const chain = owner === null
      ? this.masterEffects
      : owner.startsWith('bus_')
        ? this.busGraph.busEffects(owner as unknown as BusId)
        : this.tracks.get(owner as TrackId)?.effects;
    return chain?.meters?.get(index) ?? null;
  }

  compensationSamples(): number {
    return this.busGraph.maxLatency();
  }

  readLevel(trackId: TrackId | null): { peak: number; rms: number } | null {
    // 버스 id 도 받는다 — 믹서의 Aux 스트립 미터
    const analyser = trackId === null
      ? this.masterAnalyser
      : (trackId as string).startsWith('bus_')
        ? this.busGraph.busAnalyser(trackId as unknown as BusId)
        : this.tracks.get(trackId)?.analyser;
    if (!analyser) return null;
    const buffer = this.levelBuffer.length === analyser.fftSize
      ? this.levelBuffer
      : (this.levelBuffer = new Float32Array(analyser.fftSize));
    analyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    let sum = 0;
    for (const v of buffer) {
      const m = v < 0 ? -v : v;
      if (m > peak) peak = m;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / buffer.length) };
  }

  stop(): void {
    this.scheduler.stop();
    this.stopClicks();
    for (const n of this.audioNodes) { try { n.stop(); } catch { /* 이미 끝남 */ } }
    this.audioNodes = [];
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
      params: this.encodeParams(
        runtime.params, note.pitchCurve, runtime.voiceKind, note.expression, runtime.instrument.voice,
      ),
      gain: 1,
      curve: toFreeCurve(note.pitchCurve, AUDITION_SEC),
      seed: variationSeed(note.id),
      // 미리듣기에도 길이를 준다. 없으면 **신스가 영원히 울린다** —
      // ADSR 이 Sustain 단계에서 멈춰 있고 거기서 나올 길이 노트오프뿐이다
      ...noteOffFields(runtime.params, AUDITION_SEC, this.ctx.sampleRate),
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
    voiceKind = 0,
    expression?: Note['expression'],
    voice = '',
  ): number[] {
    const merged: Record<string, number | string> = {
      ...params, ...curveToParams(curve), ...expressionParams(voice, expression, params), voiceKind,
    };
    return WASM_PARAM_ORDER.map((key) => {
      const value = merged[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
  }

  private emit(event: ScheduledNote, atTime: number, durationSec: number): void {
    const runtime = this.tracks.get(event.trackId);
    if (!runtime || !this.project) return;
    runtime.node.port.postMessage({
      type: 'noteOn',
      // 프레임 기준으로 넘긴다 — 워크렛이 블록을 쪼개 샘플 단위로 발음한다
      frame: Math.round(atTime * this.ctx.sampleRate),
      freq: pitchToHz(event.note.pitch, this.project.tuning),
      velocity: event.note.velocity,
      params: this.encodeParams(
        runtime.params, event.pitchCurve, runtime.voiceKind, event.note.expression, runtime.instrument.voice,
      ),
      gain: 1,
      // 사용자가 그린 자유곡선. 있으면 글라이드·비브라토를 **대신한다**
      curve: toFreeCurve(event.pitchCurve, durationSec),
      // 노트 id 에서 유도한다 — 재생과 내보내기가 같은 변주를 써야 한다
      seed: variationSeed(event.noteId),
      ...noteOffFields(runtime.params, durationSec, this.ctx.sampleRate),
    });
  }

  private emitClick(click: ScheduledClick, atTime: number): void {
    const osc = scheduleClick(this.ctx, this.ctx.destination, click, atTime);
    this.clickNodes.add(osc);
    osc.addEventListener('ended', () => this.clickNodes.delete(osc));
  }

  /** 예약해 둔 클릭을 즉시 끊는다. 안 하면 정지 뒤에도 룩어헤드만큼 딸깍거린다 */
  private stopClicks(): void {
    for (const osc of this.clickNodes) {
      try {
        osc.stop();
      } catch {
        /* 이미 끝났다 */
      }
    }
    this.clickNodes.clear();
  }

  private rebuildMasterEffects(specs: readonly EffectSpec[], key: string): void {
    const next = updateEffectChain(this.ctx, this.masterEffects, specs);
    next.output.connect(this.masterGain);
    this.masterEffects = next;
    this.masterEffectsKey = key;
    // 예전에는 트랙 이펙트 출력을 마스터에 **바로** 다시 이어서, 마스터 이펙트를
    // 바꾸는 순간 오토메이션 게인과 미터를 건너뛰었다 (2026-11-17 발견).
    // 이제 트랙 끝(분석 노드)에서 나가는 연결은 버스 그래프 하나가 관리한다
    this.busGraph.setMaster(next.input);
  }

  private disposeTrack(runtime: TrackRuntime): void {
    runtime.node.port.postMessage({ type: 'allOff' });
    runtime.node.disconnect();
    runtime.gainNode.disconnect();
    runtime.automationGain.disconnect();
    runtime.panNode.disconnect();
    runtime.effects.dispose();
  }

  /** 스케줄러가 이 프로젝트에서 무엇을 발음할지 — 디버깅·검증용 */
  previewEvents(fromTick: Ticks, toTick: Ticks): ScheduledNote[] {
    if (!this.project) return [];
    return collectNoteEvents(this.project, fromTick, toTick);
  }
}

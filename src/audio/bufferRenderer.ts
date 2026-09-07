/**
 * `AudioRenderer` 의 첫 구현. **임시다 — M1 에서 Rust→WASM 워크렛으로 교체된다.**
 *
 * 방식: 음마다 PCM 을 미리 렌더해 `AudioBufferSourceNode` 로 정확한 시각에 예약한다.
 *
 * 왜 워크렛이 아닌가:
 *  - 뜯는 줄은 노트온 시점에 결과가 완전히 결정되는 **원샷**이다. 음정 곡선도
 *    노트온 때 이미 알고 있으므로 미리 렌더해도 표현력을 잃지 않는다.
 *  - 발음 시각은 Web Audio 자체 클럭으로 예약되므로 타이밍은 워크렛과 동일하게 정확하다.
 *  - 워크렛에 DSP 를 넣으면 지금 번들링을 풀어야 하는데, M1 에서 WASM 로딩 경로로
 *    다시 배선하게 된다. 두 번 하지 않는다.
 *
 * 이 방식의 한계 (M1 에서 해소):
 *  - **발음 중에 파라미터를 바꿔도 그 음에는 반영되지 않는다.** 다음 음부터 적용된다.
 *  - 아주 긴 음은 미리 렌더하는 비용이 앞에 몰린다.
 *
 * 이 파일은 Web Audio 를 아는 유일한 곳이어야 한다 (`plan.md` 5-2).
 */

import type {
  AudioRenderer, ExportOptions, ExportResult, InstrumentCapabilities, TransportPosition,
} from './renderer.ts';
import type { EffectSpec, Note, PitchCurve, Project, Track, TrackId } from '../model/project.ts';
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
import { renderNoteToPcm } from './offlineRender.ts';
import type { WasmVoiceEngine } from './voice/wasmEngine.ts';
import { curveToParams } from './voice/wasmEngine.ts';
import { voiceKindIndex } from '../instruments/types.ts';
import type { VoiceType } from '../instruments/types.ts';
import { buildEffectChain } from './effectGraph.ts';
import { scheduleClick } from './metronome.ts';
import type { EffectChain } from './effectGraph.ts';
import { scheduleGainAutomation, volumeLane } from './automation.ts';
import { expressionParams } from './articulation.ts';

/** 타이머 주기. 룩어헤드보다 충분히 짧아야 한다 */
const PUMP_INTERVAL_MS = 25;
/** 한 음을 미리 렌더하는 최대 길이 */
const MAX_NOTE_SEC = 12;
/** 렌더 캐시 상한 (음 개수) */
const CACHE_LIMIT = 512;
/** Rust 코어의 블록 상한과 맞춘다 */
const WASM_BLOCK = 2048;
/** 내보낼 때 곡 끝 뒤에 남길 여운 — 마지막 음과 리버브 꼬리가 잘리지 않게 */
const EXPORT_TAIL_SEC = 4;

interface TrackRuntime {
  /**
   * 이 트랙 전용 DSP 코어.
   *
   * **트랙마다 따로 둔다.** 앰프 체인이 엔진 인스턴스당 하나뿐이라 공유하면
   * 설정이 섞인다 — 퍼즈 트랙과 클린 트랙이 동시에 울리면 나중에 발음한 쪽
   * 설정이 둘 다에 걸린다. 워크렛 경로가 트랙마다 노드를 따로 두는 것과 같다.
   */
  wasm: WasmVoiceEngine | null;
  /** 보이스가 붙는 입구 */
  gainNode: GainNode;
  /** 오토메이션 전용 게인 — 이펙트 뒤에 둔다 (`workletRenderer.ts` 와 같은 이유) */
  automationGain: GainNode;
  panNode: StereoPannerNode;
  effects: EffectChain;
  /** 이펙트 구성이 바뀔 때만 다시 만들기 위한 서명 */
  effectsKey: string;
  instrument: ResolvedInstrument;
  params: Record<string, ParamValue>;
  paramsKey: string;
}

export class BufferRenderer implements AudioRenderer {
  private readonly ctx: BaseAudioContext & { destination: AudioDestinationNode };
  private readonly registry: ReadonlyMap<string, InstrumentDefinition>;
  private readonly scheduler: LookaheadScheduler;

  private project: Project | null = null;
  private readonly tracks = new Map<TrackId, TrackRuntime>();
  private readonly cache = new Map<string, AudioBuffer>();
  private readonly playing = new Set<AudioBufferSourceNode>();

  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private masterGain: GainNode;
  private masterEffects: EffectChain | null = null;
  private masterEffectsKey = '';
  /** 예약된 메트로놈 오실레이터. 정지할 때 끊어야 한다 */
  private readonly clickNodes = new Set<OscillatorNode>();

  /**
   * Rust DSP 코어. 있으면 이걸 쓴다 (`sound.md` M1).
   * 없으면 TS 구현으로 떨어진다 — wasm 로드 실패가 무음이 되지 않게.
   */
  private readonly wasm: WasmVoiceEngine | null;

  /**
   * 다른 샘플레이트로 코어를 새로 만드는 함수.
   *
   * 왜 필요한가: wasm 엔진은 `init(sampleRate)` 로 고정된다. 재생용 엔진은
   * `ctx.sampleRate`(장치에 따라 44.1k 일 수 있다)로 만들어졌는데, 내보내기는
   * 48kHz 를 요구한다 (`sound.md` 6-6). 같은 인스턴스로 렌더하면 **음정이 비율만큼
   * 틀린 파일이 조용히 나온다.** 그래서 내보낼 때 그 레이트로 하나 더 만든다.
   */
  private readonly wasmFactory: ((sampleRate: number) => Promise<WasmVoiceEngine>) | null;

  constructor(
    ctx: AudioContext,
    registry: ReadonlyMap<string, InstrumentDefinition>,
    wasm: WasmVoiceEngine | null = null,
    wasmFactory: ((sampleRate: number) => Promise<WasmVoiceEngine>) | null = null,
  ) {
    this.ctx = ctx;
    this.registry = registry;
    this.wasm = wasm;
    this.wasmFactory = wasmFactory;
    this.masterGain = ctx.createGain();
    this.masterGain.connect(ctx.destination);
    this.rebuildMasterEffects([], '');

    this.scheduler = new LookaheadScheduler({
      now: () => this.ctx.currentTime,
      scheduleNote: (event, atTime, durationSec) => this.emit(event, atTime, durationSec),
      // 악기 정의를 아는 것은 렌더러다 — 스케줄러는 층이 달라 몰라야 한다
      // (`plan.md` 5-2). 레가토는 앞 음을 알아야 하므로 스케줄러가 계산한다
      legatoMsFor: (trackId) => Number(this.tracks.get(trackId)?.params.legatoMs) || 0,
      scheduleClick: (click, atTime) => {
        const osc = scheduleClick(this.ctx, this.ctx.destination, click, atTime);
        this.clickNodes.add(osc);
        osc.addEventListener('ended', () => this.clickNodes.delete(osc));
      },
    });
  }

  setProject(project: Project): void {
    this.project = project;
    this.masterGain.gain.value = project.master.gain;

    const masterKey = JSON.stringify(project.master.effects);
    if (masterKey !== this.masterEffectsKey) {
      this.rebuildMasterEffects(project.master.effects, masterKey);
    }

    // 없어진 트랙 정리
    for (const [id, runtime] of this.tracks) {
      if (!project.tracks.some((t) => t.id === id)) {
        runtime.gainNode.disconnect();
        runtime.automationGain.disconnect();
        runtime.panNode.disconnect();
        runtime.effects.dispose();
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
      const gainNode = this.ctx.createGain();
      const automationGain = this.ctx.createGain();
      const panNode = this.ctx.createStereoPanner();
      const effects = buildEffectChain(this.ctx, []);
      gainNode.connect(panNode).connect(effects.input);
      effects.output.connect(automationGain).connect(this.masterEffects!.input);
      runtime = {
        wasm: null, gainNode, automationGain, panNode, effects, effectsKey: '[]',
        instrument, params, paramsKey: '',
      };
      // 트랙 전용 엔진을 만든다. 팩토리가 없으면 공유 엔진으로 떨어지는데,
      // 그때는 앰프가 섞일 수 있으므로 트랙이 하나일 때만 정확하다
      if (this.wasmFactory) {
        void this.wasmFactory(this.ctx.sampleRate).then((engine) => {
          const current = this.tracks.get(track.id);
          if (current) current.wasm = engine;
        });
      }
      this.tracks.set(track.id, runtime);
    }
    runtime.instrument = instrument;
    runtime.params = params;
    runtime.paramsKey = `${instrument.id}|${JSON.stringify(params)}`;
    // 음소거·솔로는 스케줄러가 걸러내므로 여기서는 레벨과 팬만 본다
    runtime.gainNode.gain.value = track.gain * instrument.baseLevel;
    runtime.panNode.pan.value = track.pan;

    // 이펙트는 구성이 바뀔 때만 다시 만든다. 매번 만들면 리버브 IR 을 계속 재합성한다
    const effectsKey = JSON.stringify(track.effects);
    if (effectsKey !== runtime.effectsKey) {
      runtime.panNode.disconnect();
      runtime.effects.dispose();
      runtime.effects = buildEffectChain(this.ctx, track.effects);
      runtime.effectsKey = effectsKey;
      runtime.panNode.connect(runtime.effects.input);
      runtime.effects.output.connect(runtime.automationGain);
    }
  }

  private rebuildMasterEffects(specs: readonly EffectSpec[], key: string): void {
    const previous = this.masterEffects;
    const next = buildEffectChain(this.ctx, specs);
    next.output.connect(this.masterGain);
    this.masterEffects = next;
    this.masterEffectsKey = key;

    // 트랙들을 새 마스터 체인으로 옮긴다
    for (const runtime of this.tracks.values()) {
      runtime.automationGain.disconnect();
      runtime.automationGain.connect(next.input);
    }
    previous?.dispose();
  }

  /**
   * 메트로놈. 이 경로는 워크렛을 못 쓰는 환경의 **대체**이고, 루프·메트로놈은
   * 스케줄러가 담당하므로 여기서도 그대로 동작한다. 소리만 여기서 만든다.
   */
  setMetronome(on: boolean): void {
    this.scheduler.setMetronome(on);
  }

  play(fromTick: Ticks = 0): void {
    if (!this.project) throw new Error('setProject 가 먼저 호출돼야 한다');
    this.stop();
    const anchorTime = this.ctx.currentTime;
    this.scheduler.setProject(this.project);
    this.scheduler.start(this.project, fromTick);
    this.pumpTimer = setInterval(() => this.scheduler.pump(), PUMP_INTERVAL_MS);
    for (const track of this.project.tracks) {
      const runtime = this.tracks.get(track.id);
      const lane = volumeLane(track);
      if (!runtime || !lane) continue;
      // 이펙트 뒤 게인이라 배율은 1 — 정적 트랙 게인은 이미 `gainNode` 가 담당한다
      scheduleGainAutomation(
        runtime.automationGain.gain, lane.points, this.project.tempo, 1, fromTick, anchorTime,
      );
    }
  }

  stop(): void {
    this.scheduler.stop();
    if (this.pumpTimer !== null) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
    for (const source of this.playing) {
      try { source.stop(); } catch { /* 이미 끝난 소스 */ }
    }
    this.playing.clear();
    for (const osc of this.clickNodes) {
      try { osc.stop(); } catch { /* 이미 끝났다 */ }
    }
    this.clickNodes.clear();
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
    const freqHz = pitchToHz(note.pitch, this.project.tuning);
    this.startBuffer(runtime, freqHz, note.velocity, this.ctx.currentTime, MAX_NOTE_SEC, note.pitchCurve, note.expression);
  }

  capabilitiesOf(instrumentId: string): InstrumentCapabilities {
    const instrument = resolveInstrument(instrumentId, this.registry);
    return {
      // 샘플 리샘플 보이스만 포먼트 보존이 의미 있다 (`plan.md` 5-4)
      preserveFormant: instrument.voice === 'sampler',
      physicalParams: instrument.voice === 'waveguide-string' || instrument.voice === 'modal',
      lowestMidi: instrument.range.low,
      highestMidi: instrument.range.high,
    };
  }

  /**
   * 내보내기 — `OfflineAudioContext` 로 클라이언트에서 렌더한다 (`plan.md` 5-2).
   *
   * **미리듣기와 같은 코드로 같은 그래프를 만든다.** 보이스는 같은 Rust 코어로 미리
   * 렌더한 버퍼를 쓰고, 이펙트는 `buildEffectChain` 이 실시간과 동일하게 배선한다.
   * 순수 JS 경로(`renderProjectOffline`)로 내보내면 이펙트가 빠진 파일이 나온다.
   */
  async exportAudio(options: ExportOptions): Promise<ExportResult> {
    if (!this.project) throw new Error('setProject 가 먼저 호출돼야 한다');
    const project = this.project;
    const wasm = await this.wasmForRate(options.sampleRate);

    const lengthSec =
      ticksToSeconds(projectLengthTicks(project), project.tempo) + EXPORT_TAIL_SEC;

    const renderOne = async (tracks: Track[]): Promise<Float32Array[]> => {
      const offline = new OfflineAudioContext({
        numberOfChannels: 2,
        length: Math.max(1, Math.ceil(lengthSec * options.sampleRate)),
        sampleRate: options.sampleRate,
      });

      const master = buildEffectChain(offline, project.master.effects);
      const masterGain = offline.createGain();
      masterGain.gain.value = project.master.gain;
      master.output.connect(masterGain).connect(offline.destination);

      const subset: Project = { ...project, tracks };
      for (const track of tracks) {
        const instrument = resolveInstrument(track.instrumentId, this.registry);
        const params = instrumentParams(instrument, track.toneId, track.toneParams);

        const gain = offline.createGain();
        gain.gain.value = track.gain;
        const pan = offline.createStereoPanner();
        pan.pan.value = track.pan;
        const effects = buildEffectChain(offline, track.effects);
        gain.connect(pan).connect(effects.input);
        effects.output.connect(master.input);

        // 이 트랙의 음을 시각대로 예약한다
        for (const event of collectNoteEvents(subset, 0, projectLengthTicks(project))) {
          if (event.trackId !== track.id) continue;
          const freqHz = pitchToHz(event.note.pitch, project.tuning);
          const pcm = this.renderNoteWith(
            wasm, instrument.voice, params, freqHz, event.note.velocity,
            event.pitchCurve, options.sampleRate, event.note.expression,
          );
          const buffer = offline.createBuffer(1, Math.max(1, pcm.length), options.sampleRate);
          buffer.getChannelData(0).set(pcm);
          const source = offline.createBufferSource();
          source.buffer = buffer;
          source.connect(gain);
          source.start(ticksToSeconds(event.startTick, project.tempo));
        }
      }

      const rendered = await offline.startRendering();
      return Array.from({ length: rendered.numberOfChannels }, (_, ch) =>
        rendered.getChannelData(ch));
    };

    if (!options.stems) {
      // 음소거·솔로를 반영한 트랙만 (스케줄러와 같은 규칙)
      return {
        sampleRate: options.sampleRate,
        buffers: [{ trackId: null, channels: await renderOne(audibleTracks(project)) }],
      };
    }

    const buffers: ExportResult['buffers'] = [];
    for (const track of project.tracks) {
      const channels = await renderOne([{ ...track, mute: false, solo: false }]);
      buffers.push({ trackId: track.id, channels });
    }
    return { sampleRate: options.sampleRate, buffers };
  }

  dispose(): void {
    this.stop();
    for (const runtime of this.tracks.values()) {
      runtime.gainNode.disconnect();
      runtime.automationGain.disconnect();
      runtime.panNode.disconnect();
      runtime.effects.dispose();
    }
    this.tracks.clear();
    this.cache.clear();
    this.masterEffects?.dispose();
    this.masterGain.disconnect();
  }

  // -------------------------------------------------------------------------

  /**
   * 요청한 샘플레이트로 동작하는 코어를 돌려준다.
   * 레이트가 다르고 새로 만들 방법도 없으면 **조용히 틀린 소리를 내는 대신 실패한다.**
   */
  private async wasmForRate(sampleRate: number): Promise<WasmVoiceEngine | null> {
    if (!this.wasm) return null;
    if (Math.abs(this.wasm.sampleRate - sampleRate) < 0.5) return this.wasm;
    if (!this.wasmFactory) {
      throw new Error(
        `내보내기 샘플레이트(${sampleRate}Hz)가 코어(${this.wasm.sampleRate}Hz)와 다르고 ` +
          '새 코어를 만들 방법이 없다 — 음정이 틀린 파일이 나오므로 중단한다',
      );
    }
    return this.wasmFactory(sampleRate);
  }

  private emit(event: ScheduledNote, atTime: number, durationSec: number): void {
    const runtime = this.tracks.get(event.trackId);
    if (!runtime || !this.project) return;
    const freqHz = pitchToHz(event.note.pitch, this.project.tuning);
    // 늦게 도착한 예약은 드롭하지 않고 즉시 발음한다 — 드롭하면 음이 사라진다
    const when = Math.max(atTime, this.ctx.currentTime);
    this.startBuffer(runtime, freqHz, event.note.velocity, when, durationSec, event.pitchCurve, event.note.expression);
  }

  private startBuffer(
    runtime: TrackRuntime,
    freqHz: number,
    velocity: number,
    when: number,
    _durationSec: number,
    curve: PitchCurve | null = null,
    expression: Note['expression'] = null,
  ): void {
    const buffer = this.buffered(runtime, freqHz, velocity, curve, expression);
    const source = this.ctx.createBufferSource() as AudioBufferSourceNode;
    source.buffer = buffer;
    source.connect(runtime.gainNode);
    source.onended = () => {
      source.disconnect();
      this.playing.delete(source);
    };
    this.playing.add(source);
    source.start(when);
    // 줄은 뜯은 뒤 자연 감쇠하므로 노트 길이로 잘라내지 않는다.
    // 잘라내면 스타카토가 아니라 "뚝 끊김"이 된다 — 어떻게 끊을지는 별도 결정 사항
  }

  /** Rust 코어가 있으면 그걸로, 없으면 TS 구현으로 음 하나를 렌더한다 */
  private renderNote(
    runtime: TrackRuntime,
    freqHz: number,
    velocity: number,
    curve: PitchCurve | null,
    expression: Note['expression'] = null,
  ): Float32Array {
    return this.renderNoteWith(
      runtime.wasm ?? this.wasm,
      runtime.instrument.voice, runtime.params as Record<string, number | string>,
      freqHz, velocity, curve, this.ctx.sampleRate, expression,
    );
  }

  /** 어느 코어·샘플레이트로든 음 하나를 렌더한다 (내보내기가 다른 레이트를 쓴다) */
  private renderNoteWith(
    wasm: WasmVoiceEngine | null,
    voiceType: string,
    params: Record<string, number | string>,
    freqHz: number,
    velocity: number,
    curve: PitchCurve | null,
    sampleRate: number,
    expression: Note['expression'] = null,
  ): Float32Array {
    if (wasm) {
      wasm.allOff();
      wasm.noteOn(freqHz, velocity, {
        ...params,
        ...curveToParams(curve),
        ...expressionParams(voiceType, expression, params),
        voiceKind: voiceKindIndex(voiceType as VoiceType),
      });
      const total = Math.ceil(MAX_NOTE_SEC * sampleRate);
      const out = new Float32Array(total);
      const scratch = new Float32Array(WASM_BLOCK);
      let written = 0;
      while (written < total) {
        const frames = Math.min(WASM_BLOCK, total - written);
        scratch.fill(0);
        const active = wasm.process(scratch, frames);
        out.set(scratch.subarray(0, frames), written);
        written += frames;
        if (active === 0) break; // 보이스가 조용해졌으면 거기서 끝
      }
      return written === total ? out : out.slice(0, written);
    }

    return renderNoteToPcm({
      voiceType,
      params,
      freqHz,
      velocity,
      sampleRate,
      maxSec: MAX_NOTE_SEC,
    });
  }

  private buffered(
    runtime: TrackRuntime,
    freqHz: number,
    velocity: number,
    curve: PitchCurve | null,
    expression: Note['expression'] = null,
  ): AudioBuffer {
    // 세기는 8단계로 뭉쳐 캐시 적중률을 올린다. 귀로 구분되지 않는 차이다
    const vq = Math.round(velocity * 8) / 8;
    // **곡선이 키에 들어가야 한다.** 없으면 글라이드가 다른 음이 같은 버퍼를 공유한다
    const curveKey = curve ? JSON.stringify(curveToParams(curve)) : '';
    // 뮤트도 마찬가지다 — 안 넣으면 같은 음정·세기의 뮤트 음과 안 뮤트 음이 버퍼를 공유한다
    const muteKey = expression?.mute ? expression.mute.toFixed(3) : '';
    const key = `${runtime.paramsKey}|${freqHz.toFixed(4)}|${vq}|${curveKey}|${muteKey}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const pcm = this.renderNote(runtime, freqHz, vq, curve, expression);

    const buffer = this.ctx.createBuffer(1, Math.max(1, pcm.length), this.ctx.sampleRate);
    // copyToChannel 대신 set — 버퍼 타입 제약을 피하고 복사도 한 번 줄인다
    buffer.getChannelData(0).set(pcm);

    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, buffer);
    return buffer;
  }
}

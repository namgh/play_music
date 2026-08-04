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
import type { Note, Project, Track, TrackId } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { pitchToHz } from '../model/pitch.ts';
import { LookaheadScheduler } from './scheduler.ts';
import type { ScheduledNote } from './scheduler.ts';
import type { InstrumentDefinition, ParamValue } from '../instruments/types.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import type { ResolvedInstrument } from '../instruments/types.ts';
import { renderNoteToPcm, renderProjectOffline } from './offlineRender.ts';
import type { WasmVoiceEngine } from './voice/wasmEngine.ts';

/** 타이머 주기. 룩어헤드보다 충분히 짧아야 한다 */
const PUMP_INTERVAL_MS = 25;
/** 한 음을 미리 렌더하는 최대 길이 */
const MAX_NOTE_SEC = 12;
/** 렌더 캐시 상한 (음 개수) */
const CACHE_LIMIT = 512;
/** Rust 코어의 블록 상한과 맞춘다 */
const WASM_BLOCK = 2048;

interface TrackRuntime {
  gainNode: GainNode;
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

  /**
   * Rust DSP 코어. 있으면 이걸 쓴다 (`sound.md` M1).
   * 없으면 TS 구현으로 떨어진다 — wasm 로드 실패가 무음이 되지 않게.
   */
  private readonly wasm: WasmVoiceEngine | null;

  constructor(
    ctx: AudioContext,
    registry: ReadonlyMap<string, InstrumentDefinition>,
    wasm: WasmVoiceEngine | null = null,
  ) {
    this.ctx = ctx;
    this.registry = registry;
    this.wasm = wasm;
    this.masterGain = ctx.createGain();
    this.masterGain.connect(ctx.destination);

    this.scheduler = new LookaheadScheduler({
      now: () => this.ctx.currentTime,
      scheduleNote: (event, atTime, durationSec) => this.emit(event, atTime, durationSec),
    });
  }

  setProject(project: Project): void {
    this.project = project;
    this.masterGain.gain.value = project.master.gain;

    // 없어진 트랙 정리
    for (const [id, runtime] of this.tracks) {
      if (!project.tracks.some((t) => t.id === id)) {
        runtime.gainNode.disconnect();
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
      gainNode.connect(this.masterGain);
      runtime = { gainNode, instrument, params, paramsKey: '' };
      this.tracks.set(track.id, runtime);
    }
    runtime.instrument = instrument;
    runtime.params = params;
    runtime.paramsKey = `${instrument.id}|${JSON.stringify(params)}`;
    // 음소거·솔로는 스케줄러가 걸러내므로 여기서는 레벨만 본다
    runtime.gainNode.gain.value = track.gain;
  }

  play(fromTick: Ticks = 0): void {
    if (!this.project) throw new Error('setProject 가 먼저 호출돼야 한다');
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
    for (const source of this.playing) {
      try { source.stop(); } catch { /* 이미 끝난 소스 */ }
    }
    this.playing.clear();
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
    this.startBuffer(runtime, freqHz, note.velocity, this.ctx.currentTime, MAX_NOTE_SEC);
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

  async exportAudio(options: ExportOptions): Promise<ExportResult> {
    if (!this.project) throw new Error('setProject 가 먼저 호출돼야 한다');
    // 미리듣기와 같은 보이스 코드를 쓰므로 결과가 일치한다.
    // WASM 워크렛이 들어오면 이 자리는 OfflineAudioContext + 같은 워크렛으로 바뀐다
    const render = (project: Project) =>
      renderProjectOffline(project, this.registry, { sampleRate: options.sampleRate });

    if (!options.stems) {
      const { pcm } = render(this.project);
      return { sampleRate: options.sampleRate, buffers: [{ trackId: null, channels: [pcm] }] };
    }

    const buffers: ExportResult['buffers'] = [];
    for (const track of this.project.tracks) {
      const solo: Project = { ...this.project, tracks: [{ ...track, mute: false, solo: false }] };
      const { pcm } = render(solo);
      buffers.push({ trackId: track.id, channels: [pcm] });
    }
    return { sampleRate: options.sampleRate, buffers };
  }

  dispose(): void {
    this.stop();
    for (const runtime of this.tracks.values()) runtime.gainNode.disconnect();
    this.tracks.clear();
    this.cache.clear();
    this.masterGain.disconnect();
  }

  // -------------------------------------------------------------------------

  private emit(event: ScheduledNote, atTime: number, durationSec: number): void {
    const runtime = this.tracks.get(event.trackId);
    if (!runtime || !this.project) return;
    const freqHz = pitchToHz(event.note.pitch, this.project.tuning);
    // 늦게 도착한 예약은 드롭하지 않고 즉시 발음한다 — 드롭하면 음이 사라진다
    const when = Math.max(atTime, this.ctx.currentTime);
    this.startBuffer(runtime, freqHz, event.note.velocity, when, durationSec);
  }

  private startBuffer(
    runtime: TrackRuntime,
    freqHz: number,
    velocity: number,
    when: number,
    _durationSec: number,
  ): void {
    const buffer = this.buffered(runtime, freqHz, velocity);
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
  private renderNote(runtime: TrackRuntime, freqHz: number, velocity: number): Float32Array {
    const params = runtime.params as Record<string, number | string>;

    if (this.wasm && runtime.instrument.voice === 'waveguide-string') {
      this.wasm.allOff();
      this.wasm.noteOn(freqHz, velocity, params);
      const total = Math.ceil(MAX_NOTE_SEC * this.ctx.sampleRate);
      const out = new Float32Array(total);
      const scratch = new Float32Array(WASM_BLOCK);
      let written = 0;
      while (written < total) {
        const frames = Math.min(WASM_BLOCK, total - written);
        scratch.fill(0);
        const active = this.wasm.process(scratch, frames);
        out.set(scratch.subarray(0, frames), written);
        written += frames;
        if (active === 0) break; // 보이스가 조용해졌으면 거기서 끝
      }
      return written === total ? out : out.slice(0, written);
    }

    return renderNoteToPcm({
      voiceType: runtime.instrument.voice,
      params,
      freqHz,
      velocity,
      sampleRate: this.ctx.sampleRate,
      maxSec: MAX_NOTE_SEC,
    });
  }

  private buffered(runtime: TrackRuntime, freqHz: number, velocity: number): AudioBuffer {
    // 세기는 8단계로 뭉쳐 캐시 적중률을 올린다. 귀로 구분되지 않는 차이다
    const vq = Math.round(velocity * 8) / 8;
    const key = `${runtime.paramsKey}|${freqHz.toFixed(4)}|${vq}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const pcm = this.renderNote(runtime, freqHz, vq);

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

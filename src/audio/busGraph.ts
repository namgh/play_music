/**
 * 버스 그래프 — Aux 버스, 트랙 출력 경로, 센드 (`LOGIC_PARITY.md` 1-8).
 *
 * 세 렌더러(워크렛·버퍼·내보내기)가 **같은 클래스**를 쓴다. 미리듣기와 내보내기의
 * 경로가 다르면 "들은 것과 나간 것이 다르다"가 되기 때문이다 (`plan.md` 5-2).
 *
 * 구조:
 *   트랙 끝(source) ─┬→ 출력: 마스터 입력 또는 버스 입력
 *                    └→ 센드 게인 → 버스 입력          (포스트 페이더)
 *   버스: 입력 → 이펙트 → 게인 → 팬 → 마스터 입력
 *
 * 버스는 언제나 마스터로 간다 — 버스→버스는 없다(되먹임 고리가 생길 수 있다).
 */

import type { Bus, BusId, Project, Track, TrackId } from '../model/project.ts';
import { buildEffectChain } from './effectGraph.ts';
import type { EffectChain } from './effectGraph.ts';

interface BusRuntime {
  input: GainNode;
  effects: EffectChain;
  effectsKey: string;
  gain: GainNode;
  pan: StereoPannerNode;
  analyser: AnalyserNode;
}

interface TrackRoute {
  source: AudioNode;
  destination: AudioNode;
  sends: Map<BusId, GainNode>;
}

export class BusGraph {
  private readonly ctx: BaseAudioContext;
  private master: AudioNode;
  private readonly buses = new Map<BusId, BusRuntime>();
  private readonly routes = new Map<TrackId, TrackRoute>();

  constructor(ctx: BaseAudioContext, master: AudioNode) {
    this.ctx = ctx;
    this.master = master;
  }

  /** 마스터 체인이 새로 만들어졌다 — 마스터로 가던 것들을 옮긴다 */
  setMaster(master: AudioNode): void {
    const previous = this.master;
    this.master = master;
    for (const bus of this.buses.values()) {
      bus.pan.disconnect(previous);
      bus.pan.connect(master);
    }
    for (const route of this.routes.values()) {
      if (route.destination !== previous) continue;
      route.source.disconnect(previous);
      route.source.connect(master);
      route.destination = master;
    }
  }

  /** 버스 목록을 프로젝트에 맞춘다 (만들기·고치기·없애기) */
  syncBuses(project: Project): void {
    const wanted = project.buses ?? [];
    for (const [id, runtime] of this.buses) {
      if (!wanted.some((b) => b.id === id)) {
        this.disposeBus(runtime);
        this.buses.delete(id);
      }
    }
    for (const bus of wanted) this.updateBus(bus);
  }

  private updateBus(bus: Bus): void {
    let runtime = this.buses.get(bus.id);
    if (!runtime) {
      const input = this.ctx.createGain();
      const effects = buildEffectChain(this.ctx, []);
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      input.connect(effects.input);
      effects.output.connect(gain).connect(pan).connect(this.master);
      pan.connect(analyser);
      runtime = { input, effects, effectsKey: '[]', gain, pan, analyser };
      this.buses.set(bus.id, runtime);
    }
    runtime.gain.gain.value = bus.mute ? 0 : bus.gain;
    runtime.pan.pan.value = bus.pan;
    const key = JSON.stringify(bus.effects);
    if (key !== runtime.effectsKey) {
      runtime.input.disconnect();
      runtime.effects.dispose();
      runtime.effects = buildEffectChain(this.ctx, bus.effects);
      runtime.effectsKey = key;
      runtime.input.connect(runtime.effects.input);
      runtime.effects.output.connect(runtime.gain);
    }
  }

  /** 버스 레벨 미터용 */
  busAnalyser(id: BusId): AnalyserNode | null {
    return this.buses.get(id)?.analyser ?? null;
  }

  /**
   * 트랙 끝(`source`)을 출력·센드에 잇는다. 매번 불러도 된다 — 바뀐 연결만 고친다.
   * 없는 버스로 가라고 하면 마스터로 보낸다 (버스를 지웠는데 트랙이 소리를 잃으면 안 된다).
   */
  routeTrack(track: Pick<Track, 'id' | 'output' | 'sends'>, source: AudioNode): void {
    const busInput = track.output ? this.buses.get(track.output)?.input : undefined;
    const destination: AudioNode = busInput ?? this.master;
    let route = this.routes.get(track.id);
    if (!route || route.source !== source) {
      route = { source, destination, sends: new Map() };
      source.connect(destination);
      this.routes.set(track.id, route);
    } else if (route.destination !== destination) {
      source.disconnect(route.destination);
      source.connect(destination);
      route.destination = destination;
    }

    const wanted = new Map((track.sends ?? []).filter((s) => this.buses.has(s.busId)).map((s) => [s.busId, s.level]));
    for (const [busId, gain] of route.sends) {
      if (!wanted.has(busId)) {
        source.disconnect(gain);
        gain.disconnect();
        route.sends.delete(busId);
      }
    }
    for (const [busId, level] of wanted) {
      let gain = route.sends.get(busId);
      if (!gain) {
        gain = this.ctx.createGain();
        source.connect(gain).connect(this.buses.get(busId)!.input);
        route.sends.set(busId, gain);
      }
      gain.gain.value = level;
    }
  }

  removeTrack(trackId: TrackId): void {
    const route = this.routes.get(trackId);
    if (!route) return;
    for (const gain of route.sends.values()) gain.disconnect();
    this.routes.delete(trackId);
  }

  private disposeBus(runtime: BusRuntime): void {
    // 이 버스로 가던 트랙은 마스터로 돌린다
    for (const route of this.routes.values()) {
      if (route.destination === runtime.input) {
        route.source.disconnect(runtime.input);
        route.source.connect(this.master);
        route.destination = this.master;
      }
    }
    runtime.input.disconnect();
    runtime.effects.dispose();
    runtime.gain.disconnect();
    runtime.pan.disconnect();
  }

  dispose(): void {
    for (const runtime of this.buses.values()) this.disposeBus(runtime);
    this.buses.clear();
    this.routes.clear();
  }
}

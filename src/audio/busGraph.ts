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
 *
 * ## 지연 보정 (PDC, `EFFECTS_PLAN.md` 2절)
 * 지연이 있는 이펙트(컨볼루션·리니어 페이즈 EQ·룩어헤드 리미터…)가 있으면 그 트랙만 늦게 들린다.
 * 트랙마다 경로 지연 = 트랙 체인 + 출력 버스 체인. 가장 긴 경로에 맞춰 나머지 트랙 끝에
 * 딜레이(`comp`)를 건다. 센드도 `comp` 뒤에서 갈라지므로 같이 맞는다.
 * **보정하지 않는 것**: 센드가 가는 버스의 지연 차이, 메트로놈, 마스터 체인 지연(재생 헤드 표시와 어긋남).
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
  /** 지연 보정 — source → comp → 출력·센드 */
  comp: DelayNode;
  /** 이 트랙 체인의 지연(샘플) */
  latency: number;
  output: BusId | null;
  destination: AudioNode;
  sends: Map<BusId, GainNode>;
}

/** 보정 딜레이 상한(초) — 이보다 긴 지연은 보정하지 않는다 */
const MAX_COMP_SEC = 1;

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
      route.comp.disconnect(previous);
      route.comp.connect(master);
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
    this.compensate();
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

  busEffects(id: BusId): EffectChain | null {
    return this.buses.get(id)?.effects ?? null;
  }

  /** 버스 레벨 미터용 */
  busAnalyser(id: BusId): AnalyserNode | null {
    return this.buses.get(id)?.analyser ?? null;
  }

  /**
   * 트랙 끝(`source`)을 출력·센드에 잇는다. 매번 불러도 된다 — 바뀐 연결만 고친다.
   * 없는 버스로 가라고 하면 마스터로 보낸다 (버스를 지웠는데 트랙이 소리를 잃으면 안 된다).
   */
  routeTrack(track: Pick<Track, 'id' | 'output' | 'sends'>, source: AudioNode, latency = 0): void {
    const busInput = track.output ? this.buses.get(track.output)?.input : undefined;
    const destination: AudioNode = busInput ?? this.master;
    let route = this.routes.get(track.id);
    if (!route || route.source !== source) {
      if (route) this.removeTrack(track.id);
      const comp = this.ctx.createDelay(MAX_COMP_SEC);
      comp.delayTime.value = 0;
      source.connect(comp).connect(destination);
      route = { source, comp, latency, output: null, destination, sends: new Map() };
      this.routes.set(track.id, route);
    } else if (route.destination !== destination) {
      route.comp.disconnect(route.destination);
      route.comp.connect(destination);
      route.destination = destination;
    }
    route.latency = latency;
    route.output = busInput ? track.output! : null;

    const wanted = new Map((track.sends ?? []).filter((s) => this.buses.has(s.busId)).map((s) => [s.busId, s.level]));
    for (const [busId, gain] of route.sends) {
      if (!wanted.has(busId)) {
        route.comp.disconnect(gain);
        gain.disconnect();
        route.sends.delete(busId);
      }
    }
    for (const [busId, level] of wanted) {
      let gain = route.sends.get(busId);
      if (!gain) {
        gain = this.ctx.createGain();
        route.comp.connect(gain).connect(this.buses.get(busId)!.input);
        route.sends.set(busId, gain);
      }
      gain.gain.value = level;
    }
    this.compensate();
  }

  /** 트랙별 경로 지연(샘플) — 보정 전 */
  pathLatency(trackId: TrackId): number {
    const route = this.routes.get(trackId);
    if (!route) return 0;
    const bus = route.output ? this.buses.get(route.output) : undefined;
    return route.latency + (bus?.effects.latency ?? 0);
  }

  /** 가장 긴 경로에 맞춰 보정 딜레이를 다시 건다 */
  compensate(): void {
    let max = 0;
    for (const id of this.routes.keys()) max = Math.max(max, this.pathLatency(id));
    for (const [id, route] of this.routes) {
      const sec = Math.min(MAX_COMP_SEC, (max - this.pathLatency(id)) / this.ctx.sampleRate);
      route.comp.delayTime.value = sec;
    }
  }

  /** 지금 보정에 쓴 가장 긴 지연(샘플) — 화면 표시용 */
  maxLatency(): number {
    let max = 0;
    for (const id of this.routes.keys()) max = Math.max(max, this.pathLatency(id));
    return max;
  }

  removeTrack(trackId: TrackId): void {
    const route = this.routes.get(trackId);
    if (!route) return;
    for (const gain of route.sends.values()) gain.disconnect();
    try { route.source.disconnect(route.comp); } catch { /* 이미 끊겼다 */ }
    route.comp.disconnect();
    this.routes.delete(trackId);
  }

  private disposeBus(runtime: BusRuntime): void {
    // 이 버스로 가던 트랙은 마스터로 돌린다
    for (const route of this.routes.values()) {
      if (route.destination === runtime.input) {
        route.comp.disconnect(runtime.input);
        route.comp.connect(this.master);
        route.destination = this.master;
        route.output = null;
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

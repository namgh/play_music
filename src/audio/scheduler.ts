/**
 * 룩어헤드 스케줄러 — 직접 구현한다 (`plan.md` 5-2, Tone.js 사용 안 함).
 *
 * 원리: `setInterval` 은 정확하지 않다. 그래서 타이머는 "곧 올 구간을 미리 예약하라"는
 * 신호로만 쓰고, **실제 발음 시각은 오디오 클럭 기준 절대 시각으로 예약**한다.
 * 타이머가 몇 ms 늦게 깨어나도 소리는 제자리에 떨어진다.
 *
 * 이 파일에는 타이머도 오디오 API도 없다. `pump()` 를 누가 부르는지는 호출자 몫이고,
 * 그래서 가짜 클럭으로 전부 테스트할 수 있다.
 */

import type {
  Project, Note, PitchCurve, TrackId, ClipId, NoteId, LoopRegion,
} from '../model/project.ts';
import { audibleTracks } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { PPQ, secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from '../model/time.ts';
import type { Tuning } from '../model/pitch.ts';
import { pitchToHz } from '../model/pitch.ts';

/** 스케줄러가 렌더러에게 넘기는 발음 요청 */
export interface ScheduledNote {
  trackId: TrackId;
  clipId: ClipId;
  noteId: NoteId;
  /** 곡 시작 기준 절대 틱 */
  startTick: Ticks;
  /** 클립 끝에서 잘린 뒤의 길이 */
  lengthTick: Ticks;
  note: Note;
  pitchCurve: PitchCurve | null;
}

/**
 * 구간 [fromTick, toTick) 에 시작하는 음을 모은다. 순수 함수.
 *
 * 클립 경계를 넘어가는 음은 **클립 끝에서 자른다** — 클립을 짧게 줄였을 때
 * 안 보이는 음이 계속 울리면 사용자가 원인을 찾을 수 없다.
 */
export function collectNoteEvents(project: Project, fromTick: Ticks, toTick: Ticks): ScheduledNote[] {
  const out: ScheduledNote[] = [];
  if (toTick <= fromTick) return out;

  for (const track of audibleTracks(project)) {
    for (const clip of track.clips) {
      // 클립이 구간과 겹치지 않으면 음을 볼 필요가 없다
      if (clip.startTick >= toTick || clip.startTick + clip.lengthTick <= fromTick) continue;

      for (const note of clip.notes) {
        const startTick = clip.startTick + note.startTick;
        if (startTick < fromTick || startTick >= toTick) continue;

        const clipEnd = clip.startTick + clip.lengthTick;
        const lengthTick = Math.min(note.lengthTick, clipEnd - startTick);
        if (lengthTick <= 0) continue;

        out.push({
          trackId: track.id,
          clipId: clip.id,
          noteId: note.id,
          startTick,
          lengthTick,
          note,
          pitchCurve: note.pitchCurve,
        });
      }
    }
  }

  out.sort((a, b) => a.startTick - b.startTick);
  return out;
}

/**
 * 트랙별 레가토 시간을 만드는 헬퍼. 렌더러 세 곳이 같은 값을 써야 한다 —
 * 갈라지면 "들은 것과 파일이 다르다"가 된다
 */
export function legatoLookup(
  project: Project,
  legatoMsOf: (instrumentId: string) => number,
): (trackId: TrackId) => number {
  const byTrack = new Map<TrackId, number>();
  for (const track of project.tracks) byTrack.set(track.id, legatoMsOf(track.instrumentId));
  return (trackId) => byTrack.get(trackId) ?? 0;
}

/** 레가토로 이어졌다고 보는 최대 간격 (틱). 32분음표쯤 */
const LEGATO_GAP_TICKS = PPQ / 8;

/**
 * 레가토 — 이어지는 음의 **시작 음정을 앞 음에서 끌어온다** (`ROADMAP.md` S2-3).
 *
 * 지금까지 모든 음이 완전히 독립 발음이었다. 실제 연주는 이어 치면 줄을 다시 뜯지
 * 않고 손가락만 옮긴다(해머온·풀오프). 그래서 음이 새로 시작하지 않고 **앞 음에서
 * 미끄러져 들어온다.** `sound.md` 가 "자연스러움의 실제 레버" **2순위**로 꼽은 항목이
 * 통째로 비어 있었다.
 *
 * **엔진을 확장하지 않는다.** 검증된 글라이드 경로(`curve.rs`)를 그대로 쓴다 —
 * 앞 음과의 음정 차이를 시작 오프셋으로 넣으면 그게 곧 레가토다. 새 DSP 를 만들면
 * 음정 정확도를 다시 증명해야 하는데, 이 방법은 그럴 필요가 없다.
 *
 * 순수 함수라 브라우저 없이 테스트된다.
 *
 * @param legatoMsFor 트랙별 레가토 시간. 0 이면 그 트랙은 건드리지 않는다
 */
export function applyLegato(
  events: readonly ScheduledNote[],
  legatoMsFor: (trackId: TrackId) => number,
  tuning: Tuning,
  /**
   * 트랙별 직전 음. **재생 경로가 넘긴다** — 룩어헤드 스케줄러는 구간을 쪼개
   * 예약하므로 앞 음이 이전 구간에 있을 수 있고, 매번 새 표를 만들면 구간 경계에서
   * 레가토가 끊긴다. 넘기지 않으면 이 호출 안에서만 유효한 표를 쓴다
   */
  previous: Map<TrackId, ScheduledNote> = new Map(),
): ScheduledNote[] {

  return events.map((event) => {
    const legatoMs = legatoMsFor(event.trackId);
    const last = previous.get(event.trackId);
    previous.set(event.trackId, event);

    if (legatoMs <= 0 || !last) return event;

    // 앞 음이 끝나기 전이거나 바로 뒤여야 이어 친 것이다
    const gap = event.startTick - (last.startTick + last.lengthTick);
    if (gap > LEGATO_GAP_TICKS) return event;
    // 같은 음이면 이을 것이 없다
    if (last.note.pitch.midi === event.note.pitch.midi
      && last.note.pitch.cents === event.note.pitch.cents) return event;

    // **사용자가 그린 곡선이 우선이다.** 자동 레가토가 그것을 덮으면 화면의 곡선과
    // 들리는 음정이 달라진다 — 이 제품에서 가장 하면 안 되는 일이다
    if (event.pitchCurve?.glide || event.pitchCurve?.points?.length) return event;

    const fromHz = pitchToHz(last.note.pitch, tuning);
    const toHz = pitchToHz(event.note.pitch, tuning);
    if (!(fromHz > 0) || !(toHz > 0)) return event;
    const cents = 1200 * Math.log2(fromHz / toHz);

    return {
      ...event,
      pitchCurve: {
        glide: { cents, ms: legatoMs },
        vibrato: event.pitchCurve?.vibrato ?? null,
        points: null,
      },
    };
  });
}

/**
 * 메트로놈 한 번. 강세는 마디 첫 박이다.
 * 소리는 렌더러가 만든다 — 스케줄러는 "언제 울릴지"만 정한다
 */
export interface ScheduledClick {
  /** 곡 시작 기준 절대 틱 */
  startTick: Ticks;
  /** 마디 첫 박인가 */
  accent: boolean;
}

export interface SchedulerHost {
  /** 오디오 클럭. 초 단위, 단조 증가 */
  now(): number;
  /**
   * 발음 예약. `atTime` 은 `now()` 와 같은 시간축의 절대 시각이다.
   * 이미 지난 시각이 오면 렌더러가 즉시 발음해야 한다 (드롭하지 말 것 — 음이 사라진다).
   */
  scheduleNote(event: ScheduledNote, atTime: number, durationSec: number): void;
  /** 메트로놈. 없으면 스케줄러가 비트를 계산하지 않는다 */
  scheduleClick?(click: ScheduledClick, atTime: number): void;
  /**
   * 트랙별 레가토 시간 (`ROADMAP.md` S2-3). 없으면 레가토를 걸지 않는다.
   *
   * 스케줄러가 악기 정의를 몰라야 하므로(`plan.md` 5-2 의 층 분리) 호스트가 준다
   */
  legatoMsFor?(trackId: TrackId): number;
}

export interface SchedulerOptions {
  /** 미리 예약해 두는 시간. 길면 안전하고, 짧으면 편집 반응이 빠르다 */
  lookaheadSec?: number;
}

const DEFAULT_LOOKAHEAD_SEC = 0.12;

/**
 * 구간 [fromTick, toTick) 에 있는 박을 모은다. 순수 함수.
 *
 * `collectNoteEvents` 와 같은 규약(반열린 구간)이라 루프 랩어라운드 처리를 함께 탈 수 있다.
 */
export function collectBeatEvents(
  project: Project,
  fromTick: Ticks,
  toTick: Ticks,
): ScheduledClick[] {
  const out: ScheduledClick[] = [];
  if (toTick <= fromTick) return out;

  const beat = ticksPerBeat(project.timeSignature);
  const bar = ticksPerBar(project.timeSignature);
  if (beat <= 0) return out;

  // fromTick 이 박 위에 정확히 있으면 그 박을 포함한다 (반열린 구간의 왼쪽 끝)
  const first = Math.ceil(fromTick / beat) * beat;
  for (let tick = first; tick < toTick; tick += beat) {
    out.push({ startTick: tick, accent: tick % bar === 0 });
  }
  return out;
}

/**
 * 룩어헤드 스케줄러.
 *
 * ## 시간축이 두 개다 (루프 때문에)
 *
 * - **원시 틱(raw)** — 재생 시작부터 단조 증가한다. 시간과 1:1 이라 예약 시각 계산에 쓴다
 * - **곡 위치(song)** — 루프 구간 안으로 감긴 값. 어떤 음을 낼지 고르는 데 쓴다
 *
 * 이 둘을 섞으면 루프 경계에서 **음이 빠지거나 두 번 난다.** 예약 진행도
 * (`scheduledUpToRaw`)를 원시 틱으로 들고 있는 것이 핵심이다 — 곡 위치로 들고 있으면
 * 되감기는 순간 "이미 예약함" 판정이 뒤로 돌아가 같은 음을 다시 낸다.
 */
export class LookaheadScheduler {
  private readonly host: SchedulerHost;
  private readonly lookaheadSec: number;
  private project: Project | null = null;

  /** 재생을 시작한 오디오 클럭 시각 */
  private startTime = 0;
  /** 그 시각에 해당하는 곡 위치 */
  private startTick: Ticks = 0;
  /** 여기까지 예약을 마쳤다 (**원시 틱**, 미포함 상한) */
  private scheduledUpToRaw: Ticks = 0;
  /** 트랙별 직전 음. 구간을 넘어서도 레가토가 이어지려면 상태가 필요하다 */
  private readonly legatoPrevious = new Map<TrackId, ScheduledNote>();
  private running = false;
  private metronome = false;

  // 파라미터 프로퍼티(`private host: ...`)를 쓰지 않는다 — Node 의 타입 스트리핑은
  // 변환이 아니라 제거만 하므로 지원하지 않고, 그러면 빌드 없이 테스트할 수 없게 된다.
  constructor(host: SchedulerHost, options: SchedulerOptions = {}) {
    this.host = host;
    this.lookaheadSec = options.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC;
  }

  start(project: Project, fromTick: Ticks = 0): void {
    this.project = project;
    this.startTime = this.host.now();
    this.startTick = fromTick;
    this.scheduledUpToRaw = fromTick;
    // 되감으면 "직전 음"도 없던 것이 된다. 안 지우면 재생을 다시 시작한 첫 음이
    // 멈추기 전 마지막 음에서 미끄러져 들어온다
    this.legatoPrevious.clear();
    this.running = true;
    this.pump();
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  setMetronome(on: boolean): void {
    this.metronome = on;
  }

  /**
   * 재생 중에 프로젝트를 갈아 끼운다 (편집이 즉시 반영되게).
   * 예약 진행도를 건드리지 않으므로 이미 예약된 음은 그대로 울린다.
   */
  setProject(project: Project): void {
    this.project = project;
  }

  /** 현재 재생 위치 (곡 기준, 루프 안으로 감긴 값) */
  positionTicks(): Ticks {
    if (!this.running || !this.project) return this.startTick;
    const elapsed = this.host.now() - this.startTime;
    return this.wrap(this.startTick + this.secondsToTicks(elapsed));
  }

  /** 유효한 루프. 꺼져 있거나 길이가 0 이면 없는 것으로 본다 */
  private activeLoop(): LoopRegion | null {
    const loop = this.project?.loop;
    if (!loop || !loop.enabled) return null;
    if (!(loop.endTick > loop.startTick)) return null;
    return loop;
  }

  /** 원시 틱 → 곡 위치 */
  private wrap(rawTick: Ticks): Ticks {
    const loop = this.activeLoop();
    if (!loop) return rawTick;
    // 루프 시작 전이거나 아직 끝에 닿지 않았으면 그대로 흐른다
    if (rawTick < loop.endTick) return rawTick;
    const length = loop.endTick - loop.startTick;
    return loop.startTick + ((rawTick - loop.startTick) % length);
  }

  /**
   * 타이머가 부르는 함수. 지금부터 룩어헤드 구간까지의 음을 예약한다.
   * 여러 번 불러도 같은 음이 두 번 예약되지 않는다 (`scheduledUpToRaw` 가 경계).
   */
  pump(): void {
    if (!this.running || !this.project) return;

    const horizonSec = this.host.now() - this.startTime + this.lookaheadSec;
    const horizonRaw = this.startTick + this.secondsToTicks(horizonSec);
    if (horizonRaw <= this.scheduledUpToRaw) return;

    const loop = this.activeLoop();

    // 루프 경계마다 세그먼트를 끊는다. 한 세그먼트 안에서는 원시 틱과 곡 위치의
    // 차이가 일정하므로 `collectNoteEvents` 를 그대로 쓸 수 있다
    while (this.scheduledUpToRaw < horizonRaw) {
      const fromRaw = this.scheduledUpToRaw;
      const fromSong = this.wrap(fromRaw);

      let toRaw = horizonRaw;
      if (loop) {
        const untilBoundary = loop.endTick - fromSong;
        // 경계 앞이면 거기서 끊는다. 이미 지났으면(루프 밖에서 시작) 그대로 간다
        if (untilBoundary > 0) toRaw = Math.min(toRaw, fromRaw + untilBoundary);
      }
      const toSong = fromSong + (toRaw - fromRaw);
      const offset = fromRaw - fromSong;

      const collected = collectNoteEvents(this.project, fromSong, toSong);
      const legatoMsFor = this.host.legatoMsFor?.bind(this.host);
      const events = legatoMsFor
        ? applyLegato(collected, legatoMsFor, this.project.tuning, this.legatoPrevious)
        : collected;

      for (const event of events) {
        const atTime = this.startTime
          + this.ticksToSeconds(event.startTick + offset - this.startTick);
        this.host.scheduleNote(event, atTime, this.ticksToSeconds(event.lengthTick));
      }

      if (this.metronome && this.host.scheduleClick) {
        for (const click of collectBeatEvents(this.project, fromSong, toSong)) {
          const atTime = this.startTime
            + this.ticksToSeconds(click.startTick + offset - this.startTick);
          this.host.scheduleClick(click, atTime);
        }
      }

      this.scheduledUpToRaw = toRaw;
    }
  }

  private ticksToSeconds(ticks: Ticks): number {
    return ticksToSeconds(ticks, this.project!.tempo);
  }

  private secondsToTicks(seconds: number): Ticks {
    return secondsToTicks(seconds, this.project!.tempo);
  }
}

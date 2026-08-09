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
import { secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from '../model/time.ts';

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

      for (const event of collectNoteEvents(this.project, fromSong, toSong)) {
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

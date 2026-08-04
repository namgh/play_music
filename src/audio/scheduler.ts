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

import type { Project, Note, PitchCurve, TrackId, ClipId, NoteId } from '../model/project.ts';
import { audibleTracks } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { secondsToTicks, ticksToSeconds } from '../model/time.ts';

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

export interface SchedulerHost {
  /** 오디오 클럭. 초 단위, 단조 증가 */
  now(): number;
  /**
   * 발음 예약. `atTime` 은 `now()` 와 같은 시간축의 절대 시각이다.
   * 이미 지난 시각이 오면 렌더러가 즉시 발음해야 한다 (드롭하지 말 것 — 음이 사라진다).
   */
  scheduleNote(event: ScheduledNote, atTime: number, durationSec: number): void;
}

export interface SchedulerOptions {
  /** 미리 예약해 두는 시간. 길면 안전하고, 짧으면 편집 반응이 빠르다 */
  lookaheadSec?: number;
}

const DEFAULT_LOOKAHEAD_SEC = 0.12;

export class LookaheadScheduler {
  private readonly host: SchedulerHost;
  private readonly lookaheadSec: number;
  private project: Project | null = null;

  /** 재생을 시작한 오디오 클럭 시각 */
  private startTime = 0;
  /** 그 시각에 해당하는 곡 위치 */
  private startTick: Ticks = 0;
  /** 여기까지 예약을 마쳤다 (곡 기준 절대 틱, 미포함 상한) */
  private scheduledUpToTick: Ticks = 0;
  private running = false;

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
    this.scheduledUpToTick = fromTick;
    this.running = true;
    this.pump();
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 현재 재생 위치 */
  positionTicks(): Ticks {
    if (!this.running || !this.project) return this.startTick;
    const elapsed = this.host.now() - this.startTime;
    return this.startTick + this.secondsToTicks(elapsed);
  }

  /**
   * 타이머가 부르는 함수. 지금부터 룩어헤드 구간까지의 음을 예약한다.
   * 여러 번 불러도 같은 음이 두 번 예약되지 않는다 (`scheduledUpToTick` 이 경계).
   */
  pump(): void {
    if (!this.running || !this.project) return;

    const horizonSec = this.host.now() - this.startTime + this.lookaheadSec;
    const horizonTick = this.startTick + this.secondsToTicks(horizonSec);
    if (horizonTick <= this.scheduledUpToTick) return;

    const events = collectNoteEvents(this.project, this.scheduledUpToTick, horizonTick);
    for (const event of events) {
      const atTime = this.startTime + this.ticksToSeconds(event.startTick - this.startTick);
      this.host.scheduleNote(event, atTime, this.ticksToSeconds(event.lengthTick));
    }

    this.scheduledUpToTick = horizonTick;
  }

  private ticksToSeconds(ticks: Ticks): number {
    return ticksToSeconds(ticks, this.project!.tempo);
  }

  private secondsToTicks(seconds: number): Ticks {
    return secondsToTicks(seconds, this.project!.tempo);
  }
}

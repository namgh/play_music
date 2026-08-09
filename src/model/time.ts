/**
 * 음악적 시간. **초가 아니라 틱을 저장한다** (`plan.md` 5-4).
 *
 * 초로 저장하면 BPM을 바꿀 때 전곡을 다시 계산해야 하고 반올림 오차가 쌓인다.
 * 초는 항상 파생값이다.
 */

/** 4분음표 하나당 틱 수. 3분할(셋잇단)과 이진 분할이 모두 정수로 떨어지는 값. */
export const PPQ = 960;

/** 4분음표 기준 틱 */
export type Ticks = number;

/** 템포가 바뀌는 지점. `tick` 부터 `bpm` 이 적용된다 */
export interface TempoChange {
  tick: Ticks;
  bpm: number;
}

export interface Tempo {
  /** 곡 시작 템포 */
  bpm: number;
  /**
   * 템포 변화 (`ROADMAP.md` P2). **필드 추가라 마이그레이션이 필요 없다**
   * (`sound.md` 9-8) — 옛 파일은 `undefined` 로 읽히고 곡 전체가 `bpm` 하나다.
   *
   * 늦출수록 비싸서 먼저 넣었다. `ticksToSeconds`·`secondsToTicks` 가 유일한
   * 변환 지점이라 여기만 고치면 스케줄러·내보내기·커서가 전부 따라온다
   */
  changes?: TempoChange[];
}

export interface TimeSignature {
  /** 한 마디의 박 수 */
  num: number;
  /** 한 박의 음표 길이 (4 = 4분음표) */
  den: number;
}

export const DEFAULT_TEMPO: Tempo = { bpm: 120 };
export const DEFAULT_TIME_SIGNATURE: TimeSignature = { num: 4, den: 4 };

/** 한 박의 틱 수. 8분의6박자면 8분음표 하나가 한 박이다. */
export function ticksPerBeat(ts: TimeSignature): Ticks {
  return (PPQ * 4) / ts.den;
}

export function ticksPerBar(ts: TimeSignature): Ticks {
  return ticksPerBeat(ts) * ts.num;
}

/**
 * 템포 구간을 시작 틱 순으로 정리한다. **순수 함수.**
 *
 * 화면에서 온 값이라 여기서 정리한다 — 음수 틱, 0 이하 BPM, 뒤섞인 순서를
 * 변환 함수 안쪽까지 들이지 않는다.
 */
export function tempoSegments(tempo: Tempo): { tick: Ticks; bpm: number }[] {
  const segments = [{ tick: 0, bpm: tempo.bpm > 0 ? tempo.bpm : 120 }];
  for (const change of tempo.changes ?? []) {
    if (!(change.bpm > 0) || !(change.tick > 0) || !Number.isFinite(change.tick)) continue;
    segments.push({ tick: change.tick, bpm: change.bpm });
  }
  segments.sort((a, b) => a.tick - b.tick);
  // 같은 틱이 여러 개면 마지막 것만 남긴다 — 앞의 것은 길이 0 이라 의미가 없다
  return segments.filter((seg, i) => i === segments.length - 1 || seg.tick !== segments[i + 1]!.tick);
}

/**
 * 틱 → 초. 템포 구간을 **누적**한다.
 *
 * 단순 곱셈이 아닌 이유: 곡 중간에 템포가 바뀌면 그 지점 앞뒤의 초/틱 비율이
 * 다르다. 마지막 템포만 쓰면 앞부분이 통째로 밀린다.
 */
export function ticksToSeconds(ticks: Ticks, tempo: Tempo): number {
  const segments = tempoSegments(tempo);
  if (segments.length === 1) return (ticks / PPQ) * (60 / segments[0]!.bpm);

  let seconds = 0;
  for (let i = 0; i < segments.length; i++) {
    const from = segments[i]!;
    const to = segments[i + 1];
    const until = to === undefined ? ticks : Math.min(ticks, to.tick);
    if (until <= from.tick) break;
    seconds += ((until - from.tick) / PPQ) * (60 / from.bpm);
    if (to === undefined || ticks <= to.tick) break;
  }
  return seconds;
}

/** 초 → 틱. `ticksToSeconds` 의 역함수여야 한다 (테스트가 왕복을 고정한다) */
export function secondsToTicks(seconds: number, tempo: Tempo): Ticks {
  const segments = tempoSegments(tempo);
  if (segments.length === 1) return (seconds * segments[0]!.bpm * PPQ) / 60;

  let remaining = seconds;
  for (let i = 0; i < segments.length; i++) {
    const from = segments[i]!;
    const to = segments[i + 1];
    if (to === undefined) return from.tick + (remaining * from.bpm * PPQ) / 60;

    const spanSec = ((to.tick - from.tick) / PPQ) * (60 / from.bpm);
    if (remaining <= spanSec) return from.tick + (remaining * from.bpm * PPQ) / 60;
    remaining -= spanSec;
  }
  return 0;
}

/** 마디·박 표시용 (1-based) — 목업의 "1.1.00" 표시가 이것 */
export interface BarBeat {
  bar: number;
  beat: number;
  /** 박 안의 위치, 0~1 */
  fraction: number;
}

export function ticksToBarBeat(ticks: Ticks, ts: TimeSignature): BarBeat {
  const perBar = ticksPerBar(ts);
  const perBeat = ticksPerBeat(ts);
  const bar = Math.floor(ticks / perBar);
  const rest = ticks - bar * perBar;
  const beat = Math.floor(rest / perBeat);
  return { bar: bar + 1, beat: beat + 1, fraction: (rest - beat * perBeat) / perBeat };
}

/** 그리드에 맞춰 반올림. 퀀타이즈의 최소 단위. */
export function quantize(ticks: Ticks, gridTicks: Ticks): Ticks {
  if (gridTicks <= 0) return ticks;
  return Math.round(ticks / gridTicks) * gridTicks;
}

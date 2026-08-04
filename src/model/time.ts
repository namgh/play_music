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

export interface Tempo {
  bpm: number;
  // 템포 변화는 Phase 2 — 그때 구간 배열로 확장한다
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

export function ticksToSeconds(ticks: Ticks, tempo: Tempo): number {
  return (ticks / PPQ) * (60 / tempo.bpm);
}

export function secondsToTicks(seconds: number, tempo: Tempo): Ticks {
  return (seconds * tempo.bpm * PPQ) / 60;
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

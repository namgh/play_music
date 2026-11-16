/**
 * 박자 지도 — 박자 변화가 있을 때 "몇 번째 마디가 몇 틱에서 시작하나".
 *
 * 박자가 하나뿐이던 때에는 `bar * ticksPerBar(ts)` 한 줄이면 됐고, 그 계산이
 * 눈금자·메트로놈·LCD·곡 길이에 흩어져 있었다. 박자 변화(Logic 글로벌 트랙)가
 * 들어오면서 **마디 ↔ 틱 변환을 여기 한 곳으로 모은다** — 템포가
 * `ticksToSeconds` 한 곳으로 모인 것과 같은 이유다.
 *
 * 변화는 **마디 번호로** 건다 (`SignatureChange`). 그래서 변화 지점은 언제나
 * 마디 경계이고, 앞 박자를 바꿔도 뒤 변화가 마디 중간으로 밀려 들어가지 않는다.
 */

import type { Project, SignatureChange } from './project.ts';
import type { Ticks, TimeSignature } from './time.ts';
import { ticksPerBar, ticksPerBeat } from './time.ts';

type MeterSource = Pick<Project, 'timeSignature' | 'signatureChanges'>;

interface Segment {
  bar: number;
  tick: Ticks;
  timeSignature: TimeSignature;
}

/** 박자 구간 목록 — 0번 마디부터, 마디 오름차순. 같은 마디의 변화는 마지막 것이 이긴다 */
function segments(source: MeterSource): Segment[] {
  const changes = new Map<number, TimeSignature>();
  for (const change of source.signatureChanges ?? []) {
    if (change.bar > 0) changes.set(Math.round(change.bar), change.timeSignature);
  }
  const ordered = [...changes.entries()].sort((a, b) => a[0] - b[0]);

  const out: Segment[] = [{ bar: 0, tick: 0, timeSignature: source.timeSignature }];
  for (const [bar, timeSignature] of ordered) {
    const prev = out[out.length - 1]!;
    out.push({ bar, tick: prev.tick + (bar - prev.bar) * ticksPerBar(prev.timeSignature), timeSignature });
  }
  return out;
}

/** `bar`(0부터) 에서 적용되는 박자 */
export function signatureAtBar(source: MeterSource, bar: number): TimeSignature {
  let current = source.timeSignature;
  for (const segment of segments(source)) {
    if (segment.bar > bar) break;
    current = segment.timeSignature;
  }
  return current;
}

/** `bar`(0부터) 가 시작하는 틱. 음수 마디는 0 */
export function barStartTick(source: MeterSource, bar: number): Ticks {
  const target = Math.max(0, Math.floor(bar));
  let found = segments(source)[0]!;
  for (const segment of segments(source)) {
    if (segment.bar > target) break;
    found = segment;
  }
  return found.tick + (target - found.bar) * ticksPerBar(found.timeSignature);
}

export interface BarPosition {
  /** 0부터 */
  bar: number;
  /** 마디 안의 박, 0부터 */
  beat: number;
  /** 박 안의 틱 */
  tickInBeat: Ticks;
  barTick: Ticks;
  timeSignature: TimeSignature;
}

/** 틱이 몇 마디 몇 박인가 */
export function positionAt(source: MeterSource, tick: Ticks): BarPosition {
  const t = Math.max(0, tick);
  let found = segments(source)[0]!;
  for (const segment of segments(source)) {
    if (segment.tick > t) break;
    found = segment;
  }
  const barLen = ticksPerBar(found.timeSignature);
  const barsIn = Math.floor((t - found.tick) / barLen);
  const barTick = found.tick + barsIn * barLen;
  const beatLen = ticksPerBeat(found.timeSignature);
  const intoBar = t - barTick;
  const beat = Math.floor(intoBar / beatLen);
  return {
    bar: found.bar + barsIn,
    beat,
    tickInBeat: intoBar - beat * beatLen,
    barTick,
    timeSignature: found.timeSignature,
  };
}

export interface BarLine {
  bar: number;
  tick: Ticks;
  lengthTick: Ticks;
  timeSignature: TimeSignature;
  /** 이 마디에서 박자가 바뀌는가 (눈금자에 표시) */
  changed: boolean;
}

/** 0번 마디부터 `count` 개 마디의 시작·길이 — 눈금자와 격자가 쓴다 */
export function barLines(source: MeterSource, count: number): BarLine[] {
  const segs = segments(source);
  const changedAt = new Set(segs.slice(1).map((s) => s.bar));
  const out: BarLine[] = [];
  let seg = 0;
  let tick = 0;
  for (let bar = 0; bar < count; bar++) {
    while (seg + 1 < segs.length && segs[seg + 1]!.bar <= bar) seg++;
    const timeSignature = segs[seg]!.timeSignature;
    const lengthTick = ticksPerBar(timeSignature);
    out.push({ bar, tick, lengthTick, timeSignature, changed: changedAt.has(bar) });
    tick += lengthTick;
  }
  return out;
}

/**
 * 구간 [from, to) 의 박 위치. 마디 첫 박이면 `accent`. 메트로놈이 쓴다.
 * 박자가 바뀌는 마디에서 박 길이도 바뀐다 (6/8 이면 8분음표가 한 박).
 */
export function beatsBetween(source: MeterSource, from: Ticks, to: Ticks): { tick: Ticks; accent: boolean }[] {
  const out: { tick: Ticks; accent: boolean }[] = [];
  if (to <= from) return out;
  let pos = positionAt(source, from);
  let barTick = pos.barTick;
  let ts = pos.timeSignature;
  let bar = pos.bar;
  // 이 마디 안에서 from 이상인 첫 박부터
  for (;;) {
    const beatLen = ticksPerBeat(ts);
    const barLen = ticksPerBar(ts);
    for (let tick = barTick; tick < barTick + barLen; tick += beatLen) {
      if (tick >= to) return out;
      if (tick >= from) out.push({ tick, accent: tick === barTick });
    }
    bar += 1;
    barTick += barLen;
    ts = signatureAtBar(source, bar);
    if (barTick >= to) return out;
    pos = positionAt(source, barTick);
    ts = pos.timeSignature;
  }
}

/** 박자 변화 목록을 정리한다 — 0번 마디는 빼고, 마디 오름차순, 같은 마디는 하나 */
export function normalizeSignatureChanges(changes: readonly SignatureChange[]): SignatureChange[] {
  const byBar = new Map<number, SignatureChange>();
  for (const change of changes) {
    const bar = Math.round(change.bar);
    if (bar <= 0) continue;
    byBar.set(bar, { bar, timeSignature: { ...change.timeSignature } });
  }
  return [...byBar.values()].sort((a, b) => a.bar - b.bar);
}

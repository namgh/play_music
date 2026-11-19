/**
 * 녹음 — 연주를 음으로 받고, 겹쳐 녹음한 것들을 테이크로 남기고, 구간별로 골라 잇는다
 * (Logic MIDI 녹음 · 테이크 폴더 · 컴핑, `LOGIC_PARITY.md` 1-7).
 *
 * 받는 쪽(건반·MIDI 장치)은 "몇 틱에 눌렀다·뗐다" 만 넘긴다. 여기서 그걸 음으로 바꾸고
 * 클립에 넣는다. 전부 순수 함수다.
 *
 * 테이크는 클립 안에 둔다 — **지금 들리는 음은 언제나 `clip.notes`** 다. 다른 테이크는
 * 보관만 되고, 고르면 자리를 바꾼다. 그래서 스케줄러·피아노 롤·내보내기는 테이크를
 * 몰라도 된다.
 */

import type { Clip, ClipId, Note, Project, Take } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { createNote } from '../model/factory.ts';
import { EditError, findClip } from './edits.ts';

/** 받은 연주 한 음 — 곡 기준 틱 */
export interface PlayedNote {
  midi: number;
  velocity: number;
  onTick: Ticks;
  /** 뗀 자리. 녹음을 멈출 때까지 안 뗐으면 null */
  offTick: Ticks | null;
}

/** 실시간으로 눌렀다 뗀 것을 모은다 — 같은 음을 다시 누르면 앞 음을 그 자리에서 끝낸다 */
export class NoteRecorder {
  private held = new Map<number, PlayedNote>();
  readonly played: PlayedNote[] = [];

  noteOn(midi: number, velocity: number, tick: Ticks): void {
    const prev = this.held.get(midi);
    if (prev) prev.offTick = tick;
    const note: PlayedNote = { midi, velocity, onTick: tick, offTick: null };
    this.held.set(midi, note);
    this.played.push(note);
  }

  noteOff(midi: number, tick: Ticks): void {
    const n = this.held.get(midi);
    if (!n) return;
    n.offTick = tick;
    this.held.delete(midi);
  }

  /** 멈춘 자리에서 아직 누르고 있던 음을 끝낸다 */
  finish(stopTick: Ticks): PlayedNote[] {
    for (const n of this.held.values()) n.offTick = stopTick;
    this.held.clear();
    return this.played;
  }
}

/**
 * 연주를 클립 기준 음으로. `quantize` 를 주면 시작을 그 격자로 당긴다(녹음 퀀타이즈).
 * 아주 짧은 음(1/64 미만)은 최소 길이로 늘린다 — 스치듯 누른 음이 안 들리면 녹음이 빠진 것 같다.
 */
export function playedToNotes(played: readonly PlayedNote[], clipStart: Ticks, options: { quantize?: Ticks; minLength?: Ticks } = {}): Note[] {
  const min = options.minLength ?? 15;
  return played
    .filter((p) => p.offTick !== null && p.onTick >= clipStart)
    .map((p) => {
      let start = p.onTick - clipStart;
      if (options.quantize) start = Math.round(start / options.quantize) * options.quantize;
      const length = Math.max(min, (p.offTick ?? p.onTick) - p.onTick);
      return createNote({ startTick: Math.max(0, start), lengthTick: length, midi: p.midi, velocity: p.velocity });
    })
    .sort((a, b) => a.startTick - b.startTick);
}

const inRange = (n: Note, from: Ticks, to: Ticks) => n.startTick >= from && n.startTick < to;

/**
 * 녹음한 음을 클립에 넣는다.
 *  - `overdub`: 기존 음에 더한다 (드럼을 한 소리씩 쌓을 때)
 *  - `replace`: 녹음한 구간의 기존 음을 **새 테이크로 보관**하고 새 음으로 바꾼다.
 *    보관한 테이크는 지워지지 않는다 — 앞 테이크가 더 좋았으면 고르면 된다
 * 클립 끝을 넘으면 클립을 늘린다. 범위는 클립 기준 틱.
 */
export function commitRecording(
  project: Project,
  clipId: ClipId,
  notes: readonly Note[],
  mode: 'overdub' | 'replace',
  range: { from: Ticks; to: Ticks },
): Project {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const { clip } = found;
  const end = Math.max(clip.lengthTick, ...notes.map((n) => n.startTick + n.lengthTick));
  let next: Clip = { ...clip, lengthTick: end };
  if (mode === 'overdub') {
    next = { ...next, notes: [...clip.notes, ...notes] };
  } else {
    const replaced = clip.notes.filter((n) => inRange(n, range.from, range.to));
    const takes = clip.takes ?? [];
    const take: Take = {
      id: `tk_${(takes.length + 1).toString(36)}_${Date.now().toString(36)}`,
      name: `테이크 ${takes.length + 1}`,
      notes: clip.notes,
    };
    next = {
      ...next,
      notes: [...clip.notes.filter((n) => !inRange(n, range.from, range.to)), ...notes],
      // 바뀐 음이 없으면(빈 자리에 처음 녹음) 테이크를 만들지 않는다 — 빈 테이크가 쌓이면 고르기만 번거롭다
      takes: replaced.length > 0 ? [...takes, take] : takes,
    };
    if (next.takes && next.takes.length === 0) delete next.takes;
  }
  return mapClip(project, clipId, () => next);
}

/** 테이크를 고른다 — 지금 음은 그 테이크 자리로, 고른 테이크가 지금 음이 된다 */
export function switchTake(project: Project, clipId: ClipId, takeId: string): Project {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const takes = found.clip.takes ?? [];
  const take = takes.find((t) => t.id === takeId);
  if (!take) throw new EditError('테이크 없음');
  return mapClip(project, clipId, (c) => ({
    ...c,
    notes: take.notes,
    takes: takes.map((t) => (t.id === takeId ? { ...t, notes: c.notes, name: `${t.name} 전` } : t)),
  }));
}

/**
 * 컴핑 — 고른 구간만 그 테이크의 음으로 바꾼다 (Logic 퀵 스와이프 컴핑).
 * 지금 음 중 그 구간의 것은 버려지지 않고 그 테이크와 자리를 바꾼다.
 */
export function compFromTake(project: Project, clipId: ClipId, takeId: string, from: Ticks, to: Ticks): Project {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const takes = found.clip.takes ?? [];
  const take = takes.find((t) => t.id === takeId);
  if (!take) throw new EditError('테이크 없음');
  if (to <= from) throw new EditError('구간이 비었다');
  return mapClip(project, clipId, (c) => {
    const ours = c.notes.filter((n) => inRange(n, from, to));
    const theirs = take.notes.filter((n) => inRange(n, from, to));
    return {
      ...c,
      notes: [...c.notes.filter((n) => !inRange(n, from, to)), ...theirs].sort((a, b) => a.startTick - b.startTick),
      takes: takes.map((t) => (t.id === takeId
        ? { ...t, notes: [...t.notes.filter((n) => !inRange(n, from, to)), ...ours].sort((a, b) => a.startTick - b.startTick) }
        : t)),
    };
  });
}

export function deleteTake(project: Project, clipId: ClipId, takeId: string): Project {
  return mapClip(project, clipId, (c) => {
    const takes = (c.takes ?? []).filter((t) => t.id !== takeId);
    const next: Clip = { ...c, takes };
    if (takes.length === 0) delete next.takes;
    return next;
  });
}

function mapClip(project: Project, clipId: ClipId, fn: (c: Clip) => Clip): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.clips.some((c) => c.id === clipId)
      ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) }
      : t)),
  };
}

/**
 * 펀치 인/아웃 (Logic Autopunch, `PARITY_ROUND2.md` 4) — 구간 안에서 친 것만 남긴다.
 * 구간 앞에서 누른 음은 버리고(준비 연주), 구간 끝을 넘는 음은 끝에서 자른다.
 * 곡 기준 틱.
 */
export function applyPunch(played: readonly PlayedNote[], punchIn: Ticks, punchOut: Ticks): PlayedNote[] {
  return played
    .filter((p) => p.onTick >= punchIn && p.onTick < punchOut)
    .map((p) => ({ ...p, offTick: p.offTick === null ? punchOut : Math.min(p.offTick, punchOut) }));
}

/** 펀치 오디오 — 녹음 시작 자리에서 구간까지 몇 초를 잘라내고 몇 초를 쓰나 */
export function punchAudioWindow(recordFromSec: number, recordedSec: number, punchInSec: number, punchOutSec: number): { offsetSec: number; lengthSec: number } | null {
  const start = Math.max(punchInSec, recordFromSec);
  const end = Math.min(punchOutSec, recordFromSec + recordedSec);
  if (end <= start) return null;
  return { offsetSec: start - recordFromSec, lengthSec: end - start };
}

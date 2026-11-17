/**
 * 스텝 시퀀서 — 격자 칸을 켜고 끄는 방식으로 음을 찍는다 (Logic Step Sequencer, `LOGIC_PARITY.md` 1-5).
 *
 * **따로 된 패턴 데이터를 두지 않는다.** 칸 하나 = 그 자리에서 시작하는 음 하나다.
 * 그래서 스텝으로 찍은 것을 피아노 롤·이벤트 목록에서 그대로 고칠 수 있고, AI 가 쓰는
 * 편집 함수도 그대로 통한다. Logic 처럼 패턴을 별도 형식으로 두면 두 표현 사이를
 * 오가는 변환이 영원히 새는 곳이 된다.
 *
 * 드럼은 소리마다 트랙이 따로라(킥·스네어…) 줄 = 트랙이고, 선율 악기는 줄 = 음높이다.
 */

import type { Clip, ClipId, Note, NoteId, Project, Track, TrackId } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { createNote, newNoteId } from '../model/factory.ts';
import { addClip, deleteNotes, EditError, findClip } from './edits.ts';

export interface StepCell {
  /** 그 칸에서 시작하는 음 (여럿이면 첫 것) */
  note: Note | null;
  /** 같은 칸 안에 음이 몇 개 — 래칫(되풀이) 표시 */
  count: number;
}

/** 한 줄(음높이 하나)의 칸들. 칸 = [i·rate, (i+1)·rate) 안에서 시작하는 음 */
export function stepRow(clip: Clip, midi: number | null, rate: Ticks, steps: number): StepCell[] {
  const cells: StepCell[] = Array.from({ length: steps }, () => ({ note: null, count: 0 }));
  for (const note of clip.notes) {
    if (midi !== null && note.pitch.midi !== midi) continue;
    const i = Math.floor(note.startTick / rate);
    if (i < 0 || i >= steps) continue;
    const cell = cells[i]!;
    if (!cell.note || note.startTick < cell.note.startTick) cell.note = note;
    cell.count += 1;
  }
  return cells;
}

export interface StepInput {
  /** 이 음높이로 찍는다 (드럼 줄이면 그 트랙의 기준음) */
  midi: number;
  step: number;
  rate: Ticks;
  velocity: number;
  /** 칸 길이에 대한 음 길이 비율 (게이트). 1 = 칸 꽉 */
  gate: number;
}

/**
 * 칸 켜기/끄기. 켜져 있으면(그 칸에서 시작하는 그 음높이 음이 있으면) 전부 지우고,
 * 꺼져 있으면 하나 찍는다. `midi === null` 줄(드럼 트랙 줄)은 음높이를 가리지 않는다.
 */
export function toggleStep(
  project: Project,
  clipId: ClipId,
  input: StepInput & { anyPitch?: boolean },
): { project: Project; on: boolean } {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const from = input.step * input.rate;
  const existing = found.clip.notes.filter((n) => n.startTick >= from && n.startTick < from + input.rate
    && (input.anyPitch || n.pitch.midi === input.midi));
  if (existing.length > 0) {
    return { project: deleteNotes(project, existing.map((n) => n.id)), on: false };
  }
  const note: Note = {
    ...createNote({
      startTick: from,
      lengthTick: Math.max(1, Math.round(input.rate * Math.max(0.05, Math.min(1, input.gate)))),
      midi: input.midi,
      velocity: input.velocity,
    }),
  };
  return {
    project: {
      ...project,
      tracks: project.tracks.map((t) => (t.id !== found.track.id ? t : {
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, notes: [...c.notes, note] } : c)),
      })),
    },
    on: true,
  };
}

/**
 * 래칫 — 칸 하나를 `count` 번 되풀이한다(하이햇 32분 연타 같은 것). 첫 음의 세기·음높이를
 * 그대로 쓰고, 칸을 똑같이 나눈다. count 1 이면 하나로 되돌린다.
 */
export function setRatchet(project: Project, clipId: ClipId, step: number, rate: Ticks, midi: number | null, count: number): Project {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const from = step * rate;
  const inCell = found.clip.notes.filter((n) => n.startTick >= from && n.startTick < from + rate && (midi === null || n.pitch.midi === midi));
  const first = inCell.sort((a, b) => a.startTick - b.startTick)[0];
  if (!first) return project;
  const n = Math.max(1, Math.min(8, Math.round(count)));
  const sub = rate / n;
  // 첫 음은 id 를 지킨다(선택이 끊기지 않게), 나머지는 새 id
  const repeats: Note[] = Array.from({ length: n }, (_, i) => ({
    ...structuredClone(first),
    id: i === 0 ? first.id : newNoteId(),
    startTick: Math.round(from + i * sub),
    lengthTick: Math.max(1, Math.round(Math.min(first.lengthTick, sub))),
  }));
  const removed = new Set<NoteId>(inCell.map((x) => x.id));
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id !== found.track.id ? t : {
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? { ...c, notes: [...c.notes.filter((x) => !removed.has(x.id)), ...repeats] } : c)),
    })),
  };
}

/**
 * 드럼 줄 — 이 시간 범위를 덮는 각 드럼 트랙의 클립. 없으면 `null` (줄은 보이되,
 * 처음 칸을 켤 때 `ensureClipFor` 가 같은 범위로 클립을 만든다).
 */
export function clipCovering(track: Track, startTick: Ticks, lengthTick: Ticks): Clip | null {
  return track.clips.find((c) => c.startTick <= startTick && c.startTick + c.lengthTick >= startTick + lengthTick) ?? null;
}

export function ensureClipFor(project: Project, trackId: TrackId, startTick: Ticks, lengthTick: Ticks): { project: Project; clipId: ClipId } {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`트랙 ${trackId} 없음`);
  const existing = clipCovering(track, startTick, lengthTick);
  if (existing) return { project, clipId: existing.id };
  return addClip(project, { trackId, startTick, lengthTick, label: `${track.name} 패턴` });
}

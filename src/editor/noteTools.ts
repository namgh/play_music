/**
 * 음 도구 — 피아노 롤의 "기능" 메뉴 (Logic Piano Roll Functions, `LOGIC_PARITY.md` 1-5).
 *
 * 스케일 퀀타이즈(음정 퀀타이즈) · 레가토 · 겹침 없애기 · 성부 떼어내기(코드 쪼개기) ·
 * 세기 늘리기/줄이기 · 사람처럼(무작위). 전부 순수 함수, 선택한 음에만 작용한다.
 */

import type { Articulation, MusicalKey, Note, NoteId, Project, TrackId } from '../model/project.ts';
import { tonicSemitone } from '../model/pitch.ts';
import { createClip, newNoteId } from '../model/factory.ts';
import { addTrack, EditError, findNote } from './edits.ts';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

function mapSelected(project: Project, ids: readonly NoteId[], fn: (note: Note, all: Note[]) => Note): Project {
  const set = new Set(ids);
  return {
    ...project,
    tracks: project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.notes.some((n) => set.has(n.id))
        ? { ...c, notes: c.notes.map((n) => (set.has(n.id) ? fn(n, c.notes) : n)) }
        : c)),
    })),
  };
}

/**
 * 스케일 퀀타이즈 — 조성 밖의 음을 가장 가까운 스케일 음으로. 같은 거리면 **아래로**
 * (Logic 과 같다 — 위로 붙이면 장조에서 반음이 자꾸 올라가 밝아진다).
 * 센트 미세조정은 그대로 둔다 — 줄을 옮길 뿐 그 줄 안의 값은 사용자의 것이다.
 */
export function scaleQuantize(project: Project, ids: readonly NoteId[], key: MusicalKey): Project {
  const root = tonicSemitone(key.tonic);
  if (root === null) throw new EditError(`조성 ${key.tonic} 을 모른다`);
  const scale = (key.mode === 'minor' ? MINOR : MAJOR).map((s) => (s + root) % 12);
  return mapSelected(project, ids, (note) => {
    const midi = note.pitch.midi;
    for (let d = 0; d <= 6; d++) {
      for (const cand of [midi - d, midi + d]) {
        if (scale.includes(((cand % 12) + 12) % 12)) {
          return cand === midi ? note : { ...note, pitch: { ...note.pitch, midi: cand } };
        }
      }
    }
    return note;
  });
}

/** 레가토 — 각 음을 다음 음 시작까지 늘린다. 마지막 음은 그대로. 화음은 같은 시작끼리 함께 */
export function forceLegato(project: Project, ids: readonly NoteId[]): Project {
  const set = new Set(ids);
  return mapSelected(project, ids, (note, all) => {
    const next = all
      .filter((n) => set.has(n.id) && n.startTick > note.startTick)
      .reduce<number | null>((min, n) => (min === null || n.startTick < min ? n.startTick : min), null);
    return next === null ? note : { ...note, lengthTick: next - note.startTick };
  });
}

/** 겹침 없애기 — **같은 음높이**에서 다음 음과 겹치면 거기서 끊는다 (같은 줄을 두 번 누른 소리 방지) */
export function removeOverlaps(project: Project, ids: readonly NoteId[]): Project {
  return mapSelected(project, ids, (note, all) => {
    const next = all
      .filter((n) => n.id !== note.id && n.pitch.midi === note.pitch.midi && n.startTick > note.startTick)
      .reduce<number | null>((min, n) => (min === null || n.startTick < min ? n.startTick : min), null);
    if (next === null || note.startTick + note.lengthTick <= next) return note;
    return { ...note, lengthTick: Math.max(1, next - note.startTick) };
  });
}

/** 세기를 배율로 (1.1 = 10% 세게). 0.01~1 로 자른다 */
export function scaleVelocity(project: Project, ids: readonly NoteId[], factor: number): Project {
  return mapSelected(project, ids, (note) => ({
    ...note,
    velocity: Math.max(0.01, Math.min(1, Math.round(note.velocity * factor * 1000) / 1000)),
  }));
}

/**
 * 사람처럼 — 시작 위치와 세기를 조금 흔든다. **씨앗을 받는다**: 같은 씨앗이면 같은
 * 결과라 되돌리기·다시 실행이 같은 소리를 낸다 (`sound.md` 재현성 원칙).
 */
export function humanize(
  project: Project,
  ids: readonly NoteId[],
  options: { timingTicks: number; velocity: number; seed: number },
): Project {
  let state = (options.seed >>> 0) || 1;
  const rand = () => {
    // xorshift32 — 플랫폼마다 같은 수열
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff * 2 - 1;
  };
  const order = [...ids].sort();
  const offsets = new Map(order.map((id) => [id, { t: rand(), v: rand() }]));
  return mapSelected(project, ids, (note) => {
    const o = offsets.get(note.id)!;
    return {
      ...note,
      startTick: Math.max(0, Math.round(note.startTick + o.t * options.timingTicks)),
      velocity: Math.max(0.01, Math.min(1, Math.round((note.velocity + o.v * options.velocity) * 1000) / 1000)),
    };
  });
}

/**
 * 성부 떼어내기 (Logic "코드 쪼개기" 의 쓸모 있는 형태) — 동시에 시작하는 음 묶음마다
 * 가장 높은(또는 낮은) 음을 **새 트랙**으로 옮긴다. 화음에서 멜로디나 베이스 라인을
 * 뽑아 다른 악기로 돌릴 때 쓴다. 새 트랙은 원래 트랙 바로 아래, 같은 악기.
 */
export function extractVoice(
  project: Project,
  ids: readonly NoteId[],
  which: 'top' | 'bottom',
): { project: Project; trackId: TrackId; moved: number } {
  if (ids.length === 0) throw new EditError('고른 음이 없다');
  const first = findNote(project, ids[0]!);
  if (!first) throw new EditError('음을 찾을 수 없다');
  const { track, clip } = first;
  const set = new Set(ids);
  const picked = clip.notes.filter((n) => set.has(n.id));

  const groups = new Map<number, Note[]>();
  for (const n of picked) groups.set(n.startTick, [...(groups.get(n.startTick) ?? []), n]);
  const chosen = new Set<NoteId>();
  for (const group of groups.values()) {
    if (group.length < 2) continue; // 혼자인 음은 성부가 아니다 — 그대로 둔다
    const sorted = [...group].sort((a, b) => a.pitch.midi - b.pitch.midi);
    chosen.add((which === 'top' ? sorted[sorted.length - 1] : sorted[0])!.id);
  }
  if (chosen.size === 0) throw new EditError('동시에 울리는 음(화음)이 없다');

  const added = addTrack(project, {
    name: `${track.name} ${which === 'top' ? '윗성부' : '아랫성부'}`,
    instrumentId: track.instrumentId,
    toneId: track.toneId,
  });
  const newClip = createClip({ startTick: clip.startTick, lengthTick: clip.lengthTick, label: `${clip.label} ${which === 'top' ? '위' : '아래'}` });
  newClip.notes = clip.notes.filter((n) => chosen.has(n.id)).map((n) => ({ ...structuredClone(n), id: newNoteId() }));

  const tracks = added.project.tracks
    .filter((t) => t.id !== added.trackId)
    .map((t) => (t.id === track.id
      ? { ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, notes: c.notes.filter((n) => !chosen.has(n.id)) } : c)) }
      : t));
  const newTrack = { ...added.project.tracks.find((t) => t.id === added.trackId)!, clips: [newClip], ...(track.stackId ? { stackId: track.stackId } : {}) };
  tracks.splice(tracks.findIndex((t) => t.id === track.id) + 1, 0, newTrack);
  return { project: { ...added.project, tracks }, trackId: added.trackId, moved: chosen.size };
}

// --- 음 하나 숫자로 고치기 · MIDI 변환 (Logic Event List · MIDI Transform, 1-5) ---------

/** 이벤트 목록에서 숫자로 고친다. 길이는 1틱 이상, 세기 0.01~1, 음높이 0~127 */
export function setNoteFields(
  project: Project,
  id: NoteId,
  patch: Partial<{ startTick: number; lengthTick: number; midi: number; cents: number; velocity: number }>,
): Project {
  return mapSelected(project, [id], (note) => ({
    ...note,
    ...(patch.startTick === undefined ? {} : { startTick: Math.max(0, Math.round(patch.startTick)) }),
    ...(patch.lengthTick === undefined ? {} : { lengthTick: Math.max(1, Math.round(patch.lengthTick)) }),
    ...(patch.velocity === undefined ? {} : { velocity: Math.max(0.01, Math.min(1, patch.velocity)) }),
    pitch: {
      midi: patch.midi === undefined ? note.pitch.midi : Math.max(0, Math.min(127, Math.round(patch.midi))),
      cents: patch.cents === undefined ? note.pitch.cents : Math.max(-50, Math.min(50, patch.cents)),
    },
  }));
}

/** MIDI 변환 한 가지. 전부 고른 음에만 */
export type Transform =
  | { kind: 'transpose'; semitones: number }
  | { kind: 'velocity'; mode: 'set' | 'add' | 'scale'; value: number }
  | { kind: 'length'; mode: 'set' | 'scale'; value: number }
  | { kind: 'reverse' }
  | { kind: 'invert'; axis: number }
  | { kind: 'crescendo'; from: number; to: number };

/**
 * MIDI 변환 (Logic MIDI Transform 창의 자주 쓰는 프리셋들).
 * 거꾸로: 고른 음들의 시간 범위 안에서 뒤집는다(끝이 처음으로). 뒤집기(invert): `axis`
 * 를 축으로 음높이를 뒤집는다. 크레셴도: 시작 순서대로 세기를 `from`→`to` 로 고르게.
 */
export function transformNotes(project: Project, ids: readonly NoteId[], t: Transform): Project {
  const set = new Set(ids);
  const picked = project.tracks.flatMap((tr) => tr.clips.flatMap((c) => c.notes.filter((n) => set.has(n.id))));
  if (picked.length === 0) return project;
  const first = Math.min(...picked.map((n) => n.startTick));
  const last = Math.max(...picked.map((n) => n.startTick + n.lengthTick));
  const order = [...picked].sort((a, b) => a.startTick - b.startTick).map((n) => n.id);
  const clampV = (v: number) => Math.max(0.01, Math.min(1, Math.round(v * 1000) / 1000));
  return mapSelected(project, ids, (note) => {
    switch (t.kind) {
      case 'transpose':
        return { ...note, pitch: { ...note.pitch, midi: Math.max(0, Math.min(127, note.pitch.midi + Math.round(t.semitones))) } };
      case 'velocity': {
        const v = t.mode === 'set' ? t.value : t.mode === 'add' ? note.velocity + t.value : note.velocity * t.value;
        return { ...note, velocity: clampV(v) };
      }
      case 'length': {
        const l = t.mode === 'set' ? t.value : note.lengthTick * t.value;
        return { ...note, lengthTick: Math.max(1, Math.round(l)) };
      }
      case 'reverse':
        return { ...note, startTick: first + (last - (note.startTick + note.lengthTick)) };
      case 'invert':
        return { ...note, pitch: { ...note.pitch, midi: Math.max(0, Math.min(127, 2 * t.axis - note.pitch.midi)) } };
      case 'crescendo': {
        const i = order.indexOf(note.id);
        const f = order.length <= 1 ? 1 : i / (order.length - 1);
        return { ...note, velocity: clampV(t.from + (t.to - t.from) * f) };
      }
      default:
        return note;
    }
  });
}

/**
 * 악보 기호 (`PARITY_ROUND2.md` 22) — 고른 음들의 아티큘레이션·성부·가사. `null` 은 지운다.
 */
export function setNoteMarks(
  project: Project,
  ids: readonly NoteId[],
  patch: { articulation?: Articulation | null; voice?: 1 | 2; lyric?: string | null },
): Project {
  return mapSelected(project, ids, (note) => {
    const next = { ...note };
    if (patch.articulation !== undefined) { if (patch.articulation) next.articulation = patch.articulation; else delete next.articulation; }
    if (patch.voice !== undefined) { if (patch.voice === 2) next.voice = 2; else delete next.voice; }
    if (patch.lyric !== undefined) { const l = patch.lyric?.trim(); if (l) next.lyric = l.slice(0, 40); else delete next.lyric; }
    return next;
  });
}

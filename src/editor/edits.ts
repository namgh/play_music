/**
 * 프로젝트 편집 — 전부 순수 함수다. 입력을 바꾸지 않고 새 프로젝트를 돌려준다.
 *
 * UI 컴포넌트 안에서 프로젝트를 직접 뜯어고치지 않는 이유:
 *  - 언두가 성립하려면 편집이 한 곳에 모여 있어야 한다
 *  - **Phase 3 에서 AI 가 부를 대상이 바로 이 함수들이다.** "이 음을 A→B로"가
 *    UI 이벤트 핸들러 안에 묶여 있으면 AI 는 그걸 호출할 수 없다 (`plan.md` 4절 ②)
 *  - 순수 함수라 브라우저 없이 테스트된다
 */

import type { Clip, ClipId, Note, NoteId, Project, Track, TrackId } from '../model/project.ts';
import { createClip, createNote, createTrack } from '../model/factory.ts';
import type { Pitch } from '../model/pitch.ts';
import { detune, normalizePitch, transpose } from '../model/pitch.ts';
import type { Ticks } from '../model/time.ts';
import { quantize } from '../model/time.ts';

export class EditError extends Error {}

// --- 찾기 -------------------------------------------------------------------

export interface NoteLocation {
  track: Track;
  clip: Clip;
  note: Note;
}

export function findNote(project: Project, noteId: NoteId): NoteLocation | null {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const note = clip.notes.find((n) => n.id === noteId);
      if (note) return { track, clip, note };
    }
  }
  return null;
}

export function findClip(project: Project, clipId: ClipId): { track: Track; clip: Clip } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

// --- 내부: 구조적 갱신 --------------------------------------------------------

function mapTracks(project: Project, fn: (track: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map(fn) };
}

function mapClip(project: Project, clipId: ClipId, fn: (clip: Clip) => Clip): Project {
  return mapTracks(project, (track) => ({
    ...track,
    clips: track.clips.map((clip) => (clip.id === clipId ? fn(clip) : clip)),
  }));
}

function mapNotes(project: Project, ids: readonly NoteId[], fn: (note: Note) => Note): Project {
  const set = new Set(ids);
  if (set.size === 0) return project;
  return mapTracks(project, (track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (!clip.notes.some((n) => set.has(n.id))) return clip;
      return { ...clip, notes: clip.notes.map((n) => (set.has(n.id) ? fn(n) : n)) };
    }),
  }));
}

// --- 노트 -------------------------------------------------------------------

export interface AddNoteInput {
  clipId: ClipId;
  /** 클립 시작 기준 */
  startTick: Ticks;
  lengthTick: Ticks;
  midi: number;
  cents?: number;
  velocity?: number;
}

/** 노트 추가. 새 노트의 id 도 같이 돌려준다 — 추가 직후 선택하려면 필요하다 */
export function addNote(project: Project, input: AddNoteInput): { project: Project; noteId: NoteId } {
  const found = findClip(project, input.clipId);
  if (!found) throw new EditError(`클립 ${input.clipId} 없음`);

  const note = createNote({
    startTick: Math.max(0, input.startTick),
    lengthTick: Math.max(1, input.lengthTick),
    midi: input.midi,
    cents: input.cents ?? 0,
    velocity: input.velocity ?? 0.8,
  });

  return {
    project: mapClip(project, input.clipId, (clip) => ({ ...clip, notes: [...clip.notes, note] })),
    noteId: note.id,
  };
}

export function deleteNotes(project: Project, ids: readonly NoteId[]): Project {
  const set = new Set(ids);
  if (set.size === 0) return project;
  return mapTracks(project, (track) => ({
    ...track,
    clips: track.clips.map((clip) => ({ ...clip, notes: clip.notes.filter((n) => !set.has(n.id)) })),
  }));
}

/**
 * 노트를 시간·음정으로 옮긴다.
 *
 * 반음 이동은 `transpose` 를 쓴다 — 센트 미세조정이 보존돼야 한다.
 * 이게 깨지면 "음정을 옮겼는데 내가 맞춰둔 미세조정이 사라졌다"가 된다.
 */
export function moveNotes(
  project: Project,
  ids: readonly NoteId[],
  delta: { ticks?: Ticks; semitones?: number },
): Project {
  const dTicks = delta.ticks ?? 0;
  const dSemis = delta.semitones ?? 0;
  if (dTicks === 0 && dSemis === 0) return project;

  return mapNotes(project, ids, (note) => ({
    ...note,
    startTick: Math.max(0, note.startTick + dTicks),
    pitch: dSemis === 0 ? note.pitch : transpose(note.pitch, dSemis),
  }));
}

export function resizeNotes(project: Project, ids: readonly NoteId[], deltaTicks: Ticks, minTicks: Ticks): Project {
  if (deltaTicks === 0) return project;
  return mapNotes(project, ids, (note) => ({
    ...note,
    lengthTick: Math.max(minTicks, note.lengthTick + deltaTicks),
  }));
}

export function setVelocity(project: Project, ids: readonly NoteId[], velocity: number): Project {
  const v = Math.min(1, Math.max(0, velocity));
  return mapNotes(project, ids, (note) => ({ ...note, velocity: v }));
}

// --- 정밀 음정 편집 (차별점 ①) ------------------------------------------------

/** 센트 미세조정을 절대값으로 지정한다 (다이얼) */
export function setCents(project: Project, ids: readonly NoteId[], cents: number): Project {
  return mapNotes(project, ids, (note) => ({
    ...note,
    pitch: normalizePitch({ midi: note.pitch.midi, cents }),
  }));
}

/** 센트를 상대로 더한다 */
export function nudgeCents(project: Project, ids: readonly NoteId[], deltaCents: number): Project {
  return mapNotes(project, ids, (note) => ({ ...note, pitch: detune(note.pitch, deltaCents) }));
}

/** 음정을 통째로 지정한다. 주파수 직접 입력이 이 경로를 쓴다 */
export function setPitch(project: Project, noteId: NoteId, pitch: Pitch): Project {
  return mapNotes(project, [noteId], (note) => ({ ...note, pitch: normalizePitch(pitch) }));
}

/** 음정 곡선 (글라이드·흔들림). null 을 주면 곡선을 없앤다 */
export function setPitchCurve(project: Project, ids: readonly NoteId[], curve: Note['pitchCurve']): Project {
  return mapNotes(project, ids, (note) => ({ ...note, pitchCurve: curve }));
}

// --- 퀀타이즈 ---------------------------------------------------------------

/** 시작 위치만 그리드에 맞춘다. 길이는 건드리지 않는다 */
export function quantizeNotes(project: Project, ids: readonly NoteId[], gridTicks: Ticks): Project {
  if (gridTicks <= 0) return project;
  return mapNotes(project, ids, (note) => ({
    ...note,
    startTick: Math.max(0, quantize(note.startTick, gridTicks)),
  }));
}

// --- 트랙 · 클립 -------------------------------------------------------------

const TRACK_COLORS = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];

export function addTrack(
  project: Project,
  input: { name: string; instrumentId: string; toneId?: string },
): { project: Project; trackId: TrackId } {
  const track = createTrack({
    name: input.name,
    instrumentId: input.instrumentId,
    ...(input.toneId === undefined ? {} : { toneId: input.toneId }),
    color: TRACK_COLORS[project.tracks.length % TRACK_COLORS.length]!,
  });
  return { project: { ...project, tracks: [...project.tracks, track] }, trackId: track.id };
}

export function deleteTrack(project: Project, trackId: TrackId): Project {
  return { ...project, tracks: project.tracks.filter((t) => t.id !== trackId) };
}

export function updateTrack(project: Project, trackId: TrackId, patch: Partial<Omit<Track, 'id' | 'clips'>>): Project {
  return mapTracks(project, (track) => (track.id === trackId ? { ...track, ...patch } : track));
}

export function addClip(
  project: Project,
  input: { trackId: TrackId; startTick: Ticks; lengthTick: Ticks; label?: string },
): { project: Project; clipId: ClipId } {
  const track = project.tracks.find((t) => t.id === input.trackId);
  if (!track) throw new EditError(`트랙 ${input.trackId} 없음`);

  const overlaps = track.clips.some(
    (c) => input.startTick < c.startTick + c.lengthTick && c.startTick < input.startTick + input.lengthTick,
  );
  if (overlaps) throw new EditError('클립이 겹친다');

  const clip = createClip({
    startTick: input.startTick,
    lengthTick: input.lengthTick,
    ...(input.label === undefined ? {} : { label: input.label }),
  });
  return {
    project: mapTracks(project, (t) =>
      t.id === input.trackId ? { ...t, clips: [...t.clips, clip] } : t,
    ),
    clipId: clip.id,
  };
}

export function deleteClip(project: Project, clipId: ClipId): Project {
  return mapTracks(project, (track) => ({ ...track, clips: track.clips.filter((c) => c.id !== clipId) }));
}

/**
 * 클립 길이 변경. 밖으로 나간 음은 **지우지 않는다** —
 * 실수로 줄였을 때 음이 사라지면 언두 말고는 복구할 방법이 없다.
 * 재생 시 스케줄러가 클립 끝에서 자른다.
 */
export function resizeClip(project: Project, clipId: ClipId, lengthTick: Ticks): Project {
  return mapClip(project, clipId, (clip) => ({ ...clip, lengthTick: Math.max(1, lengthTick) }));
}

export function setTempo(project: Project, bpm: number): Project {
  return { ...project, tempo: { ...project.tempo, bpm: Math.min(300, Math.max(20, bpm)) } };
}

export function setProjectName(project: Project, name: string): Project {
  return { ...project, name };
}

export function setLengthBars(project: Project, bars: number): Project {
  return { ...project, lengthBars: Math.max(1, Math.round(bars)) };
}

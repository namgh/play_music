/**
 * 프로젝트 편집 — 전부 순수 함수다. 입력을 바꾸지 않고 새 프로젝트를 돌려준다.
 *
 * UI 컴포넌트 안에서 프로젝트를 직접 뜯어고치지 않는 이유:
 *  - 언두가 성립하려면 편집이 한 곳에 모여 있어야 한다
 *  - **Phase 3 에서 AI 가 부를 대상이 바로 이 함수들이다.** "이 음을 A→B로"가
 *    UI 이벤트 핸들러 안에 묶여 있으면 AI 는 그걸 호출할 수 없다 (`plan.md` 4절 ②)
 *  - 순수 함수라 브라우저 없이 테스트된다
 */

import type {
  Clip, ClipId, LoopRegion, MusicalKey, Note, NoteId, Project, Track, TrackId,
} from '../model/project.ts';
import { createClip, createNote, createTrack, newNoteId } from '../model/factory.ts';
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

// --- 복사 · 붙여넣기 · 복제 ---------------------------------------------------
//
// 작곡의 대부분은 반복과 변형이다. 4마디를 만들어 복사해서 조금 바꾸는 게 기본
// 흐름이고, 이게 없으면 3분짜리 곡을 전부 손으로 그려야 한다.
//
// OS 클립보드를 쓰지 않는다 — 권한·비동기·형식 협상이 붙고, 그 대가로 얻는 것은
// 탭 사이 붙여넣기뿐이다. 앱 안 클립보드로 시작하고 필요하면 나중에 확장한다.

/**
 * 복사할 음들을 떼어 낸다. `startTick` 을 **가장 이른 음 기준 상대값**으로 바꾼다 —
 * 절대 위치로 들고 있으면 어디에 붙여도 원래 자리로 돌아간다.
 */
export function copyNotes(project: Project, ids: readonly NoteId[]): Note[] {
  const set = new Set(ids);
  const picked: Note[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      for (const note of clip.notes) if (set.has(note.id)) picked.push(note);
    }
  }
  if (picked.length === 0) return [];

  const origin = Math.min(...picked.map((n) => n.startTick));
  return picked
    .map((note) => ({ ...note, startTick: note.startTick - origin }))
    .sort((a, b) => a.startTick - b.startTick);
}

/**
 * 클립보드의 음들을 `atTick` 에 붙인다. **id 를 새로 발급한다** —
 * 같은 id 가 두 개면 언두·선택·AI 지시가 어느 쪽을 가리키는지 알 수 없다.
 *
 * 붙여넣은 음의 id 도 돌려준다. 붙인 직후 선택 상태로 만들려면 필요하다.
 */
export function pasteNotes(
  project: Project,
  clipId: ClipId,
  notes: readonly Note[],
  atTick: Ticks,
): { project: Project; noteIds: NoteId[] } {
  if (notes.length === 0) return { project, noteIds: [] };
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);

  const fresh = notes.map((note) => ({
    ...note,
    id: newNoteId(),
    startTick: Math.max(0, atTick + note.startTick),
    // 곡선은 값 객체라 얕은 복사로 공유된다. 한쪽을 고치면 다른 쪽도 바뀌므로 떼어 낸다
    pitchCurve: note.pitchCurve === null ? null : structuredCloneCurve(note.pitchCurve),
    pitch: { ...note.pitch },
  }));

  return {
    project: mapClip(project, clipId, (clip) => ({ ...clip, notes: [...clip.notes, ...fresh] })),
    noteIds: fresh.map((n) => n.id),
  };
}

/** 곡선을 깊이 복사한다. `structuredClone` 은 Node 타입 스트리핑 환경에서 쓰지 않는다 */
function structuredCloneCurve(curve: NonNullable<Note['pitchCurve']>): NonNullable<Note['pitchCurve']> {
  return {
    glide: curve.glide === null ? null : { ...curve.glide },
    vibrato: curve.vibrato === null ? null : { ...curve.vibrato },
    points: curve.points === null ? null : curve.points.map((p) => ({ ...p })),
  };
}

/**
 * 선택한 음을 바로 뒤에 복제한다 (⌘D). 붙여넣기와 달리 위치를 고르지 않는다 —
 * 선택 구간의 길이만큼 밀어 놓는다. 리듬을 반복할 때 가장 빠른 조작이다.
 */
export function duplicateNotes(
  project: Project,
  ids: readonly NoteId[],
): { project: Project; noteIds: NoteId[] } {
  // 선택이 여러 클립에 걸쳐 있으면 **첫 음의 클립만** 다룬다. 클립마다 시간 원점이
  // 달라서 한 번에 옮기면 상대 위치가 깨진다 (피아노롤은 한 클립만 편집한다)
  const located = ids.map((id) => findNote(project, id)).filter((at) => at !== null);
  if (located.length === 0) return { project, noteIds: [] };

  const clipId = located[0]!.clip.id;
  const same = located.filter((at) => at.clip.id === clipId);

  const first = Math.min(...same.map((at) => at.note.startTick));
  // 선택 구간의 끝 = 가장 늦게 끝나는 음. 겹치지 않게 그 뒤에 놓는다
  const end = Math.max(...same.map((at) => at.note.startTick + at.note.lengthTick));
  const span = Math.max(1, end - first);

  const copied = copyNotes(project, same.map((at) => at.note.id));
  return pasteNotes(project, clipId, copied, first + span);
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

// --- 루프 · 조성 -------------------------------------------------------------

/**
 * 반복 구간을 정한다. `null` 이면 루프를 없앤다.
 *
 * 두 틱을 **정렬해서** 담는다 — 사용자가 오른쪽에서 왼쪽으로 드래그해도 유효한
 * 구간이어야 한다. 길이가 0 이면 루프를 버린다: 길이 0 구간을 반복하면
 * 재생이 멈춘 것처럼 보이고 원인을 찾기 어렵다.
 */
export function setLoop(project: Project, loop: LoopRegion | null): Project {
  if (loop === null) return { ...project, loop: null };

  const startTick = Math.max(0, Math.min(loop.startTick, loop.endTick));
  const endTick = Math.max(0, Math.max(loop.startTick, loop.endTick));
  if (endTick <= startTick) return { ...project, loop: null };

  return { ...project, loop: { startTick, endTick, enabled: loop.enabled } };
}

/** 루프 구간은 그대로 두고 켜고 끈다 — 껐다고 구간을 버리면 다시 잡아야 한다 */
export function setLoopEnabled(project: Project, enabled: boolean): Project {
  if (project.loop === null) return project;
  return { ...project, loop: { ...project.loop, enabled } };
}

/** 조성. 렌더에는 영향이 없고 피아노롤 스케일 표시와 AI 힌트에 쓰인다 */
export function setKey(project: Project, key: MusicalKey | null): Project {
  return { ...project, key };
}

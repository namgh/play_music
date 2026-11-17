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
  AutomationPoint, Clip, ClipId, LoopRegion, MusicalKey, Note, NoteId, Project, Track, TrackId,
} from '../model/project.ts';
import { createClip, createNote, createTrack, newClipId, newNoteId, newTrackId } from '../model/factory.ts';
import type { Pitch } from '../model/pitch.ts';
import { detune, normalizePitch, transpose } from '../model/pitch.ts';
import type { Ticks } from '../model/time.ts';
import { quantize, secondsToTicks, ticksToSeconds } from '../model/time.ts';

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

/**
 * 음을 **새 id 로, 깊이** 복사한다.
 *
 * 필드를 하나씩 옮겨 적지 않는다 — 전에 복제가 그렇게 돼 있어서 나중에 생긴
 * `expression`(팜뮤트)이 복제본에서 조용히 빠졌다. 통째로 복제하면 필드가 늘어도
 * 따라온다. 얕은 복사는 안 된다: 복제본의 곡선을 고칠 때 원본도 바뀐다
 * (`HANDOFF.md` 16번).
 */
function cloneNote(note: Note, startTick: Ticks = note.startTick): Note {
  return { ...structuredClone(note), id: newNoteId(), startTick };
}

/** 클립을 새 id 로 깊이 복사해 `startTick` 에 놓는다 */
function cloneClip(clip: Clip, startTick: Ticks): Clip {
  return {
    ...structuredClone(clip),
    id: newClipId(),
    startTick,
    notes: clip.notes.map((note) => cloneNote(note)),
  };
}

function overlapsAny(clips: readonly Clip[], startTick: Ticks, lengthTick: Ticks): boolean {
  return clips.some((c) => startTick < c.startTick + c.lengthTick && c.startTick < startTick + lengthTick);
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

/**
 * 팜뮤트 등 뮤트 주법의 세기 (`SONGCRAFT.md` 6번). 0 이면 `expression.mute` 자체를
 * 지운다 — `null` 로 남기지 않으면 "뮤트 0"과 "뮤트를 안 켰다"가 저장 파일에서
 * 구분이 안 돼 나중에 원인을 못 찾는다.
 */
export function setMute(project: Project, ids: readonly NoteId[], mute: number): Project {
  const m = Math.min(1, Math.max(0, mute));
  return mapNotes(project, ids, (note) => {
    if (m === 0) {
      if (!note.expression?.mute) return note;
      const { mute: _drop, ...rest } = note.expression;
      const expression = Object.keys(rest).length === 0 ? null : rest;
      return { ...note, expression };
    }
    return { ...note, expression: { ...note.expression, mute: m } };
  });
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

/**
 * 선택한 음을 **다른 트랙으로** 옮긴다 (`ROADMAP.md` P1).
 *
 * 드럼 트랙에 잘못 찍었을 때 지우고 다시 찍는 수밖에 없었다.
 *
 * 음의 `startTick` 은 **클립 기준**이므로 곡 전체 위치를 유지하려면 두 클립의
 * 시작 차이만큼 보정해야 한다. 이걸 빼먹으면 음이 엉뚱한 마디로 간다.
 */
export function moveNotesToTrack(
  project: Project,
  ids: readonly NoteId[],
  targetTrackId: TrackId,
): Project {
  if (ids.length === 0) return project;
  const target = project.tracks.find((t) => t.id === targetTrackId);
  if (!target) throw new EditError(`트랙 ${targetTrackId} 없음`);

  const moving: { note: Note; absoluteTick: Ticks }[] = [];
  for (const id of ids) {
    const found = findNote(project, id);
    if (!found) continue;
    if (found.track.id === targetTrackId) continue;
    moving.push({ note: found.note, absoluteTick: found.clip.startTick + found.note.startTick });
  }
  if (moving.length === 0) return project;

  // 옮길 음마다 **그 시각을 덮는 클립**을 찾는다. 없으면 실패시킨다 —
  // 조용히 아무 클립에나 넣으면 음이 엉뚱한 마디에서 울린다
  const placed = moving.map(({ note, absoluteTick }) => {
    const clip = target.clips.find(
      (c) => absoluteTick >= c.startTick && absoluteTick < c.startTick + c.lengthTick,
    );
    if (!clip) throw new EditError('옮길 자리에 클립이 없다');
    return { clipId: clip.id, note: { ...note, startTick: absoluteTick - clip.startTick } };
  });

  const movedIds = new Set(moving.map((m) => m.note.id));
  return mapTracks(project, (track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      const kept = clip.notes.filter((n) => !movedIds.has(n.id));
      const incoming = track.id === targetTrackId
        ? placed.filter((p) => p.clipId === clip.id).map((p) => p.note)
        : [];
      if (kept.length === clip.notes.length && incoming.length === 0) return clip;
      return { ...clip, notes: [...kept, ...incoming] };
    }),
  }));
}

/**
 * 클립을 옮긴다 (`ROADMAP.md` P1).
 *
 * 이게 없어서 **곡 구조를 못 짰다** — A-B-A 를 만들려면 클립을 옮기고 복제하는 것이
 * 기본인데, 지금까지는 음을 하나하나 복사해 붙이는 수밖에 없었다.
 *
 * 같은 트랙 안에서도, 다른 트랙으로도 옮긴다. 겹치면 실패시킨다 — 조용히 밀어 주면
 * 사용자가 놓은 자리와 다른 곳에 붙는다.
 */
export function moveClip(
  project: Project,
  clipId: ClipId,
  target: { startTick?: Ticks; trackId?: TrackId },
): Project {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);

  const startTick = Math.max(0, Math.round(target.startTick ?? found.clip.startTick));
  const trackId = target.trackId ?? found.track.id;
  const destination = project.tracks.find((t) => t.id === trackId);
  if (!destination) throw new EditError(`트랙 ${trackId} 없음`);

  const collides = destination.clips.some(
    (c) => c.id !== clipId
      && startTick < c.startTick + c.lengthTick
      && c.startTick < startTick + found.clip.lengthTick,
  );
  if (collides) throw new EditError('클립이 겹친다');

  const moved: Clip = { ...found.clip, startTick };
  return mapTracks(project, (track) => {
    // 원래 트랙에서 빼고
    const without = track.clips.filter((c) => c.id !== clipId);
    // 목적지에 넣는다. 같은 트랙이면 위 두 줄이 그대로 제자리 이동이 된다
    if (track.id === trackId) return { ...track, clips: [...without, moved] };
    if (track.clips.length !== without.length) return { ...track, clips: without };
    return track;
  });
}

/**
 * 클립을 복제해 **바로 뒤에** 놓는다. 후렴 반복을 만드는 기본 동작이다.
 *
 * 음 id 를 전부 새로 발급하고 곡선을 깊이 복사한다 — 얕은 복사면 한쪽을 고칠 때
 * 원본도 바뀐다 (`HANDOFF.md` 16번, 붙여넣기에서 실제로 났던 버그).
 */
export function duplicateClip(
  project: Project,
  clipId: ClipId,
): { project: Project; clipId: ClipId } {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const { track, clip } = found;

  const startTick = clip.startTick + clip.lengthTick;
  const collides = track.clips.some(
    (c) => startTick < c.startTick + c.lengthTick && c.startTick < startTick + clip.lengthTick,
  );
  if (collides) throw new EditError('뒤에 놓을 자리가 없다');

  const duplicated = cloneClip(clip, startTick);

  return {
    project: mapTracks(project, (t) => (
      t.id === track.id ? { ...t, clips: [...t.clips, duplicated] } : t
    )),
    clipId: duplicated.id,
  };
}

/**
 * 클립을 `atTick`(곡 기준)에서 둘로 나눈다 — Logic 의 "재생 헤드에서 나누기".
 *
 * 경계에 걸친 음은 **왼쪽에 길이 그대로 둔다.** 자르지 않는다 — 스케줄러가 클립
 * 끝에서 끊어 주므로 소리는 같고(`resizeClip` 과 같은 규칙), 다시 합치면 원래
 * 음이 그대로 돌아온다. 여기서 길이를 깎으면 나누기-합치기가 왕복이 안 된다.
 */
export function splitClip(
  project: Project,
  clipId: ClipId,
  atTick: Ticks,
): { project: Project; leftId: ClipId; rightId: ClipId } {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const { track, clip } = found;

  const offset = Math.round(atTick) - clip.startTick;
  if (offset <= 0 || offset >= clip.lengthTick) throw new EditError('나눌 위치가 클립 안에 있어야 한다');

  const left: Clip = {
    ...clip,
    lengthTick: offset,
    notes: clip.notes.filter((n) => n.startTick < offset),
  };
  const right: Clip = {
    ...clip,
    id: newClipId(),
    startTick: clip.startTick + offset,
    lengthTick: clip.lengthTick - offset,
    // 오디오는 에셋의 시작 자리를 그만큼 민다 — 나눈 두 조각이 이어 들려야 한다
    ...(clip.audio ? {
      audio: {
        ...clip.audio,
        offsetSec: clip.audio.offsetSec + (ticksToSeconds(clip.startTick + offset, project.tempo) - ticksToSeconds(clip.startTick, project.tempo)),
      },
    } : {}),
    // 오른쪽 음은 **id 를 유지한다** — 나눴다고 선택·언두가 끊기면 안 된다
    notes: clip.notes
      .filter((n) => n.startTick >= offset)
      .map((n) => ({ ...n, startTick: n.startTick - offset })),
  };

  return {
    project: mapTracks(project, (t) => (
      t.id === track.id
        ? { ...t, clips: t.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])) }
        : t
    )),
    leftId: left.id,
    rightId: right.id,
  };
}

/**
 * 같은 트랙의 클립 여럿을 하나로 합친다 — Logic 의 "합치기(Join)".
 *
 * 맨 앞 클립이 남고(id·이름·잠금) 나머지의 음이 그 안으로 들어온다. 사이가 떠
 * 있으면 빈 채로 이어 붙는다. **고르지 않은 클립이 그 사이에 끼어 있으면 실패** —
 * 합친 클립이 그 위를 덮게 된다.
 */
export function joinClips(
  project: Project,
  clipIds: readonly ClipId[],
): { project: Project; clipId: ClipId } {
  const ids = new Set(clipIds);
  if (ids.size < 2) throw new EditError('합치려면 클립이 둘 이상이어야 한다');

  const track = project.tracks.find((t) => t.clips.some((c) => ids.has(c.id)));
  if (!track) throw new EditError('클립을 찾을 수 없다');
  const picked = track.clips.filter((c) => ids.has(c.id)).sort((a, b) => a.startTick - b.startTick);
  if (picked.length !== ids.size) throw new EditError('다른 트랙의 클립은 합칠 수 없다');
  if (picked.some((c) => c.locked)) throw new EditError('잠긴 클립은 합칠 수 없다');

  const first = picked[0]!;
  const start = first.startTick;
  const end = Math.max(...picked.map((c) => c.startTick + c.lengthTick));
  const between = track.clips.some(
    (c) => !ids.has(c.id) && c.startTick < end && start < c.startTick + c.lengthTick,
  );
  if (between) throw new EditError('사이에 다른 클립이 있다');

  const merged: Clip = {
    ...first,
    lengthTick: end - start,
    notes: picked
      .flatMap((c) => c.notes.map((n) => ({ ...n, startTick: n.startTick + (c.startTick - start) })))
      .sort((a, b) => a.startTick - b.startTick),
  };

  return {
    project: mapTracks(project, (t) => (
      t.id === track.id
        ? { ...t, clips: t.clips.flatMap((c) => (c.id === first.id ? [merged] : ids.has(c.id) ? [] : [c])) }
        : t
    )),
    clipId: merged.id,
  };
}

/** 같은 트랙에서 바로 다음에 오는 클립. 없으면 null */
export function nextClipOnTrack(project: Project, clipId: ClipId): Clip | null {
  const found = findClip(project, clipId);
  if (!found) return null;
  const after = found.track.clips
    .filter((c) => c.startTick > found.clip.startTick)
    .sort((a, b) => a.startTick - b.startTick);
  return after[0] ?? null;
}

/**
 * 클립을 뒤로 `count` 번 되풀이한다 — Logic 의 "반복(Repeat)".
 *
 * `untilTick` 을 주면 거기를 넘지 않는 만큼만 놓는다(곡 끝까지 채우기). 자리가
 * 모자라면 **들어가는 데까지만** 놓고 몇 개 놓았는지 돌려준다. 하나도 못 놓으면 실패.
 */
export function repeatClip(
  project: Project,
  clipId: ClipId,
  options: { count?: number; untilTick?: Ticks },
): { project: Project; clipIds: ClipId[] } {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const { track, clip } = found;

  const limit = Math.max(0, Math.floor(options.count ?? Number.MAX_SAFE_INTEGER));
  const until = options.untilTick ?? Number.POSITIVE_INFINITY;
  if (options.count === undefined && options.untilTick === undefined) {
    throw new EditError('횟수나 끝 위치를 정해야 한다');
  }

  const copies: Clip[] = [];
  let startTick = clip.startTick + clip.lengthTick;
  while (copies.length < limit && startTick + clip.lengthTick <= until) {
    if (overlapsAny(track.clips, startTick, clip.lengthTick)) break;
    copies.push(cloneClip(clip, startTick));
    startTick += clip.lengthTick;
  }
  if (copies.length === 0) throw new EditError('뒤에 놓을 자리가 없다');

  return {
    project: mapTracks(project, (t) => (t.id === track.id ? { ...t, clips: [...t.clips, ...copies] } : t)),
    clipIds: copies.map((c) => c.id),
  };
}

/**
 * 트랙을 통째로 복제해 **바로 아래**에 놓는다. 악기·음색·이펙트·오토메이션·클립 전부.
 * 겹쳐 쌓거나(더블링) 한 옥타브 올린 성부를 만들 때 쓰는 기본 동작이다.
 */
export function duplicateTrack(
  project: Project,
  trackId: TrackId,
): { project: Project; trackId: TrackId } {
  const index = project.tracks.findIndex((t) => t.id === trackId);
  const track = project.tracks[index];
  if (!track) throw new EditError(`트랙 ${trackId} 없음`);

  const copy: Track = {
    ...structuredClone(track),
    id: newTrackId(),
    name: `${track.name} 복사`,
    // 솔로까지 따라오면 복제하는 순간 다른 트랙이 전부 꺼진 것처럼 들린다
    solo: false,
    clips: track.clips.map((clip) => cloneClip(clip, clip.startTick)),
  };
  const tracks = [...project.tracks];
  tracks.splice(index + 1, 0, copy);
  return { project: { ...project, tracks }, trackId: copy.id };
}

/** 트랙 순서를 바꾼다. `toIndex` 는 옮긴 뒤의 자리이고 범위 밖이면 끝에 붙인다 */
export function moveTrack(project: Project, trackId: TrackId, toIndex: number): Project {
  const from = project.tracks.findIndex((t) => t.id === trackId);
  if (from < 0) throw new EditError(`트랙 ${trackId} 없음`);
  const to = Math.max(0, Math.min(project.tracks.length - 1, Math.round(toIndex)));
  if (to === from) return project;
  const tracks = [...project.tracks];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(to, 0, moved!);
  return { ...project, tracks };
}

/** 클립 이름·뮤트·색·잠금을 바꾼다 */
export function updateClip(
  project: Project,
  clipId: ClipId,
  patch: Partial<Pick<Clip, 'label' | 'muted' | 'color' | 'locked'>>,
): Project {
  if (!findClip(project, clipId)) throw new EditError(`클립 ${clipId} 없음`);
  return mapClip(project, clipId, (clip) => {
    const next: Clip = { ...clip, ...patch };
    // 꺼진 뮤트·기본 색은 키를 지운다 — 옛 파일과 같은 모양으로 저장된다
    if (next.muted === false) delete next.muted;
    if (next.color === null) delete next.color;
    return next;
  });
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

/**
 * 템포 변화 지점을 넣거나 지운다 (`ROADMAP.md` P2).
 *
 * `bpm` 이 null 이면 그 지점의 변화를 없앤다. 틱 0 은 시작 템포라 `setTempo` 가 맡는다.
 */
export function setTempoChange(project: Project, tick: Ticks, bpm: number | null): Project {
  const at = Math.max(0, Math.round(tick));
  if (at === 0) {
    if (bpm === null) return project;
    return setTempo(project, bpm);
  }
  const rest = (project.tempo.changes ?? []).filter((c) => c.tick !== at);
  const changes = bpm === null || !(bpm > 0)
    ? rest
    : [...rest, { tick: at, bpm }].sort((a, b) => a.tick - b.tick);
  return { ...project, tempo: { ...project.tempo, changes } };
}

/**
 * 스윙 (`ROADMAP.md` P2) — 짝수 번째 격자를 뒤로 민다.
 *
 * **프로젝트에 저장한다.** 곡의 성격이지 보기 설정이 아니다 — 파일을 다시 열었을 때
 * 그루브가 사라지면 다른 곡이 된다.
 */
export function setSwing(project: Project, amount: number): Project {
  return { ...project, swing: Math.max(0, Math.min(0.75, amount)) };
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

// --- 오토메이션 ---------------------------------------------------------------

/** 트랙의 볼륨 레인을 통째로 바꾼다 — 페이드인·아웃, 손으로 그린 곡선이 이걸 쓴다 */
export function setVolumeAutomation(
  project: Project,
  trackId: TrackId,
  points: readonly AutomationPoint[],
): Project {
  const sorted = [...points].sort((a, b) => a.tick - b.tick);
  return updateTrack(project, trackId, { automation: [{ target: 'volume', points: sorted }] });
}

/** 트랙에서 볼륨 오토메이션을 지운다 — 다시 예전과 같은 소리로 돌아간다 */
export function clearVolumeAutomation(project: Project, trackId: TrackId): Project {
  return updateTrack(project, trackId, { automation: [] });
}

export interface SidechainDuckOptions {
  /** 눌리는 깊이. 0(안 눌림)~1(무음까지) */
  depth: number;
  /** 트리거부터 최저점까지 걸리는 시간 */
  attackMs?: number;
  /** 최저점부터 원래 크기로 돌아오는 시간 */
  releaseMs?: number;
}

/**
 * 사이드체인 덕킹 — "킥에 맞춰 패드·베이스가 눌리는 것" (`SONGCRAFT.md`).
 *
 * 실제 오디오를 분석해 반응하는 사이드체인 컴프레서를 새로 만들지 않는다.
 * 트리거 트랙(보통 킥)의 노트온 시각마다 눌렸다 돌아오는 볼륨 곡선을
 * **미리 계산해** 대상 트랙의 볼륨 오토메이션으로 굳힌다 — 곡이 정해지면
 * 결과도 정해지므로 미리듣기와 내보내기가 항상 같다 (`plan.md` 5-2).
 *
 * **대상 트랙의 기존 볼륨 오토메이션을 통째로 덮어쓴다.** 손으로 그린 페이드와
 * 합성하는 것은 별도 스코프다 — 지금은 "이 트랙은 이 트리거로 덕킹된다" 하나만
 * 표현한다.
 */
/** 트랙 안 모든 음의 곡 절대 틱(클립 시작 + 음 시작), 오름차순 */
function noteOnTicks(track: Track): Ticks[] {
  const ticks: Ticks[] = [];
  for (const clip of track.clips) {
    for (const note of clip.notes) ticks.push(clip.startTick + note.startTick);
  }
  return ticks.sort((a, b) => a - b);
}

/**
 * 트리거 시각마다 "그대로 → 최저점 → 복귀" 세 점을 만든다 — **다음 트리거 전에
 * 원래 크기로 돌아온다.** 덕킹이 쓴다: 킥과 킥 사이에는 패드가 다시 커져야 한다.
 */
function dipAndReturnPoints(
  triggerTicks: readonly Ticks[],
  tempo: Project['tempo'],
  floor: number,
  attackMs: number,
  holdMs: number,
): AutomationPoint[] {
  const points: AutomationPoint[] = [];
  for (const tick of triggerTicks) {
    const tSec = ticksToSeconds(tick, tempo);
    const dipTick = secondsToTicks(tSec + attackMs / 1000, tempo);
    const releaseTick = secondsToTicks(tSec + (attackMs + holdMs) / 1000, tempo);
    points.push({ tick, value: 1 }, { tick: dipTick, value: floor }, { tick: releaseTick, value: 1 });
  }
  return points;
}

/**
 * 트리거 시각마다 "열림(1) → 닫힘(floor)" 두 점을 만들고, **다음 트리거가 열 때까지
 * 닫힌 채로 둔다.** 게이트가 쓴다: 게이트는 다시 열어 줄 다음 노트가 없으면
 * 닫힌 채로 남아 있는 것이 맞다 — 덕킹처럼 스스로 원상복귀하지 않는다.
 */
function gateClosePoints(
  triggerTicks: readonly Ticks[],
  tempo: Project['tempo'],
  floor: number,
  holdMs: number,
  releaseMs: number,
): AutomationPoint[] {
  const points: AutomationPoint[] = [];
  for (const tick of triggerTicks) {
    const tSec = ticksToSeconds(tick, tempo);
    const closeTick = secondsToTicks(tSec + (holdMs + releaseMs) / 1000, tempo);
    points.push({ tick, value: 1 }, { tick: closeTick, value: floor });
  }
  return points;
}

export function applySidechainDuck(
  project: Project,
  triggerTrackId: TrackId,
  targetTrackId: TrackId,
  options: SidechainDuckOptions,
): Project {
  const trigger = project.tracks.find((t) => t.id === triggerTrackId);
  if (!trigger) throw new EditError(`트랙을 찾을 수 없다: ${triggerTrackId}`);
  if (!project.tracks.some((t) => t.id === targetTrackId)) {
    throw new EditError(`트랙을 찾을 수 없다: ${targetTrackId}`);
  }

  const depth = Math.max(0, Math.min(1, options.depth));
  const attackMs = Math.max(0, options.attackMs ?? 30);
  const releaseMs = Math.max(0, options.releaseMs ?? 120);

  const points = dipAndReturnPoints(noteOnTicks(trigger), project.tempo, 1 - depth, attackMs, releaseMs);
  return setVolumeAutomation(project, targetTrackId, points);
}

export interface GateEnvelopeOptions {
  /** 노트온부터 이 시간까지는 그대로 열려 있다 — 트랜지언트와 리버브 초반을 살린다 */
  holdMs?: number;
  /** hold 뒤 여기까지 걸쳐 최저치로 떨어진다. 짧을수록 "퍽!" 하고 끊기는 느낌이 난다 */
  releaseMs?: number;
  /** 완전 무음(0)이 아니라 살짝 남겨 부자연스러운 디지털 무음을 피한다 */
  floor?: number;
}

/**
 * 게이트 스네어 — "80년대 사운드의 정체"(`SONGCRAFT.md`).
 *
 * 실시간 오디오를 문턱값으로 여닫는 진짜 노이즈 게이트를 새로 만들지 않는다.
 * 이 엔진은 음이 언제 시작하는지 이미 알고 있으므로(사후 분석이 아니라 스케줄된
 * 이벤트다) 노트온마다 "열림 → 유지 → 급격히 닫힘" 곡선을 미리 계산해 **같은
 * 트랙**의 오토메이션으로 굳힌다 — 트리거와 대상이 같다는 점만 `applySidechainDuck`
 * 과 다르다.
 *
 * **리버브 뒤에 걸려야 뜻이 있다.** 리버브 앞에 걸면 리버브로 들어가는 입력만
 * 줄어들 뿐 이미 만들어진 웨트 꼬리는 그대로 울린다 — 렌더러가 오토메이션을
 * 이펙트 뒤(`workletRenderer.ts`)에 배선해 둔 이유가 이것이다.
 */
export function applyGateEnvelope(
  project: Project,
  trackId: TrackId,
  options: GateEnvelopeOptions,
): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`트랙을 찾을 수 없다: ${trackId}`);

  const holdMs = Math.max(0, options.holdMs ?? 60);
  const releaseMs = Math.max(1, options.releaseMs ?? 40);
  const floor = Math.max(0, Math.min(1, options.floor ?? 0.05));

  const points = gateClosePoints(noteOnTicks(track), project.tempo, floor, holdMs, releaseMs);
  return setVolumeAutomation(project, trackId, points);
}

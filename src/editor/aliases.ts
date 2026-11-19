/**
 * 리전 에일리어스 (Logic Region Alias, `PARITY_ROUND2.md` 10) — 원본을 고치면 같이 바뀌는 복사.
 *
 * 재생·내보내기·피아노 롤은 언제나 `clip.notes` 만 본다. 그래서 에일리어스의 `notes` 를 **원본에서 다시 채워**
 * 두는 것으로 끝낸다 — 편집기의 commit/preview 가 `syncAliases(앞, 뒤)` 를 부른다.
 *  - 원본을 고치면 → 에일리어스들이 따라온다
 *  - 에일리어스를 고치면 → 그 고침이 **원본으로 올라가고** 나머지 에일리어스도 따라온다 (어느 쪽을 고쳐도 같다)
 *  - 원본을 지우면 → 에일리어스는 그때의 음을 가진 보통 클립이 된다
 * 음 id 는 클립마다 달라야 한다(선택·스케줄러 열쇠) — 에일리어스 쪽은 `원본 id~클립 꼬리` 로 정해서 매번 같다.
 */

import type { Clip, ClipId, Note, NoteId, Project, TrackId } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { newClipId, newNoteId } from '../model/factory.ts';
import { EditError, findClip } from './edits.ts';

const SEP = '~';

function aliasNoteId(sourceId: NoteId, aliasClip: ClipId): NoteId {
  return `${sourceId}${SEP}${aliasClip.slice(4)}` as NoteId;
}

function sourceNoteId(id: NoteId): NoteId {
  const i = id.indexOf(SEP);
  return (i < 0 ? id : id.slice(0, i)) as NoteId;
}

function mirror(source: Clip, alias: Clip): Clip {
  // 오디오 클립: 음 대신 오디오 구간(에셋·다듬기·게인·페이드)과 길이를 따른다 (`PARITY_ROUND2.md` 19)
  if (source.audio) return { ...alias, notes: [], lengthTick: source.lengthTick, audio: { ...source.audio } };
  return { ...alias, notes: source.notes.map((n) => ({ ...n, id: aliasNoteId(n.id, alias.id) })) };
}

/** 에일리어스 음 → 원본 음 (id 를 되돌린다) */
function unmirror(alias: Clip): Note[] {
  return alias.notes.map((n) => ({ ...n, id: sourceNoteId(n.id) }));
}

function allClips(project: Project): Clip[] {
  return project.tracks.flatMap((t) => t.clips);
}

function mapAllClips(project: Project, fn: (c: Clip) => Clip): Project {
  let changed = false;
  const tracks = project.tracks.map((t) => {
    let tc = false;
    const clips = t.clips.map((c) => { const n = fn(c); if (n !== c) tc = true; return n; });
    if (!tc) return t;
    changed = true;
    return { ...t, clips };
  });
  return changed ? { ...project, tracks } : project;
}

/**
 * 편집 한 번(`before` → `after`) 뒤 에일리어스를 맞춘다. 에일리어스가 하나도 없으면 그대로 돌려준다(싸다).
 */
export function syncAliases(before: Project | null, after: Project): Project {
  const clips = allClips(after);
  if (!clips.some((c) => c.aliasOf)) return after;
  const byId = new Map(clips.map((c) => [c.id, c]));
  const prev = before ? new Map(allClips(before).map((c) => [c.id, c])) : new Map<ClipId, Clip>();

  // 1) 에일리어스에서 고친 것을 원본으로 올린다 (음·오디오 구간이 바뀐 에일리어스 — 마지막 것이 이긴다)
  const pushUp = new Map<ClipId, Partial<Clip>>();
  for (const c of clips) {
    if (!c.aliasOf) continue;
    const old = prev.get(c.id);
    if (!old || !byId.has(c.aliasOf)) continue;
    if (c.audio && old.audio !== c.audio) pushUp.set(c.aliasOf, { audio: { ...c.audio }, lengthTick: c.lengthTick });
    else if (!c.audio && old.notes !== c.notes) pushUp.set(c.aliasOf, { notes: unmirror(c) });
  }
  let next = pushUp.size ? mapAllClips(after, (c) => (pushUp.has(c.id) ? { ...c, ...pushUp.get(c.id)! } : c)) : after;

  // 2) 원본이 없어진 에일리어스는 보통 클립으로, 나머지는 원본에서 다시 채운다
  const sources = new Map(allClips(next).map((c) => [c.id, c]));
  next = mapAllClips(next, (c) => {
    if (!c.aliasOf) return c;
    const src = sources.get(c.aliasOf);
    if (!src) {
      // 원본이 없어졌다 — 그때의 음을 가진 보통 클립으로 (새 id: 원본 id 를 그대로 쓰면 되살린 원본과 부딪힌다)
      const real = { ...c, notes: unmirror(c).map((n) => ({ ...n, id: newNoteId() })) };
      delete real.aliasOf;
      return real;
    }
    if (src.aliasOf) return c; // 에일리어스의 에일리어스는 만들지 않는다 (만들 때 막는다)
    const m = mirror(src, c);
    // 같으면 그대로 — 매번 새 객체를 만들면 화면이 쓸데없이 다시 그린다
    if (src.audio) return JSON.stringify(c.audio) === JSON.stringify(m.audio) && c.lengthTick === m.lengthTick ? c : m;
    return c.notes.length === m.notes.length && c.notes.every((n, i) => JSON.stringify(n) === JSON.stringify(m.notes[i])) ? c : m;
  });
  return next;
}

/** 클립 뒤(같은 트랙, 바로 이어서) 에일리어스를 하나 만든다. 에일리어스를 고르면 그 원본의 에일리어스로 */
export function makeAlias(project: Project, clipId: ClipId, atTick?: Ticks, trackId?: TrackId): { project: Project; clipId: ClipId } {
  const found = findClip(project, clipId);
  if (!found) throw new EditError(`클립 ${clipId} 없음`);
  const source = found.clip.aliasOf ? findClip(project, found.clip.aliasOf)?.clip ?? found.clip : found.clip;
  const target = trackId ? project.tracks.find((t) => t.id === trackId) : found.track;
  if (!target) throw new EditError('트랙 없음');
  const overlap = (at: number) => target.clips.find((c) => at < c.startTick + c.lengthTick && c.startTick < at + source.lengthTick);
  let start = atTick ?? found.clip.startTick + found.clip.lengthTick;
  if (atTick !== undefined) {
    if (overlap(start)) throw new EditError('그 자리에 다른 클립이 있습니다');
  } else {
    // 바로 뒤가 차 있으면 그 뒤의 첫 빈자리로
    for (let hit = overlap(start); hit; hit = overlap(start)) start = hit.startTick + hit.lengthTick;
  }
  const id = newClipId();
  const alias: Clip = mirror(source, {
    ...structuredClone({ ...source, notes: [] as Note[] }),
    id,
    startTick: start,
    label: `${source.label} ↺`,
    aliasOf: source.id,
  });
  delete alias.takes;
  return {
    project: { ...project, tracks: project.tracks.map((t) => (t.id === target.id ? { ...t, clips: [...t.clips, alias] } : t)) },
    clipId: id,
  };
}

/** 에일리어스를 보통 클립으로 (Logic "Turn Alias into Real Copy") */
export function aliasToCopy(project: Project, clipId: ClipId): Project {
  return mapAllClips(project, (c) => {
    if (c.id !== clipId || !c.aliasOf) return c;
    const real = { ...c, notes: unmirror(c).map((n) => ({ ...n, id: newNoteId() })) };
    delete real.aliasOf;
    real.label = real.label.replace(/ ↺$/, '');
    return real;
  });
}

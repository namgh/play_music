/**
 * 곡 구조 편집 — 마커 · 편곡 마커(구간) · 코드 · 박자/조성 변화 · 시간 넣기/빼기.
 *
 * Logic 의 글로벌 트랙과 "간격 넣기/빼기(Insert/Cut Time)"에 대응한다
 * (`LOGIC_PARITY.md` 1-4·1-11). `edits.ts` 와 같은 규칙: **전부 순수 함수**이고
 * 입력을 바꾸지 않는다. Phase 3 에서 AI 가 "코러스를 한 번 더" 같은 지시를
 * 이 함수들로 실행한다.
 *
 * ## 구간 조작은 세 개의 기본 동작으로 만든다
 *
 * `insertTime`(틈 벌리기) · `removeTime`(잘라내고 붙이기) · `copyRange`/`pasteRange`.
 * 구간 복제 = 끝에 틈을 벌리고 복사본을 붙인다. 구간 삭제 = 잘라내고 붙인다.
 * 구간 이동 = 복사 → 잘라내기 → 새 자리에 틈 → 붙이기. 경우마다 따로 짜면
 * 오토메이션이나 코드처럼 "같이 가야 하는 것"을 하나씩 빠뜨린다.
 *
 * 경계에 걸친 클립은 **먼저 경계에서 나눈다** — 그래야 구간 안의 음만 옮겨진다.
 *
 * 박자 변화는 마디 번호로 걸려 있어서 시간과 함께 옮기지 않는다. 구간이 마디
 * 단위면(대부분이다) 같은 박자 안에서는 결과가 같다. 박자가 다른 마디를 가로질러
 * 구간을 옮기면 박자 변화는 제자리에 남는다 — 사용자가 다시 놓아야 한다.
 */

import type {
  AutomationLane, ChordId, ChordQuality, ChordSymbol, Clip, KeyChange, Marker, MarkerId, MusicalKey,
  Project, Section, SectionId, TrackId,
} from '../model/project.ts';
import { newChordId, newClipId, newMarkerId, newNoteId, newSectionId } from '../model/factory.ts';
import { normalizeSignatureChanges, positionAt } from '../model/meter.ts';
import { transposeChord } from '../model/chords.ts';
import type { Ticks, TimeSignature } from '../model/time.ts';
import { EditError, splitClip } from './edits.ts';

// --- 마커 -------------------------------------------------------------------

const byTick = <T extends { tick: Ticks }>(a: T, b: T) => a.tick - b.tick;

export function addMarker(project: Project, tick: Ticks, name?: string): { project: Project; markerId: MarkerId } {
  const markers = project.markers ?? [];
  const marker: Marker = {
    id: newMarkerId(),
    tick: Math.max(0, Math.round(tick)),
    name: name?.trim() || `마커 ${markers.length + 1}`,
  };
  return { project: { ...project, markers: [...markers, marker].sort(byTick) }, markerId: marker.id };
}

export function updateMarker(project: Project, id: MarkerId, patch: Partial<Pick<Marker, 'tick' | 'name'>>): Project {
  const markers = project.markers ?? [];
  if (!markers.some((m) => m.id === id)) throw new EditError(`마커 ${id} 없음`);
  return {
    ...project,
    markers: markers.map((m) => (m.id === id
      ? {
        ...m,
        ...(patch.tick === undefined ? {} : { tick: Math.max(0, Math.round(patch.tick)) }),
        ...(patch.name === undefined ? {} : { name: patch.name.trim() || m.name }),
      }
      : m)).sort(byTick),
  };
}

export function deleteMarker(project: Project, id: MarkerId): Project {
  return { ...project, markers: (project.markers ?? []).filter((m) => m.id !== id) };
}

/** `tick` 보다 뒤(또는 앞)의 가장 가까운 마커. 마커와 구간 시작을 함께 본다 — 둘 다 "가고 싶은 자리"다 */
export function adjacentMarkerTick(project: Project, tick: Ticks, direction: 1 | -1): Ticks | null {
  const stops = [
    ...(project.markers ?? []).map((m) => m.tick),
    ...(project.sections ?? []).map((s) => s.startTick),
  ].sort((a, b) => a - b);
  if (direction === 1) return stops.find((t) => t > tick) ?? null;
  return [...stops].reverse().find((t) => t < tick) ?? null;
}

// --- 구간(편곡 마커) -----------------------------------------------------------

const sectionEnd = (s: Section) => s.startTick + s.lengthTick;

function assertNoSectionOverlap(sections: readonly Section[], candidate: Section): void {
  for (const s of sections) {
    if (s.id === candidate.id) continue;
    if (candidate.startTick < sectionEnd(s) && s.startTick < sectionEnd(candidate)) {
      throw new EditError(`구간 "${s.name}" 과 겹친다`);
    }
  }
}

export function addSection(
  project: Project,
  input: { startTick: Ticks; lengthTick: Ticks; name?: string },
): { project: Project; sectionId: SectionId } {
  const sections = project.sections ?? [];
  if (input.lengthTick <= 0) throw new EditError('구간 길이는 0보다 커야 한다');
  const section: Section = {
    id: newSectionId(),
    startTick: Math.max(0, Math.round(input.startTick)),
    lengthTick: Math.round(input.lengthTick),
    name: input.name?.trim() || SECTION_NAMES[sections.length % SECTION_NAMES.length]!,
  };
  assertNoSectionOverlap(sections, section);
  return {
    project: { ...project, sections: [...sections, section].sort((a, b) => a.startTick - b.startTick) },
    sectionId: section.id,
  };
}

/** 새 구간의 기본 이름 — 대중음악의 흔한 순서 */
export const SECTION_NAMES = ['인트로', '벌스', '프리코러스', '코러스', '벌스 2', '코러스 2', '브리지', '아웃트로'];

export function updateSection(
  project: Project,
  id: SectionId,
  patch: Partial<Pick<Section, 'name' | 'lengthTick' | 'startTick'>>,
): Project {
  const sections = project.sections ?? [];
  const current = sections.find((s) => s.id === id);
  if (!current) throw new EditError(`구간 ${id} 없음`);
  const next: Section = {
    ...current,
    ...(patch.name === undefined ? {} : { name: patch.name.trim() || current.name }),
    ...(patch.startTick === undefined ? {} : { startTick: Math.max(0, Math.round(patch.startTick)) }),
    ...(patch.lengthTick === undefined ? {} : { lengthTick: Math.max(1, Math.round(patch.lengthTick)) }),
  };
  assertNoSectionOverlap(sections, next);
  return {
    ...project,
    sections: sections.map((s) => (s.id === id ? next : s)).sort((a, b) => a.startTick - b.startTick),
  };
}

/** 구간 표시만 지운다 — 안의 음악은 그대로 둔다 */
export function removeSectionMarker(project: Project, id: SectionId): Project {
  return { ...project, sections: (project.sections ?? []).filter((s) => s.id !== id) };
}

function findSection(project: Project, id: SectionId): Section {
  const section = (project.sections ?? []).find((s) => s.id === id);
  if (!section) throw new EditError(`구간 ${id} 없음`);
  return section;
}

/** 구간을 **안의 음악째** 지우고 뒤를 당긴다 (Logic: 편곡 마커 삭제) */
export function deleteSection(project: Project, id: SectionId): Project {
  const section = findSection(project, id);
  return removeTime(project, section.startTick, sectionEnd(section));
}

/** 구간을 안의 음악째 복제해 **바로 뒤에** 끼워 넣는다. 뒤의 것은 그만큼 밀린다 */
export function duplicateSection(project: Project, id: SectionId): { project: Project; sectionId: SectionId } {
  const section = findSection(project, id);
  const end = sectionEnd(section);
  const content = copyRange(project, section.startTick, end);
  const opened = insertTime(project, end, section.lengthTick);
  const pasted = pasteRange(opened, end, content, { freshIds: true });
  const copy = (pasted.sections ?? []).find((s) => s.startTick === end && s.id !== id);
  return { project: pasted, sectionId: copy?.id ?? id };
}

/**
 * 구간을 안의 음악째 `toTick` 으로 옮긴다. 원래 자리는 당겨 닫고, 새 자리는
 * 벌려서 끼운다 — 다른 구간 위에 덮어쓰지 않는다 (Logic 편곡 마커 끌기와 같다).
 * `toTick` 은 **옮기기 전** 좌표다.
 */
export function moveSection(project: Project, id: SectionId, toTick: Ticks): Project {
  const section = findSection(project, id);
  const start = section.startTick;
  const end = sectionEnd(section);
  let target = Math.max(0, Math.round(toTick));
  if (target >= start && target <= end) return project; // 제자리
  const content = copyRange(project, start, end);
  let next = removeTime(project, start, end);
  if (target > end) target -= section.lengthTick;
  next = insertTime(next, target, section.lengthTick);
  return pasteRange(next, target, content, { freshIds: false });
}

/** 이웃 구간과 자리를 바꾼다 — 화살표 버튼용 */
export function swapSectionWithNeighbor(project: Project, id: SectionId, direction: 1 | -1): Project {
  const sections = project.sections ?? [];
  const index = sections.findIndex((s) => s.id === id);
  if (index < 0) throw new EditError(`구간 ${id} 없음`);
  const neighbor = sections[index + direction];
  if (!neighbor) throw new EditError(direction === 1 ? '뒤에 구간이 없다' : '앞에 구간이 없다');
  return direction === 1
    ? moveSection(project, id, sectionEnd(neighbor))
    : moveSection(project, id, neighbor.startTick);
}

// --- 코드 -------------------------------------------------------------------

export function addChord(
  project: Project,
  input: { tick: Ticks; root: string; quality: ChordQuality; bass?: string | null },
): { project: Project; chordId: ChordId } {
  const tick = Math.max(0, Math.round(input.tick));
  // 같은 자리에 코드는 하나 — 다시 놓으면 바꾼다
  const rest = (project.chords ?? []).filter((c) => c.tick !== tick);
  const chord: ChordSymbol = { id: newChordId(), tick, root: input.root, quality: input.quality, bass: input.bass ?? null };
  return { project: { ...project, chords: [...rest, chord].sort(byTick) }, chordId: chord.id };
}

export function updateChord(project: Project, id: ChordId, patch: Partial<Omit<ChordSymbol, 'id'>>): Project {
  const chords = project.chords ?? [];
  if (!chords.some((c) => c.id === id)) throw new EditError(`코드 ${id} 없음`);
  return { ...project, chords: chords.map((c) => (c.id === id ? { ...c, ...patch } : c)).sort(byTick) };
}

export function deleteChord(project: Project, id: ChordId): Project {
  return { ...project, chords: (project.chords ?? []).filter((c) => c.id !== id) };
}

/** 분석 결과 등으로 코드 트랙을 통째로 바꾼다 (`fromTick`~`toTick` 구간만) */
export function replaceChords(
  project: Project,
  chords: readonly Omit<ChordSymbol, 'id'>[],
  range: { fromTick: Ticks; toTick: Ticks },
): Project {
  const kept = (project.chords ?? []).filter((c) => c.tick < range.fromTick || c.tick >= range.toTick);
  const added = chords.map((c) => ({ ...c, id: newChordId() }));
  return { ...project, chords: [...kept, ...added].sort(byTick) };
}

/** 코드 기호를 전부 반음 단위로 옮긴다 (Logic: 코드 전조) */
export function transposeChords(project: Project, semitones: number): Project {
  return { ...project, chords: (project.chords ?? []).map((c) => transposeChord(c, semitones)) };
}

// --- 박자·조성 변화 -------------------------------------------------------------

/** `bar`(0부터) 부터 박자를 바꾼다. `null` 이면 그 마디의 변화를 지운다. 0번 마디는 곡 박자 */
export function setSignatureChange(project: Project, bar: number, timeSignature: TimeSignature | null): Project {
  const b = Math.round(bar);
  if (b <= 0) {
    if (timeSignature === null) throw new EditError('곡 첫 박자는 지울 수 없다');
    return { ...project, timeSignature: { ...timeSignature } };
  }
  const rest = (project.signatureChanges ?? []).filter((c) => c.bar !== b);
  const changes = timeSignature === null ? rest : [...rest, { bar: b, timeSignature: { ...timeSignature } }];
  return { ...project, signatureChanges: normalizeSignatureChanges(changes) };
}

/** `tick` 부터 조성을 바꾼다. `null` 이면 그 자리의 변화를 지운다. 0 이면 곡 조성 */
export function setKeyChange(project: Project, tick: Ticks, key: MusicalKey | null): Project {
  const t = Math.max(0, Math.round(tick));
  if (t === 0) return { ...project, key };
  const rest = (project.keyChanges ?? []).filter((c) => c.tick !== t);
  const keyChanges: KeyChange[] = key === null ? rest : [...rest, { tick: t, key: { ...key } }];
  return { ...project, keyChanges: keyChanges.sort(byTick) };
}

/** `tick` 에서 적용되는 조성 */
export function keyAt(project: Project, tick: Ticks): MusicalKey | null {
  let key = project.key;
  for (const change of project.keyChanges ?? []) {
    if (change.tick > tick) break;
    key = change.key;
  }
  return key;
}

/**
 * 탭 템포 — 마지막 몇 번 두드린 간격으로 BPM 을 낸다.
 * 2초 넘게 쉬면 새로 센다. 너무 벌어진 한 번(놓친 탭)은 중앙값이 걸러 낸다.
 */
export function tapTempo(tapTimesMs: readonly number[]): number | null {
  const recent: number[] = [];
  for (let i = tapTimesMs.length - 1; i >= 0; i--) {
    const t = tapTimesMs[i]!;
    if (recent.length > 0 && recent[recent.length - 1]! - t > 2000) break;
    recent.push(t);
    if (recent.length >= 8) break;
  }
  if (recent.length < 2) return null;
  const gaps = recent.slice(0, -1).map((t, i) => t - recent[i + 1]!).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  if (median <= 0) return null;
  return Math.max(20, Math.min(300, Math.round((60000 / median) * 10) / 10));
}

// --- 시간 넣기·빼기 ---------------------------------------------------------------

/** `tick` 을 가로지르는 클립을 전부 그 자리에서 나눈다 */
function splitClipsAt(project: Project, tick: Ticks): Project {
  let next = project;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.startTick < tick && tick < clip.startTick + clip.lengthTick) {
        next = splitClip(next, clip.id, tick).project;
      }
    }
  }
  return next;
}

const shiftAfter = (at: Ticks, by: Ticks) => (t: Ticks) => (t >= at ? t + by : t);

/** 곡 길이(마디)를 끝 틱이 들어가도록 늘린다. 줄이지는 않는다 */
function growToFit(project: Project, endTick: Ticks): number {
  const pos = positionAt(project, Math.max(0, endTick - 1));
  return Math.max(project.lengthBars, pos.bar + 1);
}

/**
 * `at` 에 `length` 만큼 빈 시간을 벌린다 (Logic: 간격 넣기).
 * `at` 이후의 클립·오토메이션·마커·코드·템포/조성 변화·구간이 전부 밀린다.
 * `at` 을 품은 구간은 그만큼 길어진다.
 */
export function insertTime(project: Project, at: Ticks, length: Ticks): Project {
  if (length <= 0) return project;
  const shift = shiftAfter(at, length);
  const split = splitClipsAt(project, at);
  const lastEnd = Math.max(
    0,
    ...split.tracks.flatMap((t) => t.clips.map((c) => shift(c.startTick) + c.lengthTick)),
  );
  const next: Project = {
    ...split,
    tracks: split.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((c) => (c.startTick >= at ? { ...c, startTick: c.startTick + length } : c)),
      automation: track.automation.map((lane) => ({
        ...lane,
        points: lane.points.map((p) => ({ ...p, tick: shift(p.tick) })),
      })),
    })),
    ...(split.markers ? { markers: split.markers.map((m) => ({ ...m, tick: shift(m.tick) })) } : {}),
    ...(split.chords ? { chords: split.chords.map((c) => ({ ...c, tick: shift(c.tick) })) } : {}),
    ...(split.keyChanges ? { keyChanges: split.keyChanges.map((c) => ({ ...c, tick: shift(c.tick) })) } : {}),
    ...(split.sections ? {
      sections: split.sections.map((s) => {
        if (s.startTick >= at) return { ...s, startTick: s.startTick + length };
        if (sectionEnd(s) > at) return { ...s, lengthTick: s.lengthTick + length };
        return s;
      }),
    } : {}),
    tempo: split.tempo.changes
      ? { ...split.tempo, changes: split.tempo.changes.map((c) => ({ ...c, tick: shift(c.tick) })) }
      : split.tempo,
    loop: split.loop && split.loop.startTick >= at
      ? { ...split.loop, startTick: split.loop.startTick + length, endTick: split.loop.endTick + length }
      : split.loop,
  };
  return { ...next, lengthBars: growToFit(next, lastEnd) };
}

/**
 * [start, end) 를 잘라내고 뒤를 당긴다 (Logic: 간격 빼기).
 * 안에 있던 클립·오토메이션 점·마커·코드·변화는 사라지고, 걸친 구간은 줄어든다.
 */
export function removeTime(project: Project, start: Ticks, end: Ticks): Project {
  const length = end - start;
  if (length <= 0) return project;
  const inside = (t: Ticks) => t >= start && t < end;
  const pull = (t: Ticks) => (t >= end ? t - length : t);
  const split = splitClipsAt(splitClipsAt(project, start), end);

  const next: Project = {
    ...split,
    tracks: split.tracks.map((track) => ({
      ...track,
      clips: track.clips
        .filter((c) => !(c.startTick >= start && c.startTick + c.lengthTick <= end))
        .map((c) => ({ ...c, startTick: pull(c.startTick) })),
      automation: track.automation.map((lane) => ({
        ...lane,
        points: lane.points.filter((p) => !inside(p.tick)).map((p) => ({ ...p, tick: pull(p.tick) })),
      })),
    })),
    ...(split.markers ? { markers: split.markers.filter((m) => !inside(m.tick)).map((m) => ({ ...m, tick: pull(m.tick) })) } : {}),
    ...(split.chords ? { chords: split.chords.filter((c) => !inside(c.tick)).map((c) => ({ ...c, tick: pull(c.tick) })) } : {}),
    ...(split.keyChanges ? { keyChanges: split.keyChanges.filter((c) => !inside(c.tick)).map((c) => ({ ...c, tick: pull(c.tick) })) } : {}),
    ...(split.sections ? {
      sections: split.sections.flatMap((s) => {
        const a = s.startTick;
        const b = sectionEnd(s);
        const cut = Math.max(0, Math.min(b, end) - Math.max(a, start));
        if (cut >= s.lengthTick) return [];
        // 뒤에 있으면 당기고, 앞에서 시작하면 그대로, 잘린 구간 안에서 시작하면 자른 자리로
        return [{ ...s, startTick: a >= end ? a - length : a < start ? a : start, lengthTick: s.lengthTick - cut }];
      }),
    } : {}),
    tempo: split.tempo.changes
      ? { ...split.tempo, changes: split.tempo.changes.filter((c) => !inside(c.tick)).map((c) => ({ ...c, tick: pull(c.tick) })) }
      : split.tempo,
    loop: split.loop && split.loop.startTick >= end
      ? { ...split.loop, startTick: split.loop.startTick - length, endTick: split.loop.endTick - length }
      : split.loop,
  };
  return next;
}

/** 구간 안의 음악 — 위치는 `start` 기준 상대값 */
export interface RangeContent {
  length: Ticks;
  clips: { trackId: TrackId; clip: Clip }[];
  automation: { trackId: TrackId; target: AutomationLane['target']; points: { tick: Ticks; value: number }[] }[];
  markers: Omit<Marker, 'id'>[];
  chords: Omit<ChordSymbol, 'id'>[];
  keyChanges: KeyChange[];
  sections: Section[];
  tempoChanges: { tick: Ticks; bpm: number }[];
}

/** [start, end) 의 음악을 떠 온다. 걸친 클립은 경계에서 나눈 조각만 담는다 */
export function copyRange(project: Project, start: Ticks, end: Ticks): RangeContent {
  const split = splitClipsAt(splitClipsAt(project, start), end);
  const inside = (t: Ticks) => t >= start && t < end;
  return {
    length: end - start,
    clips: split.tracks.flatMap((track) => track.clips
      .filter((c) => c.startTick >= start && c.startTick + c.lengthTick <= end)
      .map((c) => ({ trackId: track.id, clip: structuredClone({ ...c, startTick: c.startTick - start }) }))),
    automation: split.tracks.flatMap((track) => track.automation.map((lane) => ({
      trackId: track.id,
      target: lane.target,
      points: lane.points.filter((p) => inside(p.tick)).map((p) => ({ tick: p.tick - start, value: p.value })),
    }))).filter((a) => a.points.length > 0),
    markers: (split.markers ?? []).filter((m) => inside(m.tick)).map((m) => ({ tick: m.tick - start, name: m.name })),
    chords: (split.chords ?? []).filter((c) => inside(c.tick)).map(({ id: _id, ...c }) => ({ ...c, tick: c.tick - start })),
    keyChanges: (split.keyChanges ?? []).filter((c) => inside(c.tick)).map((c) => ({ ...c, tick: c.tick - start })),
    sections: (split.sections ?? [])
      .filter((s) => s.startTick >= start && sectionEnd(s) <= end)
      .map((s) => ({ ...s, startTick: s.startTick - start })),
    tempoChanges: (split.tempo.changes ?? []).filter((c) => inside(c.tick)).map((c) => ({ ...c, tick: c.tick - start })),
  };
}

/**
 * 떠 온 음악을 `at` 에 놓는다. 자리는 **비어 있어야 한다** (`insertTime` 으로 벌린 뒤).
 * `freshIds` 면 클립·음·구간에 새 id — 복제. 아니면 원래 id — 이동.
 */
export function pasteRange(
  project: Project,
  at: Ticks,
  content: RangeContent,
  options: { freshIds: boolean },
): Project {
  const reId = (clip: Clip): Clip => (options.freshIds
    ? { ...clip, id: newClipId(), notes: clip.notes.map((n) => ({ ...n, id: newNoteId() })) }
    : clip);
  const tracks = project.tracks.map((track) => {
    const clips = content.clips.filter((c) => c.trackId === track.id).map((c) => reId({ ...c.clip, startTick: c.clip.startTick + at }));
    const lanes = content.automation.filter((a) => a.trackId === track.id);
    if (clips.length === 0 && lanes.length === 0) return track;
    const automation = [...track.automation];
    for (const lane of lanes) {
      const index = automation.findIndex((l) => l.target === lane.target);
      const points = lane.points.map((p) => ({ tick: p.tick + at, value: p.value }));
      if (index < 0) automation.push({ target: lane.target, points });
      else automation[index] = { ...automation[index]!, points: [...automation[index]!.points, ...points].sort(byTick) };
    }
    return { ...track, clips: [...track.clips, ...clips], automation };
  });

  const withList = <T,>(list: T[] | undefined, added: T[]): T[] | undefined =>
    (list === undefined && added.length === 0 ? undefined : [...(list ?? []), ...added]);

  const markers = withList(project.markers, content.markers.map((m) => ({ ...m, id: newMarkerId(), tick: m.tick + at })))?.sort(byTick);
  const chords = withList(project.chords, content.chords.map((c) => ({ ...c, id: newChordId(), tick: c.tick + at })))?.sort(byTick);
  const keyChanges = withList(project.keyChanges, content.keyChanges.map((c) => ({ ...c, tick: c.tick + at })))?.sort(byTick);
  const sections = withList(project.sections, content.sections.map((s) => ({
    ...s,
    id: options.freshIds ? newSectionId() : s.id,
    startTick: s.startTick + at,
  })))?.sort((a, b) => a.startTick - b.startTick);
  const tempoChanges = content.tempoChanges.map((c) => ({ ...c, tick: c.tick + at }));

  const next: Project = {
    ...project,
    tracks,
    ...(markers ? { markers } : {}),
    ...(chords ? { chords } : {}),
    ...(keyChanges ? { keyChanges } : {}),
    ...(sections ? { sections } : {}),
    tempo: tempoChanges.length > 0
      ? { ...project.tempo, changes: [...(project.tempo.changes ?? []), ...tempoChanges].sort(byTick) }
      : project.tempo,
  };
  return { ...next, lengthBars: growToFit(next, at + content.length) };
}

/**
 * 템포 트랙 (Logic Tempo Track, `PARITY_ROUND2.md` 12) — 화면이 그릴 계단 곡선의 범위.
 * 곡의 템포보다 위아래로 여유를 두되 너무 납작하지 않게 최소 폭 40 BPM.
 */
export function tempoRange(project: Project): { min: number; max: number } {
  const all = [project.tempo.bpm, ...(project.tempo.changes ?? []).map((c) => c.bpm)];
  let min = Math.min(...all) - 10;
  let max = Math.max(...all) + 10;
  if (max - min < 40) { const mid = (max + min) / 2; min = mid - 20; max = mid + 20; }
  return { min: Math.max(20, Math.floor(min)), max: Math.min(300, Math.ceil(max)) };
}

/** 템포 변화 지점 하나를 다른 자리·값으로 (끌기). 틱 0 은 시작 템포 — 값만 바뀐다 */
export function moveTempoChange(project: Project, fromTick: Ticks, toTick: Ticks, bpm: number): Project {
  const value = Math.round(Math.min(300, Math.max(20, bpm)) * 10) / 10;
  if (fromTick === 0) return { ...project, tempo: { ...project.tempo, bpm: value } };
  const at = Math.max(1, Math.round(toTick));
  const old = (project.tempo.changes ?? []).find((c) => c.tick === fromTick);
  const rest = (project.tempo.changes ?? []).filter((c) => c.tick !== fromTick && c.tick !== at);
  const moved = old?.ramp ? { tick: at, bpm: value, ramp: true } : { tick: at, bpm: value };
  return { ...project, tempo: { ...project.tempo, changes: [...rest, moved].sort((a, b) => a.tick - b.tick) } };
}

/** 템포 변화를 "서서히(램프)" 로 켜고 끈다 — 앞 지점에서 이 값까지 직선으로 */
export function toggleTempoRamp(project: Project, tick: Ticks): Project {
  return {
    ...project,
    tempo: {
      ...project.tempo,
      changes: (project.tempo.changes ?? []).map((c) => {
        if (c.tick !== tick) return c;
        if (c.ramp) return { tick: c.tick, bpm: c.bpm };
        return { ...c, ramp: true };
      }),
    },
  };
}

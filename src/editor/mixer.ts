/**
 * 믹서 편집 — 버스(Aux)·출력·센드·VCA·그룹 (Logic Mixer, `LOGIC_PARITY.md` 1-8).
 * 순수 함수, 입력을 바꾸지 않는다.
 */

import type { Bus, BusId, GroupId, MixGroup, Project, Track, TrackId, Vca, VcaId } from '../model/project.ts';
import { newBusId, newGroupId, newVcaId } from '../model/factory.ts';
import { EditError } from './edits.ts';

const mapTrack = (project: Project, trackId: TrackId, fn: (t: Track) => Track): Project => {
  if (!project.tracks.some((t) => t.id === trackId)) throw new EditError(`트랙 ${trackId} 없음`);
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
};

/** 선택 키를 지운 트랙 — 옛 파일과 같은 모양을 유지한다 */
function without<K extends keyof Track>(track: Track, key: K): Track {
  const next = { ...track };
  delete next[key];
  return next;
}

// --- 버스 -------------------------------------------------------------------

export function addBus(project: Project, name?: string): { project: Project; busId: BusId } {
  const buses = project.buses ?? [];
  const bus: Bus = { id: newBusId(), name: name?.trim() || `버스 ${buses.length + 1}`, gain: 1, pan: 0, mute: false, effects: [] };
  return { project: { ...project, buses: [...buses, bus] }, busId: bus.id };
}

export function updateBus(project: Project, busId: BusId, patch: Partial<Omit<Bus, 'id'>>): Project {
  const buses = project.buses ?? [];
  if (!buses.some((b) => b.id === busId)) throw new EditError(`버스 ${busId} 없음`);
  return { ...project, buses: buses.map((b) => (b.id === busId ? { ...b, ...patch } : b)) };
}

/** 버스를 지운다 — 그리로 가던 트랙은 마스터로, 그 버스로 가던 센드는 없앤다 */
export function deleteBus(project: Project, busId: BusId): Project {
  return {
    ...project,
    buses: (project.buses ?? []).filter((b) => b.id !== busId),
    tracks: project.tracks.map((t) => {
      let next = t.output === busId ? without(t, 'output') : t;
      if (next.sends?.some((s) => s.busId === busId)) {
        const sends = next.sends.filter((s) => s.busId !== busId);
        next = sends.length ? { ...next, sends } : without(next, 'sends');
      }
      return next;
    }),
  };
}

/** 트랙 출력 — `null` 이면 마스터 */
export function setTrackOutput(project: Project, trackId: TrackId, busId: BusId | null): Project {
  if (busId !== null && !(project.buses ?? []).some((b) => b.id === busId)) throw new EditError(`버스 ${busId} 없음`);
  return mapTrack(project, trackId, (t) => (busId === null ? without(t, 'output') : { ...t, output: busId }));
}

/** 센드 레벨. `null` 이면 그 센드를 없앤다 */
export function setSend(project: Project, trackId: TrackId, busId: BusId, level: number | null): Project {
  if (!(project.buses ?? []).some((b) => b.id === busId)) throw new EditError(`버스 ${busId} 없음`);
  return mapTrack(project, trackId, (t) => {
    const rest = (t.sends ?? []).filter((s) => s.busId !== busId);
    const sends = level === null ? rest : [...rest, { busId, level: Math.max(0, Math.min(1, level)) }];
    if (sends.length === 0) return without(t, 'sends');
    // 순서는 버스 목록 순서로 — 화면의 센드 칸이 들쭉날쭉하지 않게
    const order = (project.buses ?? []).map((b) => b.id);
    return { ...t, sends: sends.sort((a, b) => order.indexOf(a.busId) - order.indexOf(b.busId)) };
  });
}

/**
 * 고른 트랙들을 새 버스로 보내는 합 스택 (Logic Summing Stack) — 버스를 만들고
 * 트랙 출력을 전부 그 버스로. 스택 멤버를 한 페이더·한 리버브로 다룰 때 쓴다.
 */
export function sumToNewBus(project: Project, trackIds: readonly TrackId[], name: string): { project: Project; busId: BusId } {
  const made = addBus(project, name);
  let next = made.project;
  for (const id of trackIds) next = setTrackOutput(next, id, made.busId);
  return { project: next, busId: made.busId };
}

// --- VCA --------------------------------------------------------------------

export function addVca(project: Project, name?: string): { project: Project; vcaId: VcaId } {
  const vcas = project.vcas ?? [];
  const vca: Vca = { id: newVcaId(), name: name?.trim() || `VCA ${vcas.length + 1}`, gain: 1, mute: false };
  return { project: { ...project, vcas: [...vcas, vca] }, vcaId: vca.id };
}

export function updateVca(project: Project, vcaId: VcaId, patch: Partial<Omit<Vca, 'id'>>): Project {
  const vcas = project.vcas ?? [];
  if (!vcas.some((v) => v.id === vcaId)) throw new EditError(`VCA ${vcaId} 없음`);
  return { ...project, vcas: vcas.map((v) => (v.id === vcaId ? { ...v, ...patch } : v)) };
}

export function deleteVca(project: Project, vcaId: VcaId): Project {
  return {
    ...project,
    vcas: (project.vcas ?? []).filter((v) => v.id !== vcaId),
    tracks: project.tracks.map((t) => (t.vcaId === vcaId ? without(t, 'vcaId') : t)),
  };
}

export function assignVca(project: Project, trackId: TrackId, vcaId: VcaId | null): Project {
  if (vcaId !== null && !(project.vcas ?? []).some((v) => v.id === vcaId)) throw new EditError(`VCA ${vcaId} 없음`);
  return mapTrack(project, trackId, (t) => (vcaId === null ? without(t, 'vcaId') : { ...t, vcaId }));
}

// --- 그룹 -------------------------------------------------------------------

export function addGroup(project: Project, name?: string): { project: Project; groupId: GroupId } {
  const groups = project.groups ?? [];
  const group: MixGroup = { id: newGroupId(), name: name?.trim() || `그룹 ${groups.length + 1}` };
  return { project: { ...project, groups: [...groups, group] }, groupId: group.id };
}

export function deleteGroup(project: Project, groupId: GroupId): Project {
  return {
    ...project,
    groups: (project.groups ?? []).filter((g) => g.id !== groupId),
    tracks: project.tracks.map((t) => (t.groupId === groupId ? without(t, 'groupId') : t)),
  };
}

export function assignGroup(project: Project, trackId: TrackId, groupId: GroupId | null): Project {
  if (groupId !== null && !(project.groups ?? []).some((g) => g.id === groupId)) throw new EditError(`그룹 ${groupId} 없음`);
  return mapTrack(project, trackId, (t) => (groupId === null ? without(t, 'groupId') : { ...t, groupId }));
}

/**
 * 그룹 볼륨 — 한 트랙의 페이더를 움직이면 같은 그룹 트랙이 **같은 비율로** 따라온다
 * (Logic 그룹의 상대 모드). 0 에서는 비율이 없으니 그때만 같은 값으로 맞춘다.
 */
export function setGroupedGain(project: Project, trackId: TrackId, gain: number): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`트랙 ${trackId} 없음`);
  const g = Math.max(0, Math.min(1, gain));
  if (!track.groupId) return mapTrack(project, trackId, (t) => ({ ...t, gain: g }));
  const ratio = track.gain > 0 ? g / track.gain : null;
  return {
    ...project,
    tracks: project.tracks.map((t) => {
      if (t.groupId !== track.groupId) return t;
      if (t.id === trackId || ratio === null) return { ...t, gain: g };
      return { ...t, gain: Math.max(0, Math.min(1, t.gain * ratio)) };
    }),
  };
}

/** 그룹 뮤트·솔로 — 그룹이면 멤버 전부가 이 트랙의 새 값을 따른다 */
export function setGroupedFlag(project: Project, trackId: TrackId, flag: 'mute' | 'solo', on: boolean): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`트랙 ${trackId} 없음`);
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === trackId || (track.groupId && t.groupId === track.groupId) ? { ...t, [flag]: on } : t)),
  };
}

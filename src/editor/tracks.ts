/**
 * 트랙 정리 — 스택(묶기)·보호·숨김 (Logic Track Stack · Protect · Hide, `LOGIC_PARITY.md` 1-3).
 * `edits.ts` 와 같은 규칙: 순수 함수, 입력을 바꾸지 않는다.
 */

import type { Project, StackId, Track, TrackId } from '../model/project.ts';
import { newStackId } from '../model/factory.ts';
import { EditError } from './edits.ts';

function findTrack(project: Project, trackId: TrackId): Track {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`트랙 ${trackId} 없음`);
  return track;
}

/** 스택 멤버가 목록에서 붙어 있게 다시 늘어놓는다 — 첫 멤버 자리에 모은다 */
function regroup(tracks: Track[]): Track[] {
  const out: Track[] = [];
  const placed = new Set<TrackId>();
  for (const track of tracks) {
    if (placed.has(track.id)) continue;
    if (!track.stackId) {
      out.push(track);
      placed.add(track.id);
      continue;
    }
    for (const member of tracks.filter((t) => t.stackId === track.stackId)) {
      out.push(member);
      placed.add(member.id);
    }
  }
  return out;
}

/** 이 트랙으로 새 스택을 만든다 */
export function createStack(project: Project, trackId: TrackId, name?: string): { project: Project; stackId: StackId } {
  const track = findTrack(project, trackId);
  const stacks = project.stacks ?? [];
  const stack = { id: newStackId(), name: name?.trim() || `${track.name} 스택`, collapsed: false };
  return {
    project: {
      ...project,
      stacks: [...stacks, stack],
      tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, stackId: stack.id } : t)),
    },
    stackId: stack.id,
  };
}

/** 트랙을 스택에 넣는다(`null` 이면 뺀다). 넣으면 그 스택 멤버들 곁으로 옮겨진다 */
export function setTrackStack(project: Project, trackId: TrackId, stackId: StackId | null): Project {
  findTrack(project, trackId);
  if (stackId !== null && !(project.stacks ?? []).some((s) => s.id === stackId)) {
    throw new EditError(`스택 ${stackId} 없음`);
  }
  const moved = project.tracks.map((t) => {
    if (t.id !== trackId) return t;
    const { stackId: _old, ...rest } = t;
    return stackId === null ? rest : { ...rest, stackId };
  });
  // 빠져나온 트랙은 스택 바로 아래로 — 엉뚱한 곳으로 튀지 않게
  const regrouped = regroup(moved);
  return dropEmptyStacks({ ...project, tracks: regrouped });
}

/** 스택을 푼다 — 트랙은 그 자리에 그대로 남는다 */
export function ungroupStack(project: Project, stackId: StackId): Project {
  return {
    ...project,
    stacks: (project.stacks ?? []).filter((s) => s.id !== stackId),
    tracks: project.tracks.map((t) => {
      if (t.stackId !== stackId) return t;
      const { stackId: _old, ...rest } = t;
      return rest;
    }),
  };
}

export function updateStack(project: Project, stackId: StackId, patch: { name?: string; collapsed?: boolean }): Project {
  const stacks = project.stacks ?? [];
  if (!stacks.some((s) => s.id === stackId)) throw new EditError(`스택 ${stackId} 없음`);
  return {
    ...project,
    stacks: stacks.map((s) => (s.id === stackId
      ? { ...s, ...(patch.name === undefined ? {} : { name: patch.name.trim() || s.name }), ...(patch.collapsed === undefined ? {} : { collapsed: patch.collapsed }) }
      : s)),
  };
}

/** 스택 멤버 전부 뮤트·솔로 — 멤버 중 하나라도 꺼져 있으면 켠다 */
export function toggleStackFlag(project: Project, stackId: StackId, flag: 'mute' | 'solo'): Project {
  const members = project.tracks.filter((t) => t.stackId === stackId);
  const on = !members.every((t) => t[flag]);
  return { ...project, tracks: project.tracks.map((t) => (t.stackId === stackId ? { ...t, [flag]: on } : t)) };
}

function dropEmptyStacks(project: Project): Project {
  if (!project.stacks) return project;
  const used = new Set(project.tracks.map((t) => t.stackId).filter(Boolean));
  return { ...project, stacks: project.stacks.filter((s) => used.has(s.id)) };
}

/** 보호·숨김 — 꺼지면 키를 지워 옛 파일과 같은 모양으로 둔다 */
export function setTrackFlag(project: Project, trackId: TrackId, flag: 'hidden' | 'locked', on: boolean): Project {
  findTrack(project, trackId);
  return {
    ...project,
    tracks: project.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const next = { ...t };
      if (on) next[flag] = true;
      else delete next[flag];
      return next;
    }),
  };
}

/**
 * 보호된 트랙의 내용(클립·음·오토메이션·이펙트)이 바뀌었는가. 바뀌었으면 그 트랙 이름.
 *
 * 화면 곳곳(피아노롤·타임라인·인스펙터·믹서)에 "보호면 막기"를 심지 않고 **편집기
 * 한 곳에서 거른다** — 새 편집 화면이 생겨도 따로 챙길 필요가 없다. 뮤트·솔로·볼륨·
 * 숨김은 Logic 처럼 보호와 상관없이 바꿀 수 있다.
 */
export function protectedChange(before: Project, after: Project): string | null {
  for (const prev of before.tracks) {
    if (!prev.locked) continue;
    const next = after.tracks.find((t) => t.id === prev.id);
    if (!next) return prev.name; // 보호된 트랙 삭제
    if (!next.locked) continue; // 보호를 푸는 편집 자체는 된다
    if (prev.clips !== next.clips && JSON.stringify(prev.clips) !== JSON.stringify(next.clips)) return prev.name;
    if (prev.automation !== next.automation && JSON.stringify(prev.automation) !== JSON.stringify(next.automation)) return prev.name;
    if (prev.effects !== next.effects && JSON.stringify(prev.effects) !== JSON.stringify(next.effects)) return prev.name;
    if (prev.instrumentId !== next.instrumentId) return prev.name;
  }
  return null;
}

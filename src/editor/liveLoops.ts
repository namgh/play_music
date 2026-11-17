/**
 * 라이브 루프 — 트랙 × 장면 격자의 루프 칸을 켜고 끄며 연주하고, 그 순서를 편곡으로
 * 옮긴다 (Logic Live Loops, `LOGIC_PARITY.md` 1-5).
 *
 * 칸에는 음이 들어 있다(클립과 같은 형식). 연주는 **연주용 곡을 만들어 재생**한다 —
 * 켜진 칸들을 각 트랙의 클립으로 깔고 반복 구간을 걸어 둔 곡. 그래서 엔진·스케줄러·
 * 이펙트는 라이브 루프를 몰라도 된다. 전부 순수 함수다.
 */

import type { Clip, LiveCell, LiveScene, Note, Project, TrackId } from '../model/project.ts';
import { createClip, newNoteId, projectLengthTicks } from '../model/factory.ts';
import { barStartTick, positionAt } from '../model/meter.ts';
import type { Ticks } from '../model/time.ts';
import { EditError } from './edits.ts';

const notesIn = (clip: Clip, from: Ticks, to: Ticks): Note[] => clip.notes
  .filter((n) => clip.startTick + n.startTick >= from && clip.startTick + n.startTick < to)
  .map((n) => ({ ...structuredClone(n), id: newNoteId(), startTick: clip.startTick + n.startTick - from }));

/** 곡의 [from, to) 를 장면 하나로 떠 온다 — 트랙마다 칸 하나(음이 있을 때만) */
export function captureScene(project: Project, from: Ticks, to: Ticks, name: string): LiveScene {
  const cells: LiveCell[] = [];
  for (const track of project.tracks) {
    const notes = track.clips.filter((c) => c.startTick < to && c.startTick + c.lengthTick > from).flatMap((c) => notesIn(c, from, to));
    if (notes.length > 0) cells.push({ trackId: track.id, lengthTick: to - from, notes });
  }
  return { id: `scn_${name}_${from}`, name, cells };
}

/** 편곡 구간마다 장면 하나 — 이미 짠 곡을 라이브로 가지고 놀기 시작하는 가장 빠른 길 */
export function scenesFromSections(project: Project): LiveScene[] {
  return (project.sections ?? []).map((s) => ({ ...captureScene(project, s.startTick, s.startTick + s.lengthTick, s.name), id: `scn_${s.id}` }));
}

export function addScenes(project: Project, scenes: readonly LiveScene[]): Project {
  const existing = project.liveScenes ?? [];
  const taken = new Set(existing.map((s) => s.id));
  const fresh = scenes.map((s, i) => (taken.has(s.id) ? { ...s, id: `${s.id}_${existing.length + i}` } : s));
  return { ...project, liveScenes: [...existing, ...fresh] };
}

export function removeScene(project: Project, sceneId: string): Project {
  const liveScenes = (project.liveScenes ?? []).filter((s) => s.id !== sceneId);
  const next: Project = { ...project, liveScenes };
  if (liveScenes.length === 0) delete next.liveScenes;
  return next;
}

/** 칸 비우기 */
export function clearCell(project: Project, sceneId: string, trackId: TrackId): Project {
  return { ...project, liveScenes: (project.liveScenes ?? []).map((s) => (s.id === sceneId ? { ...s, cells: s.cells.filter((c) => c.trackId !== trackId) } : s)) };
}

/** 트랙마다 지금 켜진 장면 (null = 그 트랙은 쉼) */
export type LiveState = Partial<Record<TrackId, string | null>>;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * 연주용 곡 — 켜진 칸들을 각 트랙의 클립으로 반복해 깐다. 반복 구간 길이는 칸 길이들의
 * 최소공배수(너무 길면 가장 긴 칸의 4배에서 자른다). 곡의 템포·악기·이펙트·믹서는 그대로.
 */
export function performanceProject(project: Project, state: LiveState): { project: Project; loopTicks: Ticks } {
  const scenes = project.liveScenes ?? [];
  const active = project.tracks.flatMap((t) => {
    const sceneId = state[t.id];
    const cell = sceneId ? scenes.find((s) => s.id === sceneId)?.cells.find((c) => c.trackId === t.id) : undefined;
    return cell ? [{ track: t, cell }] : [];
  });
  const lengths = active.map((a) => a.cell.lengthTick);
  const longest = Math.max(barStartTick(project, 1), ...lengths);
  let loop = lengths.reduce((acc, l) => (acc * l) / gcd(acc, l), lengths[0] ?? longest);
  if (loop > longest * 4) loop = longest;

  const tracks = project.tracks.map((t) => {
    const a = active.find((x) => x.track.id === t.id);
    if (!a) return { ...t, clips: [], automation: [] };
    const clips: Clip[] = [];
    for (let at = 0; at < loop; at += a.cell.lengthTick) {
      const clip = createClip({ startTick: at, lengthTick: Math.min(a.cell.lengthTick, loop - at), label: '루프' });
      clip.notes = a.cell.notes.map((n) => ({ ...n, id: newNoteId() }));
      clips.push(clip);
    }
    return { ...t, clips, automation: [] };
  });
  const bars = positionAt(project, Math.max(0, loop - 1)).bar + 1;
  const perf: Project = { ...project, tracks, lengthBars: bars, loop: { startTick: 0, endTick: loop, enabled: true } };
  delete perf.sections;
  delete perf.markers;
  return { project: perf, loopTicks: loop };
}

/**
 * 장면들을 차례로 편곡에 붙인다 (Logic: 라이브 루프 연주를 트랙 영역으로 녹음).
 * 곡 끝 마디부터, 장면마다 가장 긴 칸만큼. 각 장면은 편곡 구간으로도 남긴다.
 */
export function arrangeScenes(project: Project, sceneIds: readonly string[]): Project {
  const scenes = project.liveScenes ?? [];
  let at = projectLengthTicks(project);
  let next: Project = { ...project, tracks: project.tracks.map((t) => ({ ...t, clips: [...t.clips] })) };
  const sections = [...(project.sections ?? [])];
  for (const id of sceneIds) {
    const scene = scenes.find((s) => s.id === id);
    if (!scene) throw new EditError(`장면 ${id} 없음`);
    const len = Math.max(barStartTick(project, 1), ...scene.cells.map((c) => c.lengthTick));
    next = {
      ...next,
      tracks: next.tracks.map((t) => {
        const cell = scene.cells.find((c) => c.trackId === t.id);
        if (!cell) return t;
        const clip = createClip({ startTick: at, lengthTick: len, label: scene.name });
        // 칸이 장면보다 짧으면 장면 길이만큼 되풀이한다
        for (let rep = 0; rep < len; rep += cell.lengthTick) {
          clip.notes.push(...cell.notes.filter((n) => rep + n.startTick < len).map((n) => ({ ...n, id: newNoteId(), startTick: rep + n.startTick })));
        }
        return { ...t, clips: [...t.clips, clip] };
      }),
    };
    sections.push({ id: `sec_${scene.id}_${at}` as `sec_${string}`, startTick: at, lengthTick: len, name: scene.name });
    at += len;
  }
  const end = positionAt(next, Math.max(0, at - 1)).bar + 1;
  return { ...next, sections, lengthBars: Math.max(project.lengthBars, end) };
}

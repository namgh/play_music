/**
 * 스크럽 (Logic 스크러빙, `PARITY_ROUND2.md` 11) — 재생 헤드를 끌어 지나간 구간에서 **시작하는** 음을 고른다.
 * 화면이 고른 음을 짧게 들려준다. 앞으로든 뒤로든 끌 수 있다 (구간을 정렬해서 본다).
 * 뮤트·솔로·클립 뮤트를 따른다 — 들리지 않을 음은 스크럽에서도 안 들린다.
 */

import type { Project, TrackId } from '../model/project.ts';
import { isClipAudible } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';

export interface ScrubNote { trackId: TrackId; midi: number; velocity: number }

/** 한 번에 이만큼까지만 — 빨리 끌면 수십 음이 한꺼번에 터진다 */
export const SCRUB_LIMIT = 8;

/** 스크럽 자리에 걸린 오디오 클립 — 에셋 안 몇 초를 들려줄지 (`PARITY_ROUND2.md` 20). 뮤트·솔로 따름 */
export function audioAt(project: Project, tick: Ticks, secondsAt: (t: Ticks) => number): { assetId: string; offsetSec: number; gainDb: number }[] {
  const soloing = project.tracks.some((t) => t.solo);
  const out: { assetId: string; offsetSec: number; gainDb: number }[] = [];
  for (const t of project.tracks) {
    if (t.mute || (soloing && !t.solo)) continue;
    for (const c of t.clips) {
      if (!c.audio || !isClipAudible(c) || tick < c.startTick || tick >= c.startTick + c.lengthTick) continue;
      const into = secondsAt(tick) - secondsAt(c.startTick);
      const a = c.audio;
      const pos = a.offsetSec + into;
      if (pos < 0 || pos >= a.assetSec) continue;
      out.push({ assetId: a.assetId, offsetSec: a.reverse ? Math.max(0, a.assetSec - pos) : pos, gainDb: a.gainDb });
    }
  }
  return out;
}

export function notesInSpan(project: Project, a: Ticks, b: Ticks): ScrubNote[] {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (to <= from) return [];
  const soloing = project.tracks.some((t) => t.solo);
  const out: ScrubNote[] = [];
  for (const t of project.tracks) {
    if (t.mute || (soloing && !t.solo) || t.kind === 'audio') continue;
    for (const c of t.clips) {
      if (!isClipAudible(c) || c.audio) continue;
      if (c.startTick >= to || c.startTick + c.lengthTick <= from) continue;
      for (const n of c.notes) {
        const at = c.startTick + n.startTick;
        if (at >= from && at < to && n.startTick < c.lengthTick) out.push({ trackId: t.id, midi: n.pitch.midi, velocity: n.velocity });
      }
    }
  }
  return out.slice(0, SCRUB_LIMIT);
}

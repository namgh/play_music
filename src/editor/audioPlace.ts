/**
 * 오디오 클립을 **새 오디오 트랙**에 놓는다 — 바운스·프리즈가 쓴다 (화면 쪽 `placeAudio` 와 달리 React 를 모른다).
 * 새 트랙은 `afterTrackId` 바로 아래에 끼운다 (원래 트랙 옆에 있어야 무엇의 렌더인지 보인다).
 */

import type { Project, TrackId } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { secondsToTicks, ticksToSeconds } from '../model/time.ts';
import { addClip, addTrack } from './edits.ts';

export function placeAudioClip(
  project: Project,
  input: { assetId: string; seconds: number; name: string; atTick: Ticks; afterTrackId?: TrackId },
): { project: Project; trackId: TrackId } {
  const made = addTrack(project, { name: input.name, instrumentId: 'acoustic-guitar' });
  let p: Project = { ...made.project, tracks: made.project.tracks.map((t) => (t.id === made.trackId ? { ...t, kind: 'audio' as const } : t)) };
  const startSec = ticksToSeconds(input.atTick, p.tempo);
  const lengthTick = Math.max(1, secondsToTicks(startSec + input.seconds, p.tempo) - input.atTick);
  const r = addClip(p, { trackId: made.trackId, startTick: input.atTick, lengthTick, label: input.name });
  p = {
    ...r.project,
    tracks: r.project.tracks.map((t) => (t.id !== made.trackId ? t : {
      ...t,
      clips: t.clips.map((c) => (c.id !== r.clipId ? c : {
        ...c,
        audio: { assetId: input.assetId, name: input.name, assetSec: input.seconds, offsetSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, reverse: false },
      })),
    })),
  };
  if (input.afterTrackId) {
    const tracks = p.tracks.filter((t) => t.id !== made.trackId);
    const at = tracks.findIndex((t) => t.id === input.afterTrackId);
    const placed = p.tracks.find((t) => t.id === made.trackId)!;
    tracks.splice(at < 0 ? tracks.length : at + 1, 0, placed);
    p = { ...p, tracks };
  }
  return { project: p, trackId: made.trackId };
}

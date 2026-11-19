/**
 * 바운스 인 플레이스 · 프리즈 (Logic Bounce in Place · Freeze, `PARITY_ROUND2.md` 9) — 순수 함수.
 *
 * 렌더(트랙 하나를 인서트까지 거친 소리로)는 렌더러가 하고, 여기서는 그 결과 에셋을 곡에 놓는다.
 *  - 바운스 인 플레이스: 새 오디오 트랙 "<이름> (바운스)" 을 곡 처음부터, 원래 트랙은 뮤트 (지우지 않는다 —
 *    되돌아갈 수 있게)
 *  - 프리즈: 같은 렌더를 숨은 오디오 트랙으로, 원래 트랙은 뮤트·보호. 풀면 렌더 트랙을 지우고 원래대로.
 *    CPU 가 무거운 악기·이펙트 트랙을 가볍게 만드는 것이 목적이다
 */

import type { Project, TrackId } from '../model/project.ts';
import { EditError } from './edits.ts';
import { placeAudioClip } from './audioPlace.ts';

export interface RenderedAudio {
  assetId: string;
  seconds: number;
}

export function bounceInPlace(project: Project, trackId: TrackId, audio: RenderedAudio): { project: Project; trackId: TrackId } {
  const src = project.tracks.find((t) => t.id === trackId);
  if (!src) throw new EditError(`트랙 ${trackId} 없음`);
  const placed = placeAudioClip(project, { ...audio, name: `${src.name} (바운스)`, atTick: 0, afterTrackId: trackId });
  return {
    project: { ...placed.project, tracks: placed.project.tracks.map((t) => (t.id === trackId ? { ...t, mute: true } : t)) },
    trackId: placed.trackId,
  };
}

export function freezeTrack(project: Project, trackId: TrackId, audio: RenderedAudio): Project {
  const src = project.tracks.find((t) => t.id === trackId);
  if (!src) throw new EditError(`트랙 ${trackId} 없음`);
  if (src.frozen) throw new EditError(`"${src.name}" 은 이미 얼려 있습니다`);
  const placed = placeAudioClip(project, { ...audio, name: `${src.name} ❄`, atTick: 0, afterTrackId: trackId });
  return {
    ...placed.project,
    tracks: placed.project.tracks.map((t) => {
      if (t.id === trackId) return { ...t, mute: true, locked: true, frozen: { audioTrackId: placed.trackId, wasMuted: t.mute, wasLocked: !!t.locked } };
      // 렌더 트랙은 원래 트랙의 자리(출력·센드·팬·볼륨)를 이어받는다 — 인서트는 이미 구워졌다
      if (t.id === placed.trackId) {
        const next = { ...t, freezeOf: trackId, hidden: true, gain: src.gain, pan: src.pan, solo: src.solo };
        if (src.output) next.output = src.output;
        if (src.sends) next.sends = src.sends;
        return next;
      }
      return t;
    }),
  };
}

export function unfreezeTrack(project: Project, trackId: TrackId): Project {
  const src = project.tracks.find((t) => t.id === trackId);
  if (!src?.frozen) throw new EditError('얼린 트랙이 아닙니다');
  const { audioTrackId, wasMuted, wasLocked } = src.frozen;
  return {
    ...project,
    tracks: project.tracks
      .filter((t) => t.id !== audioTrackId)
      .map((t) => {
        if (t.id !== trackId) return t;
        const next = { ...t, mute: wasMuted };
        delete next.frozen;
        if (wasLocked) next.locked = true; else delete next.locked;
        return next;
      }),
  };
}

/** 렌더용 곡 — 그 트랙만, 마스터 이펙트·버스 없이, 마스터 게인 1 (트랙 볼륨·팬·인서트는 그대로) */
export function soloRenderProject(project: Project, trackId: TrackId): Project {
  const t = project.tracks.find((x) => x.id === trackId);
  if (!t) throw new EditError(`트랙 ${trackId} 없음`);
  const only = { ...t, mute: false, solo: false };
  delete only.output;
  delete only.sends;
  return { ...project, tracks: [only], buses: [], master: { ...project.master, gain: 1, effects: [] } };
}

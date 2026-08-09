/**
 * 고스트 노트 — **다른 트랙의 음을 지금 피아노롤에 겹쳐 보여 준다.**
 *
 * 왜 필요한가: 멜로디를 보면서 베이스를 쓰는 건 작곡의 기본 동작이다. 이게 없으면
 * 트랙을 오가며 외워야 한다.
 *
 * 다른 DAW 의 같은 기능:
 *  - **FL Studio "Ghost Notes"** — 다른 채널 음을 흐리게. "Editable Ghosts" 를 켜면 편집도 된다
 *  - **Cubase 13 Key Editor 다중 파트** — 트랙마다 "표시"/"편집" 토글이 따로 있다
 *
 * 그래서 모드가 세 개다: 숨김 / 표시 / 편집.
 *
 * ## 시간축 변환이 이 파일의 존재 이유
 *
 * 고스트 클립은 자기 `startTick` 을 갖는다. 편집 중인 클립도 그렇다. 두 좌표계를
 * 맞추지 않으면 고스트가 엉뚱한 자리에 그려지는데, **그건 화면만 보고는 알 수 없다** —
 * 그럴듯하게 틀려 보인다. 그래서 순수 함수로 빼서 테스트한다.
 */

import type { Clip, Note, Project, TrackId } from '../model/project.ts';

/** 트랙별 고스트 표시 상태 */
export type GhostMode = 'hidden' | 'show' | 'edit';

/** 편집 중인 클립의 좌표계로 옮겨 놓은 고스트 노트 하나 */
export interface GhostNote {
  note: Note;
  /** **편집 중인 클립 기준** 틱 (음수일 수 있다 — 앞에서 넘어온 음) */
  startTick: number;
  /** 클립 끝에서 자른 뒤의 길이 */
  lengthTick: number;
  trackId: TrackId;
  /** 이 음을 여기서 고칠 수 있는가 */
  editable: boolean;
}

export interface GhostTrack {
  trackId: TrackId;
  name: string;
  mode: GhostMode;
  notes: GhostNote[];
}

/**
 * 지금 클립과 시간이 겹치는 다른 트랙의 음을 모은다.
 *
 * 편집 중인 트랙은 제외한다 — 자기 음은 이미 그려진다.
 * `hidden` 트랙은 목록에 남기되 `notes` 를 비운다 (토글 UI 가 트랙 이름을 보여야 한다).
 */
export function collectGhosts(
  project: Project,
  activeTrackId: TrackId | null,
  activeClip: Clip,
  modes: Readonly<Record<string, GhostMode>>,
): GhostTrack[] {
  const viewStart = activeClip.startTick;
  const viewEnd = activeClip.startTick + activeClip.lengthTick;

  const out: GhostTrack[] = [];
  for (const track of project.tracks) {
    if (track.id === activeTrackId) continue;

    const mode = modes[track.id] ?? 'hidden';
    const notes: GhostNote[] = [];

    if (mode !== 'hidden') {
      for (const clip of track.clips) {
        // 클립이 화면 구간과 안 겹치면 음을 볼 필요가 없다
        if (clip.startTick >= viewEnd || clip.startTick + clip.lengthTick <= viewStart) continue;
        const clipEnd = clip.startTick + clip.lengthTick;

        for (const note of clip.notes) {
          const absStart = clip.startTick + note.startTick;
          // 음이 자기 클립 끝을 넘으면 거기서 자른다 (스케줄러와 같은 규칙)
          const absEnd = Math.min(absStart + note.lengthTick, clipEnd);
          if (absEnd <= viewStart || absStart >= viewEnd) continue;

          notes.push({
            note,
            startTick: absStart - viewStart,
            lengthTick: Math.max(1, absEnd - absStart),
            trackId: track.id,
            editable: mode === 'edit',
          });
        }
      }
      notes.sort((a, b) => a.startTick - b.startTick);
    }

    out.push({ trackId: track.id, name: track.name, mode, notes });
  }
  return out;
}

/** 접기 계산에 넣을 음 높이 목록. 보이는 고스트만 센다 */
export function ghostMidis(ghosts: readonly GhostTrack[]): number[] {
  const out: number[] = [];
  for (const track of ghosts) {
    for (const ghost of track.notes) out.push(ghost.note.pitch.midi);
  }
  return out;
}

/** 편집 가능한 고스트 노트만 (선택·드래그 대상) */
export function editableGhosts(ghosts: readonly GhostTrack[]): GhostNote[] {
  return ghosts.filter((t) => t.mode === 'edit').flatMap((t) => t.notes);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import { PPQ } from '../model/time.ts';
import type { Project, TrackId } from '../model/project.ts';
import { collectGhosts, editableGhosts, ghostMidis } from './ghostNotes.ts';
import type { GhostMode } from './ghostNotes.ts';

/**
 * 트랙 2개.
 *  - A(편집 중): 2마디 지점부터 시작하는 클립
 *  - B(고스트): 0 부터 시작하는 클립. 음이 A 의 구간에 걸친다
 */
function twoTracks(): { project: Project; a: TrackId; b: TrackId } {
  const project = createEmptyProject('고스트 테스트');

  const a = createTrack({ name: '멜로디', instrumentId: 'acoustic-guitar' });
  const clipA = createClip({ startTick: 4 * PPQ, lengthTick: 4 * PPQ, label: 'A' });
  clipA.notes.push(createNote({ startTick: 0, lengthTick: PPQ, midi: 72 }));
  a.clips.push(clipA);

  const b = createTrack({ name: '베이스', instrumentId: 'electric-bass' });
  const clipB = createClip({ startTick: 0, lengthTick: 12 * PPQ, label: 'B' });
  clipB.notes.push(
    createNote({ startTick: 0, lengthTick: PPQ, midi: 40 }),        // 절대 0 — 화면 앞
    createNote({ startTick: 4 * PPQ, lengthTick: PPQ, midi: 43 }),  // 절대 4PPQ — 화면 시작
    createNote({ startTick: 6 * PPQ, lengthTick: PPQ, midi: 45 }),  // 절대 6PPQ — 화면 중간
    createNote({ startTick: 10 * PPQ, lengthTick: PPQ, midi: 47 }), // 절대 10PPQ — 화면 뒤
  );
  b.clips.push(clipB);

  project.tracks.push(a, b);
  return { project, a: a.id, b: b.id };
}

const activeClipOf = (project: Project) => project.tracks[0]!.clips[0]!;

test('편집 중인 트랙은 고스트에 안 들어간다', () => {
  const { project, a, b } = twoTracks();
  const ghosts = collectGhosts(project, a, activeClipOf(project), { [b]: 'show' });
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0]!.trackId, b);
});

test('숨김 트랙도 목록에 남지만 음은 비어 있다', () => {
  // 토글 UI 가 트랙 이름을 보여 줘야 한다
  const { project, a } = twoTracks();
  const ghosts = collectGhosts(project, a, activeClipOf(project), {});
  assert.equal(ghosts.length, 1);
  assert.equal(ghosts[0]!.mode, 'hidden');
  assert.deepEqual(ghosts[0]!.notes, []);
});

test('시간축을 편집 중인 클립 기준으로 옮긴다', () => {
  // 이걸 틀리면 고스트가 엉뚱한 자리에 그려지는데 화면만 보고는 알 수 없다
  const { project, a, b } = twoTracks();
  const ghosts = collectGhosts(project, a, activeClipOf(project), { [b]: 'show' });
  const ticks = ghosts[0]!.notes.map((g) => g.startTick);

  // 화면은 절대 4PPQ~8PPQ. 겹치는 음은 절대 4PPQ(→0) 와 6PPQ(→2PPQ)
  assert.deepEqual(ticks, [0, 2 * PPQ]);
});

test('화면 구간과 안 겹치는 음은 버린다', () => {
  const { project, a, b } = twoTracks();
  const ghosts = collectGhosts(project, a, activeClipOf(project), { [b]: 'show' });
  const midis = ghosts[0]!.notes.map((g) => g.note.pitch.midi);
  assert.ok(!midis.includes(40), '화면 앞의 음이 들어왔다');
  assert.ok(!midis.includes(47), '화면 뒤의 음이 들어왔다');
});

test('화면 경계에 걸친 긴 음은 살린다', () => {
  const { project, a, b } = twoTracks();
  // 절대 0 에서 시작해 6PPQ 까지 가는 음 — 화면(4PPQ~) 에 걸친다
  project.tracks[1]!.clips[0]!.notes[0]!.lengthTick = 6 * PPQ;

  const ghosts = collectGhosts(project, a, activeClipOf(project), { [b]: 'show' });
  const long = ghosts[0]!.notes.find((g) => g.note.pitch.midi === 40);
  assert.ok(long, '경계에 걸친 음이 사라졌다');
  assert.equal(long.startTick, -4 * PPQ, '앞에서 넘어온 음은 음수 위치여야 한다');
});

test('음이 자기 클립 끝을 넘으면 거기서 자른다', () => {
  // 스케줄러와 같은 규칙이어야 한다. 안 그러면 화면과 소리가 다르다
  const { project, a, b } = twoTracks();
  const clipB = project.tracks[1]!.clips[0]!;
  clipB.lengthTick = 7 * PPQ;                       // 절대 0~7PPQ
  clipB.notes[2]!.lengthTick = 8 * PPQ;             // 절대 6PPQ 에서 시작해 14PPQ 까지

  const ghosts = collectGhosts(project, a, activeClipOf(project), { [b]: 'show' });
  const clipped = ghosts[0]!.notes.find((g) => g.note.pitch.midi === 45);
  assert.ok(clipped);
  assert.equal(clipped.lengthTick, PPQ, '클립 끝(7PPQ)에서 잘려야 한다');
});

test('편집 모드일 때만 editable 이 붙는다', () => {
  const { project, a, b } = twoTracks();
  const shown = collectGhosts(project, a, activeClipOf(project), { [b]: 'show' });
  assert.ok(shown[0]!.notes.every((g) => !g.editable));
  assert.deepEqual(editableGhosts(shown), []);

  const editing = collectGhosts(project, a, activeClipOf(project), { [b]: 'edit' });
  assert.ok(editing[0]!.notes.every((g) => g.editable));
  assert.equal(editableGhosts(editing).length, 2);
});

test('접기용 음 높이 목록에 고스트가 들어간다', () => {
  // 안 넣으면 고스트가 접힌 줄에 숨어 안 보인다
  const { project, a, b } = twoTracks();
  const ghosts = collectGhosts(project, a, activeClipOf(project), { [b]: 'show' });
  assert.deepEqual(ghostMidis(ghosts).sort((x, y) => x - y), [43, 45]);

  const hidden = collectGhosts(project, a, activeClipOf(project), { [b]: 'hidden' });
  assert.deepEqual(ghostMidis(hidden), [], '숨긴 트랙이 줄을 만들었다');
});

test('모드를 안 준 트랙은 숨김으로 본다', () => {
  const { project, a } = twoTracks();
  const modes: Record<string, GhostMode> = {};
  const ghosts = collectGhosts(project, a, activeClipOf(project), modes);
  assert.equal(ghosts[0]!.mode, 'hidden');
});

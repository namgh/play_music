/**
 * 트랙 스택·보호·숨김 회귀 테스트 (`LOGIC_PARITY.md` 1-3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import { audibleTracks } from '../model/project.ts';
import type { Project } from '../model/project.ts';
import { roundTrip } from '../model/persistence.ts';
import { PPQ } from '../model/time.ts';
import { addNote, deleteTrack, moveNotes, updateTrack } from './edits.ts';
import {
  createStack, protectedChange, setTrackFlag, setTrackStack, toggleStackFlag, ungroupStack, updateStack,
} from './tracks.ts';

function band(): Project {
  const p = createEmptyProject('밴드');
  for (const name of ['킥', '베이스', '스네어', '기타']) {
    const t = createTrack({ name, instrumentId: 'acoustic-guitar' });
    const c = createClip({ startTick: 0, lengthTick: 4 * PPQ });
    c.notes.push(createNote({ startTick: 0, midi: 60 }));
    t.clips.push(c);
    p.tracks.push(t);
  }
  return p;
}
const names = (p: Project) => p.tracks.map((t) => t.name).join(' ');

test('스택에 넣으면 멤버가 붙는다, 빠지면 스택 아래로', () => {
  let p = band();
  const [kick, , snare] = p.tracks;
  const made = createStack(p, kick!.id, '드럼');
  p = setTrackStack(made.project, snare!.id, made.stackId);
  assert.equal(names(p), '킥 스네어 베이스 기타');
  assert.equal(p.stacks![0]!.name, '드럼');

  p = setTrackStack(p, snare!.id, null);
  assert.equal(names(p), '킥 스네어 베이스 기타', '빠져도 제자리');
  assert.equal(p.tracks[1]!.stackId, undefined);

  p = setTrackStack(p, kick!.id, null);
  assert.deepEqual(p.stacks, [], '빈 스택은 지운다');
});

test('스택 접기·이름·전체 뮤트·풀기', () => {
  let p = band();
  const [kick, bass] = p.tracks;
  const made = createStack(p, kick!.id);
  p = setTrackStack(made.project, bass!.id, made.stackId);
  p = updateStack(p, made.stackId, { collapsed: true, name: '리듬' });
  assert.deepEqual(p.stacks![0], { id: made.stackId, name: '리듬', collapsed: true });

  p = toggleStackFlag(p, made.stackId, 'mute');
  assert.deepEqual(audibleTracks(p).map((t) => t.name), ['스네어', '기타']);
  p = toggleStackFlag(p, made.stackId, 'mute');
  assert.equal(audibleTracks(p).length, 4);

  p = ungroupStack(p, made.stackId);
  assert.deepEqual(p.stacks, []);
  assert.ok(p.tracks.every((t) => t.stackId === undefined));
});

test('보호된 트랙의 음·클립·트랙 삭제는 막히고 볼륨·뮤트·숨김은 된다', () => {
  let p = band();
  const kick = p.tracks[0]!;
  p = setTrackFlag(p, kick.id, 'locked', true);
  const clipId = kick.clips[0]!.id;
  const noteId = kick.clips[0]!.notes[0]!.id;

  assert.equal(protectedChange(p, addNote(p, { clipId, startTick: PPQ, lengthTick: PPQ, midi: 62 }).project), '킥');
  assert.equal(protectedChange(p, moveNotes(p, [noteId], { semitones: 1 })), '킥');
  assert.equal(protectedChange(p, deleteTrack(p, kick.id)), '킥');
  assert.equal(protectedChange(p, updateTrack(p, kick.id, { instrumentId: 'kick' })), '킥');

  assert.equal(protectedChange(p, updateTrack(p, kick.id, { gain: 0.3, mute: true })), null);
  assert.equal(protectedChange(p, setTrackFlag(p, kick.id, 'hidden', true)), null);
  assert.equal(protectedChange(p, setTrackFlag(p, kick.id, 'locked', false)), null, '보호 풀기는 된다');
  const other = p.tracks[1]!;
  assert.equal(protectedChange(p, moveNotes(p, [other.clips[0]!.notes[0]!.id], { semitones: 1 })), null);
});

test('숨긴 트랙도 소리는 난다 · 저장 왕복', () => {
  let p = band();
  const made = createStack(p, p.tracks[0]!.id, '드럼');
  p = setTrackFlag(made.project, p.tracks[1]!.id, 'hidden', true);
  p = setTrackFlag(p, p.tracks[2]!.id, 'locked', true);
  assert.equal(audibleTracks(p).length, 4);
  assert.deepEqual(roundTrip(p), p);
  p = setTrackFlag(p, p.tracks[1]!.id, 'hidden', false);
  assert.equal('hidden' in p.tracks[1]!, false, '끄면 키가 사라진다');
});

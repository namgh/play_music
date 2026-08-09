/**
 * 편집 함수 회귀 테스트.
 *
 * 이 함수들은 Phase 3 에서 AI 가 호출할 대상이기도 하다 (`plan.md` 4절 ②).
 * 그래서 "UI 를 통해서만 맞으면 되는" 수준으로는 부족하고, 순수 함수로서
 * 불변성과 경계 동작이 고정돼 있어야 한다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import { PPQ } from '../model/time.ts';
import { pitchToHz } from '../model/pitch.ts';
import { isPitchEdited } from '../model/project.ts';
import type { Project } from '../model/project.ts';
import { History } from './history.ts';
import {
  addClip, addNote, addTrack, copyNotes, deleteClip, deleteNotes, deleteTrack, duplicateNotes,
  EditError, findNote, moveNotes, nudgeCents, pasteNotes, quantizeNotes, resizeClip, resizeNotes,
  setCents, setKey, setLengthBars, setLoop, setLoopEnabled, setPitchCurve, setTempo, setVelocity,
  updateTrack,
} from './edits.ts';

function base(): Project {
  const project = createEmptyProject('편집 테스트');
  const track = createTrack({ name: '기타', instrumentId: 'acoustic-guitar' });
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ, label: 'A' });
  clip.notes.push(
    createNote({ startTick: 0, lengthTick: PPQ, midi: 60 }),
    createNote({ startTick: PPQ, lengthTick: PPQ, midi: 64 }),
  );
  track.clips.push(clip);
  project.tracks.push(track);
  return project;
}

test('편집 함수는 입력을 바꾸지 않는다', () => {
  const before = base();
  const snapshot = JSON.stringify(before);
  const clipId = before.tracks[0]!.clips[0]!.id;

  addNote(before, { clipId, startTick: 2 * PPQ, lengthTick: PPQ, midi: 67 });
  deleteNotes(before, [before.tracks[0]!.clips[0]!.notes[0]!.id]);
  moveNotes(before, [before.tracks[0]!.clips[0]!.notes[0]!.id], { semitones: 5 });
  setTempo(before, 140);

  assert.equal(JSON.stringify(before), snapshot, '원본이 변형됐다');
});

test('노트 추가와 삭제', () => {
  const p0 = base();
  const clipId = p0.tracks[0]!.clips[0]!.id;

  const { project: p1, noteId } = addNote(p0, { clipId, startTick: 2 * PPQ, lengthTick: PPQ, midi: 67 });
  assert.equal(p1.tracks[0]!.clips[0]!.notes.length, 3);
  assert.ok(findNote(p1, noteId));

  const p2 = deleteNotes(p1, [noteId]);
  assert.equal(p2.tracks[0]!.clips[0]!.notes.length, 2);
  assert.equal(findNote(p2, noteId), null);
});

test('없는 클립에 노트를 넣으면 에러다', () => {
  assert.throws(
    () => addNote(base(), { clipId: 'clp_없음', startTick: 0, lengthTick: PPQ, midi: 60 }),
    EditError,
  );
});

test('반음 이동이 센트 미세조정을 지우지 않는다', () => {
  // 사용자가 맞춰 둔 미세조정이 이동 때문에 사라지면 정밀 편집이 무의미해진다
  const p0 = base();
  const id = p0.tracks[0]!.clips[0]!.notes[0]!.id;

  const tuned = nudgeCents(p0, [id], -14);
  const moved = moveNotes(tuned, [id], { semitones: 7 });
  const note = findNote(moved, id)!.note;

  assert.equal(note.pitch.midi, 67);
  assert.ok(Math.abs(note.pitch.cents - -14) < 1e-9, `센트가 ${note.pitch.cents} 로 변했다`);
});

test('센트 절대 지정과 상대 조정', () => {
  const p0 = base();
  const id = p0.tracks[0]!.clips[0]!.notes[0]!.id;

  const abs = setCents(p0, [id], -30);
  assert.ok(Math.abs(findNote(abs, id)!.note.pitch.cents - -30) < 1e-9);

  // 상대 조정이 누적된다
  let p = p0;
  for (let i = 0; i < 5; i++) p = nudgeCents(p, [id], 4);
  assert.ok(Math.abs(findNote(p, id)!.note.pitch.cents - 20) < 1e-9);

  // 반음 경계를 넘으면 midi 로 올라간다
  const over = nudgeCents(p0, [id], 80);
  assert.equal(findNote(over, id)!.note.pitch.midi, 61);
  assert.ok(Math.abs(findNote(over, id)!.note.pitch.cents - -20) < 1e-9);
});

test('센트 편집이 실제 주파수를 바꾼다', () => {
  const p0 = base();
  const id = p0.tracks[0]!.clips[0]!.notes[0]!.id;
  const before = pitchToHz(findNote(p0, id)!.note.pitch, p0.tuning);

  const p1 = setCents(p0, [id], -14);
  const after = pitchToHz(findNote(p1, id)!.note.pitch, p1.tuning);

  const cents = 1200 * Math.log2(after / before);
  assert.ok(Math.abs(cents - -14) < 1e-9, `${cents} 센트만 움직였다`);
});

test('여러 노트를 한 번에 편집한다', () => {
  const p0 = base();
  const ids = p0.tracks[0]!.clips[0]!.notes.map((n) => n.id);
  const p1 = moveNotes(p0, ids, { ticks: PPQ / 2, semitones: -12 });

  const notes = p1.tracks[0]!.clips[0]!.notes;
  assert.deepEqual(notes.map((n) => n.startTick), [PPQ / 2, PPQ * 1.5]);
  assert.deepEqual(notes.map((n) => n.pitch.midi), [48, 52]);
});

test('노트가 음수 시각으로 가지 않는다', () => {
  const p0 = base();
  const ids = p0.tracks[0]!.clips[0]!.notes.map((n) => n.id);
  const p1 = moveNotes(p0, ids, { ticks: -10 * PPQ });
  assert.deepEqual(p1.tracks[0]!.clips[0]!.notes.map((n) => n.startTick), [0, 0]);
});

test('길이 조절에 최소값이 있다', () => {
  const p0 = base();
  const id = p0.tracks[0]!.clips[0]!.notes[0]!.id;
  const min = PPQ / 8;
  const p1 = resizeNotes(p0, [id], -100 * PPQ, min);
  assert.equal(findNote(p1, id)!.note.lengthTick, min);
});

test('퀀타이즈는 시작 위치만 옮기고 길이는 두 손다', () => {
  const p0 = base();
  const id = p0.tracks[0]!.clips[0]!.notes[0]!.id;
  const shifted = moveNotes(p0, [id], { ticks: 37 });
  const grid = PPQ / 4;

  const q = quantizeNotes(shifted, [id], grid);
  const note = findNote(q, id)!.note;
  assert.equal(note.startTick % grid, 0);
  assert.equal(note.lengthTick, PPQ, '길이가 변했다');
});

test('"수정한 음" 판정이 편집을 따라간다', () => {
  const p0 = base();
  const id = p0.tracks[0]!.clips[0]!.notes[0]!.id;
  assert.equal(isPitchEdited(findNote(p0, id)!.note), false);

  assert.equal(isPitchEdited(findNote(setCents(p0, [id], -1), id)!.note), true);

  const curved = setPitchCurve(p0, [id], {
    glide: { cents: -24, ms: 60 }, vibrato: null, points: null,
  });
  assert.equal(isPitchEdited(findNote(curved, id)!.note), true);
});

test('세기는 0~1 로 제한된다', () => {
  const p0 = base();
  const ids = p0.tracks[0]!.clips[0]!.notes.map((n) => n.id);
  assert.equal(setVelocity(p0, ids, 5).tracks[0]!.clips[0]!.notes[0]!.velocity, 1);
  assert.equal(setVelocity(p0, ids, -5).tracks[0]!.clips[0]!.notes[0]!.velocity, 0);
});

test('트랙 추가·수정·삭제', () => {
  const p0 = base();
  const { project: p1, trackId } = addTrack(p0, { name: '베이스', instrumentId: 'electric-bass' });
  assert.equal(p1.tracks.length, 2);
  // 색은 순서대로 배정된다 (같은 색이 연달아 나오지 않게)
  assert.notEqual(p1.tracks[0]!.color, p1.tracks[1]!.color);

  const p2 = updateTrack(p1, trackId, { mute: true, gain: 0.5 });
  assert.equal(p2.tracks[1]!.mute, true);
  assert.equal(p2.tracks[1]!.gain, 0.5);

  assert.equal(deleteTrack(p2, trackId).tracks.length, 1);
});

test('겹치는 클립은 만들 수 없다', () => {
  const p0 = base();
  const trackId = p0.tracks[0]!.id;
  assert.throws(() => addClip(p0, { trackId, startTick: 2 * PPQ, lengthTick: 4 * PPQ }), /겹친/);
  // 딱 붙는 것은 겹치는 게 아니다
  const { project } = addClip(p0, { trackId, startTick: 4 * PPQ, lengthTick: 4 * PPQ });
  assert.equal(project.tracks[0]!.clips.length, 2);
});

test('클립을 줄여도 밖으로 나간 음은 지우지 않는다', () => {
  // 실수로 줄였을 때 음이 사라지면 언두 말고는 복구 방법이 없다.
  // 재생 시 스케줄러가 클립 끝에서 자른다
  const p0 = base();
  const clipId = p0.tracks[0]!.clips[0]!.id;
  const p1 = resizeClip(p0, clipId, PPQ / 2);
  assert.equal(p1.tracks[0]!.clips[0]!.notes.length, 2, '음이 사라졌다');
  assert.equal(p1.tracks[0]!.clips[0]!.lengthTick, PPQ / 2);
});

test('클립 삭제', () => {
  const p0 = base();
  assert.equal(deleteClip(p0, p0.tracks[0]!.clips[0]!.id).tracks[0]!.clips.length, 0);
});

test('템포·길이에 범위가 있다', () => {
  const p0 = base();
  assert.equal(setTempo(p0, 5).tempo.bpm, 20);
  assert.equal(setTempo(p0, 9999).tempo.bpm, 300);
  assert.equal(setLengthBars(p0, 0).lengthBars, 1);
  assert.equal(setLengthBars(p0, 12.4).lengthBars, 12);
});

// --- 언두 -------------------------------------------------------------------

test('언두·리두', () => {
  const history = new History(base());
  const clipId = history.state.tracks[0]!.clips[0]!.id;

  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);

  history.commit(addNote(history.state, { clipId, startTick: 2 * PPQ, lengthTick: PPQ, midi: 67 }).project);
  assert.equal(history.state.tracks[0]!.clips[0]!.notes.length, 3);
  assert.equal(history.canUndo, true);

  history.undo();
  assert.equal(history.state.tracks[0]!.clips[0]!.notes.length, 2);
  assert.equal(history.canRedo, true);

  history.redo();
  assert.equal(history.state.tracks[0]!.clips[0]!.notes.length, 3);
});

test('새 편집을 하면 리두 가지가 버려진다', () => {
  const history = new History(base());
  const clipId = history.state.tracks[0]!.clips[0]!.id;

  history.commit(addNote(history.state, { clipId, startTick: 2 * PPQ, lengthTick: PPQ, midi: 67 }).project);
  history.undo();
  assert.equal(history.canRedo, true);

  history.commit(setTempo(history.state, 140));
  assert.equal(history.canRedo, false, '리두가 남아 있으면 히스토리가 갈라진다');
});

test('replace 는 히스토리를 남기지 않는다', () => {
  // 드래그 중간 상태를 매 프레임 커밋하면 언두를 100번 눌러야 원위치가 된다
  const history = new History(base());
  const ids = history.state.tracks[0]!.clips[0]!.notes.map((n) => n.id);

  history.commit(moveNotes(history.state, ids, { ticks: 10 })); // 드래그 시작
  for (let i = 0; i < 50; i++) history.replace(moveNotes(history.state, ids, { ticks: 1 }));

  assert.equal(history.depth.past, 1, `언두 단계가 ${history.depth.past} 개로 늘어났다`);
  history.undo();
  assert.deepEqual(history.state.tracks[0]!.clips[0]!.notes.map((n) => n.startTick), [0, PPQ]);
});

test('히스토리 상한을 넘으면 오래된 것이 빠진다', () => {
  const history = new History(base(), { limit: 5 });
  for (let i = 0; i < 20; i++) history.commit(setTempo(history.state, 100 + i));
  assert.equal(history.depth.past, 5);
});

test('넘긴 객체를 나중에 변형해도 히스토리가 오염되지 않는다', () => {
  // 현실적인 사고: 커밋한 프로젝트의 참조를 들고 있다가 나중에 손대는 경우.
  // (반대로 history.state 를 직접 변형하는 것은 계약 위반이다 — Redux 와 같은 규칙)
  const history = new History(base());
  const edited = setTempo(history.state, 140);
  history.commit(edited);

  edited.tempo.bpm = 999;
  edited.tracks[0]!.clips[0]!.notes.length = 0;

  assert.equal(history.state.tempo.bpm, 140, '커밋한 상태가 오염됐다');
  assert.equal(history.state.tracks[0]!.clips[0]!.notes.length, 2);
});

test('생성자에 넘긴 객체를 변형해도 초기 스냅샷이 안전하다', () => {
  const initial = base();
  const originalBpm = initial.tempo.bpm;
  const history = new History(initial);

  history.commit(setTempo(history.state, 140));
  initial.tempo.bpm = 999;
  initial.tracks.length = 0;

  history.undo();
  assert.equal(history.state.tempo.bpm, originalBpm, '초기 상태가 오염됐다');
  assert.equal(history.state.tracks.length, 1);
});

// ---------------------------------------------------------------------------
// 복사 · 붙여넣기 · 복제 (`WORKPLAN.md` Tier 0)
//
// 작곡의 대부분이 반복과 변형이다. 이게 없으면 곡을 끝낼 수 없다.
// ---------------------------------------------------------------------------

test('복사는 시작 틱을 가장 이른 음 기준 상대값으로 바꾼다', () => {
  // 절대 위치로 들고 있으면 어디에 붙여도 원래 자리로 돌아간다
  const p = base();
  const [a, b] = p.tracks[0]!.clips[0]!.notes;
  const copied = copyNotes(p, [a!.id, b!.id]);

  assert.equal(copied.length, 2);
  assert.equal(copied[0]!.startTick, 0, '첫 음이 0 이 아니다');
  assert.equal(copied[1]!.startTick, PPQ, '상대 간격이 보존되지 않았다');
});

test('복사는 선택 안 한 음을 가져오지 않는다', () => {
  const p = base();
  const only = p.tracks[0]!.clips[0]!.notes[1]!;
  const copied = copyNotes(p, [only.id]);
  assert.equal(copied.length, 1);
  assert.equal(copied[0]!.pitch.midi, 64);
  assert.equal(copied[0]!.startTick, 0, '혼자 복사하면 원점이 0 이어야 한다');
});

test('붙여넣기는 id 를 새로 발급한다', () => {
  // 같은 id 가 두 개면 언두·선택·AI 지시가 어느 쪽을 가리키는지 알 수 없다
  const p = base();
  const clipId = p.tracks[0]!.clips[0]!.id;
  const copied = copyNotes(p, p.tracks[0]!.clips[0]!.notes.map((n) => n.id));

  const { project: next, noteIds } = pasteNotes(p, clipId, copied, 2 * PPQ);
  const all = next.tracks[0]!.clips[0]!.notes;

  assert.equal(all.length, 4, '2개를 붙였는데 개수가 안 맞는다');
  assert.equal(new Set(all.map((n) => n.id)).size, 4, 'id 가 중복됐다');
  for (const id of noteIds) assert.ok(findNote(next, id), '돌려준 id 로 음을 찾을 수 없다');
});

test('붙여넣기는 지정한 위치를 원점으로 삼는다', () => {
  const p = base();
  const clipId = p.tracks[0]!.clips[0]!.id;
  const copied = copyNotes(p, p.tracks[0]!.clips[0]!.notes.map((n) => n.id));

  const { project: next, noteIds } = pasteNotes(p, clipId, copied, 2 * PPQ);
  const pasted = noteIds.map((id) => findNote(next, id)!.note).sort((a, b) => a.startTick - b.startTick);

  assert.equal(pasted[0]!.startTick, 2 * PPQ);
  assert.equal(pasted[1]!.startTick, 3 * PPQ, '상대 간격이 안 지켜졌다');
});

test('붙여넣은 음의 곡선은 원본과 따로 움직인다', () => {
  // 얕은 복사로 공유되면 한쪽을 고칠 때 다른 쪽도 바뀐다
  const p0 = base();
  const source = p0.tracks[0]!.clips[0]!.notes[0]!;
  const p = setPitchCurve(p0, [source.id], {
    glide: { cents: -200, ms: 90 }, vibrato: null, points: null,
  });
  const clipId = p.tracks[0]!.clips[0]!.id;

  const copied = copyNotes(p, [source.id]);
  const { project: next, noteIds } = pasteNotes(p, clipId, copied, 2 * PPQ);

  const pastedNote = findNote(next, noteIds[0]!)!.note;
  const originalNote = findNote(next, source.id)!.note;
  assert.notEqual(pastedNote.pitchCurve, originalNote.pitchCurve, '곡선 객체가 공유됐다');
  assert.equal(pastedNote.pitchCurve!.glide!.cents, -200, '곡선 값이 안 따라왔다');
});

test('붙여넣기는 음수 위치로 밀리지 않는다', () => {
  const p = base();
  const clipId = p.tracks[0]!.clips[0]!.id;
  const copied = copyNotes(p, p.tracks[0]!.clips[0]!.notes.map((n) => n.id));
  const { project: next, noteIds } = pasteNotes(p, clipId, copied, -5 * PPQ);
  for (const id of noteIds) {
    assert.ok(findNote(next, id)!.note.startTick >= 0, '음이 클립 앞으로 나갔다');
  }
});

test('복제는 선택 구간 바로 뒤에 놓아 겹치지 않는다', () => {
  const p = base(); // 0~PPQ, PPQ~2PPQ → 구간 길이 2PPQ
  const ids = p.tracks[0]!.clips[0]!.notes.map((n) => n.id);

  const { project: next, noteIds } = duplicateNotes(p, ids);
  const made = noteIds.map((id) => findNote(next, id)!.note).sort((a, b) => a.startTick - b.startTick);

  assert.equal(made.length, 2);
  assert.equal(made[0]!.startTick, 2 * PPQ, '원본 구간과 겹친다');
  assert.equal(made[1]!.startTick, 3 * PPQ);
  assert.equal(next.tracks[0]!.clips[0]!.notes.length, 4);
});

test('빈 선택으로 복사·복제하면 아무 일도 없다', () => {
  const p = base();
  assert.deepEqual(copyNotes(p, []), []);
  const dup = duplicateNotes(p, []);
  assert.equal(dup.project, p, '프로젝트를 새로 만들었다');
  assert.deepEqual(dup.noteIds, []);
});

test('없는 클립에 붙이면 명시적으로 실패한다', () => {
  const p = base();
  const copied = copyNotes(p, [p.tracks[0]!.clips[0]!.notes[0]!.id]);
  assert.throws(() => pasteNotes(p, 'clp_없음' as never, copied, 0), EditError);
});

// ---------------------------------------------------------------------------
// 루프 · 조성
// ---------------------------------------------------------------------------

test('루프 구간은 정렬해서 담는다 — 거꾸로 드래그해도 유효해야 한다', () => {
  const p = base();
  const next = setLoop(p, { startTick: 4 * PPQ, endTick: PPQ, enabled: true });
  assert.equal(next.loop!.startTick, PPQ);
  assert.equal(next.loop!.endTick, 4 * PPQ);
});

test('길이 0 루프는 버린다', () => {
  // 길이 0 구간을 반복하면 재생이 멈춘 것처럼 보이고 원인을 찾기 어렵다
  const p = base();
  assert.equal(setLoop(p, { startTick: PPQ, endTick: PPQ, enabled: true }).loop, null);
});

test('루프를 껐다 켜도 구간이 남는다', () => {
  const p = setLoop(base(), { startTick: 0, endTick: 2 * PPQ, enabled: true });
  const off = setLoopEnabled(p, false);
  assert.equal(off.loop!.enabled, false);
  assert.equal(off.loop!.endTick, 2 * PPQ, '껐더니 구간이 사라졌다');
  assert.equal(setLoopEnabled(off, true).loop!.enabled, true);
});

test('조성을 넣고 지울 수 있다', () => {
  const p = setKey(base(), { tonic: 'D', mode: 'minor' });
  assert.deepEqual(p.key, { tonic: 'D', mode: 'minor' });
  assert.equal(setKey(p, null).key, null);
});

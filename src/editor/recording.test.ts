/**
 * 녹음·테이크·컴핑 (`LOGIC_PARITY.md` 1-7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import type { Project } from '../model/project.ts';
import { roundTrip } from '../model/persistence.ts';
import { PPQ } from '../model/time.ts';
import { commitRecording, compFromTake, deleteTake, NoteRecorder, playedToNotes, switchTake } from './recording.ts';

function song(): Project {
  const p = createEmptyProject('녹음');
  const t = createTrack({ name: '피아노', instrumentId: 'acoustic-piano' });
  const c = createClip({ startTick: 4 * PPQ, lengthTick: 4 * PPQ });
  c.notes.push(createNote({ startTick: 0, midi: 60 }), createNote({ startTick: 2 * PPQ, midi: 62 }));
  t.clips.push(c);
  p.tracks.push(t);
  return p;
}
const clipOf = (p: Project) => p.tracks[0]!.clips[0]!;
const pitches = (p: Project) => clipOf(p).notes.map((n) => n.pitch.midi).sort((a, b) => a - b);

test('받기 — 눌렀다 뗀 길이, 같은 음 다시 누르면 앞 음 끝, 멈출 때 남은 음 끝', () => {
  const r = new NoteRecorder();
  r.noteOn(60, 0.8, 4 * PPQ);
  r.noteOn(64, 0.6, 4 * PPQ + 10);
  r.noteOff(60, 5 * PPQ);
  r.noteOn(64, 0.7, 6 * PPQ);
  const played = r.finish(7 * PPQ);
  assert.deepEqual(played.map((p) => [p.midi, p.onTick - 4 * PPQ, (p.offTick ?? 0) - p.onTick]),
    [[60, 0, PPQ], [64, 10, 2 * PPQ - 10], [64, 2 * PPQ, PPQ]]);
  const notes = playedToNotes(played, 4 * PPQ, { quantize: PPQ / 4 });
  assert.deepEqual(notes.map((n) => n.startTick), [0, 0, 2 * PPQ], '녹음 퀀타이즈');
});

test('겹쳐 녹음은 더하고, 바꿔 녹음은 구간의 옛 음을 테이크로 남긴다', () => {
  const p = song();
  const id = clipOf(p).id;
  const fresh = [createNote({ startTick: PPQ, midi: 67 })];
  assert.deepEqual(pitches(commitRecording(p, id, fresh, 'overdub', { from: 0, to: 4 * PPQ })), [60, 62, 67]);
  const r = commitRecording(p, id, fresh, 'replace', { from: 0, to: PPQ * 3 });
  assert.deepEqual(pitches(r), [67]);
  assert.equal(clipOf(r).takes!.length, 1);
  assert.deepEqual(clipOf(r).takes![0]!.notes.map((n) => n.pitch.midi), [60, 62]);
  const partial = commitRecording(p, id, fresh, 'replace', { from: 0, to: PPQ });
  assert.deepEqual(pitches(partial), [62, 67], '구간 밖 음은 남는다');
});

test('빈 자리에 처음 녹음하면 테이크를 만들지 않는다 · 클립 끝을 넘으면 늘린다', () => {
  const p = song();
  const id = clipOf(p).id;
  const r = commitRecording(p, id, [createNote({ startTick: 3 * PPQ, midi: 70, lengthTick: 3 * PPQ })], 'replace', { from: 3 * PPQ, to: 6 * PPQ });
  assert.equal(clipOf(r).takes, undefined);
  assert.equal(clipOf(r).lengthTick, 6 * PPQ);
});

test('테이크 고르기는 자리를 바꾸고, 컴핑은 구간만 바꾼다, 저장 왕복', () => {
  let p = song();
  const id = clipOf(p).id;
  p = commitRecording(p, id, [createNote({ startTick: 0, midi: 72 }), createNote({ startTick: 2 * PPQ, midi: 74 })], 'replace', { from: 0, to: 4 * PPQ });
  const takeId = clipOf(p).takes![0]!.id;
  const comped = compFromTake(p, id, takeId, 0, PPQ);
  assert.deepEqual(pitches(comped), [60, 74], '첫 박만 옛 테이크로');
  assert.deepEqual(clipOf(comped).takes![0]!.notes.map((n) => n.pitch.midi).sort(), [62, 72]);
  const swapped = switchTake(p, id, takeId);
  assert.deepEqual(pitches(swapped), [60, 62]);
  assert.deepEqual(clipOf(swapped).takes![0]!.notes.map((n) => n.pitch.midi).sort(), [72, 74]);
  assert.deepEqual(roundTrip(comped), comped);
  assert.equal(clipOf(deleteTake(p, id, takeId)).takes, undefined);
});

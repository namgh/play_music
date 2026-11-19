import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aliasToCopy, makeAlias, syncAliases } from './aliases.ts';
import { addNote, deleteClip } from './edits.ts';
import { roundTrip } from '../model/persistence.ts';
import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';

function song() {
  const p = createEmptyProject('a');
  const t = createTrack({ name: '피아노', instrumentId: 'acoustic-piano' });
  const c = createClip({ startTick: 0, lengthTick: 1920 });
  c.notes.push(createNote({ startTick: 0, lengthTick: 480, midi: 60 }));
  t.clips.push(c);
  p.tracks.push(t);
  return { p, t, c };
}

test('에일리어스 — 원본 뒤에 생기고, 원본을 고치면 따라온다', () => {
  const { p, c } = song();
  const made = makeAlias(p, c.id);
  const alias = made.project.tracks[0]!.clips.find((x) => x.id === made.clipId)!;
  assert.equal(alias.startTick, 1920);
  assert.equal(alias.aliasOf, c.id);
  assert.equal(alias.notes.length, 1);
  assert.notEqual(alias.notes[0]!.id, c.notes[0]!.id, '음 id 는 클립마다 다르다');
  const edited = syncAliases(made.project, addNote(made.project, { clipId: c.id, startTick: 960, lengthTick: 240, midi: 64 }).project);
  assert.deepEqual(edited.tracks[0]!.clips.find((x) => x.id === made.clipId)!.notes.map((n) => n.pitch.midi).sort(), [60, 64]);
});

test('에일리어스를 고치면 원본으로 올라간다', () => {
  const { p, c } = song();
  const made = makeAlias(p, c.id);
  const after = addNote(made.project, { clipId: made.clipId, startTick: 480, lengthTick: 240, midi: 67 }).project;
  const synced = syncAliases(made.project, after);
  assert.deepEqual(synced.tracks[0]!.clips.find((x) => x.id === c.id)!.notes.map((n) => n.pitch.midi).sort(), [60, 67]);
  // 원본 음 id 는 원본 꼴 그대로 (꼬리가 붙지 않는다)
  assert.ok(synced.tracks[0]!.clips.find((x) => x.id === c.id)!.notes.every((n) => !n.id.includes('~')));
});

test('원본을 지우면 보통 클립 · 진짜 복사로 바꾸기 · 저장', () => {
  const { p, c } = song();
  const made = makeAlias(p, c.id);
  assert.equal(roundTrip(made.project).tracks[0]!.clips[1]!.aliasOf, c.id);
  const gone = syncAliases(made.project, deleteClip(made.project, c.id));
  const left = gone.tracks[0]!.clips[0]!;
  assert.equal(left.aliasOf, undefined);
  assert.equal(left.notes.length, 1);
  const copy = aliasToCopy(made.project, made.clipId);
  assert.equal(copy.tracks[0]!.clips[1]!.aliasOf, undefined);
});

test('에일리어스 — 바로 뒤가 차 있으면 다음 빈자리', () => {
  const { p, c } = song();
  const blocker = createClip({ startTick: 1920, lengthTick: 960 });
  p.tracks[0]!.clips.push(blocker);
  const made = makeAlias(p, c.id);
  assert.equal(made.project.tracks[0]!.clips.find((x) => x.id === made.clipId)!.startTick, 2880);
});

test('오디오 에일리어스 — 다듬기·게인을 원본과 같이, 에일리어스에서 고쳐도 원본으로', () => {
  const p = createEmptyProject('o');
  const t = createTrack({ name: '보컬', instrumentId: 'acoustic-guitar' });
  const c = createClip({ startTick: 0, lengthTick: 1920 });
  c.audio = { assetId: 'a', name: 'v', assetSec: 4, offsetSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, reverse: false };
  t.clips.push(c);
  p.tracks.push(t);
  const made = makeAlias(p, c.id);
  const alias = made.project.tracks[0]!.clips.find((x) => x.id === made.clipId)!;
  assert.equal(alias.audio!.assetId, 'a');
  const edited = { ...made.project, tracks: made.project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((x) => (x.id === c.id ? { ...x, audio: { ...x.audio!, gainDb: -6 } } : x)) })) };
  const s1 = syncAliases(made.project, edited);
  assert.equal(s1.tracks[0]!.clips.find((x) => x.id === made.clipId)!.audio!.gainDb, -6);
  const viaAlias = { ...s1, tracks: s1.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((x) => (x.id === made.clipId ? { ...x, audio: { ...x.audio!, offsetSec: 0.5 } } : x)) })) };
  const s2 = syncAliases(s1, viaAlias);
  assert.equal(s2.tracks[0]!.clips.find((x) => x.id === c.id)!.audio!.offsetSec, 0.5);
});

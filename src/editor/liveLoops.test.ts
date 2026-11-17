/**
 * 라이브 루프 (`LOGIC_PARITY.md` 1-5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import type { Project } from '../model/project.ts';
import { roundTrip } from '../model/persistence.ts';
import { PPQ } from '../model/time.ts';
import { collectNoteEvents } from '../audio/scheduler.ts';
import { addSection } from './arrangement.ts';
import { addScenes, arrangeScenes, captureScene, clearCell, performanceProject, removeScene, scenesFromSections } from './liveLoops.ts';

const BAR = 4 * PPQ;

function song(): Project {
  let p = createEmptyProject('라이브');
  p.lengthBars = 4;
  const drum = createTrack({ name: '드럼', instrumentId: 'kick' });
  const keys = createTrack({ name: '건반', instrumentId: 'acoustic-piano' });
  const d = createClip({ startTick: 0, lengthTick: 4 * BAR });
  for (let i = 0; i < 4; i++) d.notes.push(createNote({ startTick: i * BAR, midi: 36 }));
  const k = createClip({ startTick: 2 * BAR, lengthTick: 2 * BAR });
  k.notes.push(createNote({ startTick: 0, midi: 60 }), createNote({ startTick: BAR, midi: 65 }));
  drum.clips.push(d);
  keys.clips.push(k);
  p.tracks.push(drum, keys);
  p = addSection(p, { startTick: 0, lengthTick: 2 * BAR, name: 'A' }).project;
  p = addSection(p, { startTick: 2 * BAR, lengthTick: 2 * BAR, name: 'B' }).project;
  return p;
}

test('구간에서 장면 — 음이 있는 트랙만 칸이 된다', () => {
  const scenes = scenesFromSections(song());
  assert.deepEqual(scenes.map((s) => [s.name, s.cells.length]), [['A', 1], ['B', 2]]);
  assert.deepEqual(scenes[1]!.cells[1]!.notes.map((n) => [n.startTick / BAR, n.pitch.midi]), [[0, 60], [1, 65]]);
});

test('연주용 곡 — 켜진 칸만, 칸 길이의 최소공배수로 반복', () => {
  let p = song();
  const short = captureScene(p, 0, BAR, '짧은');
  p = addScenes(p, [...scenesFromSections(p), short]);
  const [, b, s] = p.liveScenes!;
  const perf = performanceProject(p, { [p.tracks[0]!.id]: s!.id, [p.tracks[1]!.id]: b!.id });
  assert.equal(perf.loopTicks, 2 * BAR);
  assert.deepEqual(perf.project.loop, { startTick: 0, endTick: 2 * BAR, enabled: true });
  const events = collectNoteEvents(perf.project, 0, 2 * BAR).map((e) => `${e.startTick / BAR}:${e.note.pitch.midi}`);
  assert.deepEqual(events, ['0:36', '0:60', '1:36', '1:65']);
  assert.equal(p.tracks[0]!.clips[0]!.notes.length, 4, '원래 곡은 그대로');
  const silent = performanceProject(p, {});
  assert.ok(silent.project.tracks.every((t) => t.clips.length === 0));
});

test('편곡으로 — 장면을 곡 끝에 차례로 붙이고 구간으로 남긴다', () => {
  let p = song();
  p = addScenes(p, scenesFromSections(p));
  const [a, b] = p.liveScenes!;
  const arranged = arrangeScenes(p, [b!.id, a!.id, b!.id]);
  assert.equal(arranged.lengthBars, 10);
  assert.deepEqual(arranged.sections!.slice(2).map((s) => [s.name, s.startTick / BAR]), [['B', 4], ['A', 6], ['B', 8]]);
  assert.deepEqual(arranged.tracks[1]!.clips.map((c) => c.startTick / BAR), [2, 4, 8]);
  assert.deepEqual(roundTrip(arranged), arranged);
});

test('장면·칸 지우기', () => {
  const base = song();
  let p = addScenes(base, scenesFromSections(base));
  const id = p.liveScenes![1]!.id;
  p = clearCell(p, id, p.tracks[1]!.id);
  assert.equal(p.liveScenes![1]!.cells.length, 1);
  p = removeScene(removeScene(p, id), p.liveScenes![0]!.id);
  assert.equal('liveScenes' in p, false);
});

/**
 * 스텝 시퀀서 (`LOGIC_PARITY.md` 1-5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createTrack } from '../model/factory.ts';
import type { Project } from '../model/project.ts';
import { PPQ } from '../model/time.ts';
import { clipCovering, ensureClipFor, setRatchet, stepRow, toggleStep } from './steps.ts';

const S16 = PPQ / 4;

function drums(): Project {
  const p = createEmptyProject('비트');
  const kick = createTrack({ name: '킥', instrumentId: 'kick' });
  kick.clips.push(createClip({ startTick: 0, lengthTick: 4 * PPQ }));
  p.tracks.push(kick, createTrack({ name: '하이햇', instrumentId: 'hihat' }));
  return p;
}

test('칸 켜기·끄기 — 칸 하나 = 그 자리에서 시작하는 음 하나', () => {
  let p = drums();
  const clipId = p.tracks[0]!.clips[0]!.id;
  for (const step of [0, 4, 8, 12]) p = toggleStep(p, clipId, { midi: 36, step, rate: S16, velocity: 0.9, gate: 0.5 }).project;
  const row = stepRow(p.tracks[0]!.clips[0]!, 36, S16, 16);
  assert.deepEqual(row.map((c) => (c.note ? 'x' : '.')).join(''), 'x...x...x...x...');
  assert.equal(row[0]!.note!.lengthTick, S16 / 2, '게이트 ½');
  const off = toggleStep(p, clipId, { midi: 36, step: 4, rate: S16, velocity: 0.9, gate: 1 });
  assert.equal(off.on, false);
  assert.deepEqual(stepRow(off.project.tracks[0]!.clips[0]!, 36, S16, 16).map((c) => (c.note ? 'x' : '.')).join(''), 'x.......x...x...');
});

test('다른 음높이는 다른 줄 — 같은 칸이라도 따로 켠다', () => {
  let p = drums();
  const clipId = p.tracks[0]!.clips[0]!.id;
  p = toggleStep(p, clipId, { midi: 60, step: 0, rate: S16, velocity: 0.8, gate: 1 }).project;
  p = toggleStep(p, clipId, { midi: 64, step: 0, rate: S16, velocity: 0.8, gate: 1 }).project;
  assert.equal(p.tracks[0]!.clips[0]!.notes.length, 2);
  assert.equal(stepRow(p.tracks[0]!.clips[0]!, null, S16, 16)[0]!.count, 2);
});

test('래칫 — 칸을 똑같이 나눠 되풀이, 1 이면 하나로', () => {
  let p = drums();
  const clipId = p.tracks[0]!.clips[0]!.id;
  p = toggleStep(p, clipId, { midi: 42, step: 2, rate: S16, velocity: 0.7, gate: 1 }).project;
  const firstId = p.tracks[0]!.clips[0]!.notes[0]!.id;
  p = setRatchet(p, clipId, 2, S16, 42, 4);
  const notes = p.tracks[0]!.clips[0]!.notes;
  assert.deepEqual(notes.map((n) => n.startTick - 2 * S16), [0, 60, 120, 180]);
  assert.equal(notes[0]!.id, firstId);
  assert.equal(new Set(notes.map((n) => n.id)).size, 4);
  assert.equal(setRatchet(p, clipId, 2, S16, 42, 1).tracks[0]!.clips[0]!.notes.length, 1);
});

test('드럼 줄 클립 — 덮는 클립을 찾고 없으면 같은 범위로 만든다', () => {
  const p = drums();
  assert.ok(clipCovering(p.tracks[0]!, 0, 4 * PPQ));
  assert.equal(clipCovering(p.tracks[1]!, 0, 4 * PPQ), null);
  const made = ensureClipFor(p, p.tracks[1]!.id, 0, 4 * PPQ);
  assert.deepEqual([made.project.tracks[1]!.clips[0]!.startTick, made.project.tracks[1]!.clips[0]!.lengthTick], [0, 4 * PPQ]);
  assert.equal(ensureClipFor(made.project, p.tracks[1]!.id, 0, 4 * PPQ).clipId, made.clipId);
});

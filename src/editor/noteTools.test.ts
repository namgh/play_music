/**
 * 음 도구 회귀 테스트 (`LOGIC_PARITY.md` 1-5 피아노 롤 기능).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import type { Project } from '../model/project.ts';
import { PPQ } from '../model/time.ts';
import { setCents } from './edits.ts';
import { extractVoice, forceLegato, humanize, removeOverlaps, scaleQuantize, scaleVelocity } from './noteTools.ts';

function withNotes(spec: [start: number, midi: number, len?: number][]): Project {
  const p = createEmptyProject('음 도구');
  const t = createTrack({ name: '피아노', instrumentId: 'acoustic-piano' });
  const c = createClip({ startTick: 0, lengthTick: 8 * PPQ });
  for (const [start, midi, len] of spec) c.notes.push(createNote({ startTick: start * PPQ, midi, lengthTick: (len ?? 1) * PPQ }));
  t.clips.push(c);
  p.tracks.push(t);
  return p;
}
const notes = (p: Project, track = 0) => p.tracks[track]!.clips[0]!.notes;
const allIds = (p: Project) => notes(p).map((n) => n.id);

test('스케일 퀀타이즈 — 밖의 음은 가까운 스케일 음으로, 같은 거리면 아래로, 센트는 유지', () => {
  let p = withNotes([[0, 61], [1, 66], [2, 60], [3, 70]]);
  p = setCents(p, [notes(p)[0]!.id], 12);
  const q = scaleQuantize(p, allIds(p), { tonic: 'C', mode: 'major' });
  assert.deepEqual(notes(q).map((n) => n.pitch.midi), [60, 65, 60, 69]);
  assert.equal(notes(q)[0]!.pitch.cents, 12);
  const m = scaleQuantize(withNotes([[0, 64]]), allIds(withNotes([[0, 64]])), { tonic: 'A', mode: 'minor' });
  assert.equal(notes(m)[0]!.pitch.midi, 64, 'A 단조의 E 는 그대로');
});

test('레가토 — 다음 음 시작까지, 화음은 함께', () => {
  const p = withNotes([[0, 60, 0.5], [0, 64, 0.25], [2, 62, 0.5], [3, 65, 0.25]]);
  const q = forceLegato(p, allIds(p));
  assert.deepEqual(notes(q).map((n) => n.lengthTick / PPQ), [2, 2, 1, 0.25]);
});

test('겹침 없애기 — 같은 음높이만 끊는다', () => {
  const p = withNotes([[0, 60, 3], [1, 60, 1], [0, 64, 3]]);
  const q = removeOverlaps(p, allIds(p));
  assert.deepEqual(notes(q).map((n) => n.lengthTick / PPQ), [1, 1, 3]);
});

test('세기 배율은 0.01~1 로 자른다', () => {
  const p = withNotes([[0, 60], [1, 62]]);
  assert.deepEqual(notes(scaleVelocity(p, allIds(p), 2)).map((n) => n.velocity), [1, 1]);
  assert.deepEqual(notes(scaleVelocity(p, allIds(p), 0.5)).map((n) => n.velocity), [0.4, 0.4]);
});

test('사람처럼 — 같은 씨앗이면 같은 결과, 범위 안', () => {
  const p = withNotes([[1, 60], [2, 62], [3, 64]]);
  const a = humanize(p, allIds(p), { timingTicks: 20, velocity: 0.1, seed: 7 });
  const b = humanize(p, allIds(p), { timingTicks: 20, velocity: 0.1, seed: 7 });
  assert.deepEqual(a, b);
  notes(a).forEach((n, i) => {
    assert.ok(Math.abs(n.startTick - (i + 1) * PPQ) <= 20);
    assert.ok(Math.abs(n.velocity - 0.8) <= 0.1 + 1e-9);
  });
  assert.notDeepEqual(notes(a), notes(humanize(p, allIds(p), { timingTicks: 20, velocity: 0.1, seed: 8 })));
});

test('성부 떼어내기 — 화음의 윗음을 새 트랙으로, 혼자인 음은 남긴다', () => {
  const p = withNotes([[0, 60], [0, 64], [0, 67], [1, 62], [2, 65], [2, 69]]);
  const { project: q, moved } = extractVoice(p, allIds(p), 'top');
  assert.equal(moved, 2);
  assert.deepEqual(q.tracks.map((t) => t.name), ['피아노', '피아노 윗성부']);
  assert.deepEqual(notes(q, 1).map((n) => n.pitch.midi), [67, 69]);
  assert.deepEqual(notes(q, 0).map((n) => n.pitch.midi), [60, 64, 62, 65]);
  const bottom = extractVoice(p, allIds(p), 'bottom').project;
  assert.deepEqual(notes(bottom, 1).map((n) => n.pitch.midi), [60, 65]);
  assert.throws(() => extractVoice(withNotes([[0, 60], [1, 62]]), allIds(withNotes([[0, 60]])), 'top'));
});

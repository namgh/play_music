/**
 * 세션 연주자 (`LOGIC_PARITY.md` 1-6) — 규칙 기반, 결정적.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyProject, createTrack } from '../model/factory.ts';
import type { Project } from '../model/project.ts';
import { PPQ } from '../model/time.ts';
import { addChord, addSection } from './arrangement.ts';
import { generateBass, generateDrums, generateKeys } from './sessionPlayers.ts';

const BAR = 4 * PPQ;

function band(): Project {
  let p = createEmptyProject('세션');
  p.lengthBars = 8;
  for (const [name, id] of [['킥', 'kick'], ['스네어', 'snare'], ['하이햇', 'hihat'], ['베이스', 'electric-bass'], ['피아노', 'acoustic-piano']]) {
    p.tracks.push(createTrack({ name: name!, instrumentId: id! }));
  }
  for (const [bar, root, quality] of [[0, 'A', 'min'], [2, 'F', 'maj'], [4, 'C', 'maj'], [6, 'G', 'maj']] as const) {
    p = addChord(p, { tick: bar * BAR, root, quality }).project;
  }
  p = addSection(p, { startTick: 0, lengthTick: 4 * BAR, name: '벌스' }).project;
  return p;
}
const notesOf = (p: Project, i: number) => p.tracks[i]!.clips.flatMap((c) => c.notes.map((n) => ({ ...n, startTick: c.startTick + n.startTick })));
const ids = (p: Project) => p.tracks.map((t) => t.id);

test('드러머 — 킥·스네어·하이햇에 나눠, 같은 씨앗이면 같은 연주, 2·4박 스네어', () => {
  const p = band();
  const [kick, snare, hat] = ids(p);
  const opts = { style: 'pop' as const, complexity: 0.5, intensity: 0.5, fills: false, seed: 7 };
  const a = generateDrums(p, { kick, snare, hat }, { fromTick: 0, toTick: 4 * BAR }, opts);
  const b = generateDrums(p, { kick, snare, hat }, { fromTick: 0, toTick: 4 * BAR }, opts);
  assert.deepEqual(notesOf(a, 0).map((n) => [n.startTick, n.velocity]), notesOf(b, 0).map((n) => [n.startTick, n.velocity]));
  const snareBeats = notesOf(a, 1).filter((n) => n.velocity > 0.6).map((n) => (n.startTick % BAR) / PPQ);
  assert.ok(snareBeats.every((x) => x === 1 || x === 3), String(snareBeats));
  assert.ok(notesOf(a, 0).length >= 8 && notesOf(a, 2).length >= 24);
  assert.notDeepEqual(notesOf(generateDrums(p, { kick }, { fromTick: 0, toTick: 4 * BAR }, { ...opts, seed: 8 }), 0).map((n) => n.velocity), notesOf(a, 0).map((n) => n.velocity));
});

test('필인 — 구간 끝 마디 마지막 박이 스네어로 찬다', () => {
  const p = band();
  const [, snare] = ids(p);
  const a = generateDrums(p, { snare }, { fromTick: 0, toTick: 4 * BAR }, { style: 'rock', complexity: 0, intensity: 0.5, fills: true, seed: 1 });
  const lastBeat = notesOf(a, 1).filter((n) => n.startTick >= 4 * BAR - PPQ);
  assert.equal(lastBeat.length, 4);
});

test('다시 만들면 범위 안만 바뀐다', () => {
  const p = band();
  const [kick] = ids(p);
  let a = generateDrums(p, { kick }, { fromTick: 0, toTick: 8 * BAR }, { style: 'pop', complexity: 0, intensity: 0, fills: false, seed: 1 });
  const outside = notesOf(a, 0).filter((n) => n.startTick >= 4 * BAR).map((n) => n.startTick);
  a = generateDrums(a, { kick }, { fromTick: 0, toTick: 4 * BAR }, { style: 'rock', complexity: 1, intensity: 1, fills: false, seed: 9 });
  assert.deepEqual(notesOf(a, 0).filter((n) => n.startTick >= 4 * BAR).map((n) => n.startTick), outside);
});

test('베이스 — 코드 근음을 따라, 낮은 음역', () => {
  const p = band();
  const a = generateBass(p, ids(p)[3]!, { fromTick: 0, toTick: 8 * BAR }, { style: 'root', rhythm: 'quarters', seed: 1 });
  const roots = notesOf(a, 3).filter((n) => n.startTick % (2 * BAR) === 0).map((n) => n.pitch.midi % 12);
  assert.deepEqual(roots, [9, 5, 0, 7], 'A F C G');
  assert.ok(notesOf(a, 3).every((n) => n.pitch.midi >= 28 && n.pitch.midi < 52));
  assert.throws(() => generateBass({ ...p, chords: [] }, ids(p)[3]!, { fromTick: 0, toTick: BAR }, { style: 'root', rhythm: 'quarters', seed: 1 }), /코드 트랙/);
});

test('건반 — 코드 구성음, 가까운 자리바꿈으로 이어진다', () => {
  const p = band();
  const a = generateKeys(p, ids(p)[4]!, { fromTick: 0, toTick: 8 * BAR }, { style: 'pad', seed: 1 });
  const at = (bar: number) => notesOf(a, 4).filter((n) => n.startTick === bar * BAR).map((n) => n.pitch.midi).sort((x, y) => x - y);
  assert.deepEqual(at(0).map((m) => m % 12).sort((x, y) => x - y), [0, 4, 9]);
  const jump = Math.abs(at(2).reduce((s, m) => s + m, 0) / 3 - at(0).reduce((s, m) => s + m, 0) / 3);
  assert.ok(jump <= 5, `화음 중심이 ${jump} 반음 뛰었다`);
});

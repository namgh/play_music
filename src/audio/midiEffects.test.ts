/**
 * MIDI 이펙트 (`LOGIC_PARITY.md` 1-10·1-12) — 음 데이터는 그대로, 소리만 바뀐다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import type { MidiEffect, Project } from '../model/project.ts';
import { PPQ } from '../model/time.ts';
import { roundTrip } from '../model/persistence.ts';
import { applyMidiEffect, createMidiEffect, processedNotes } from './midiEffects.ts';
import { collectNoteEvents } from './scheduler.ts';

function chordSong(fx: MidiEffect[]): Project {
  const p = createEmptyProject('미디 이펙트');
  const t = createTrack({ name: '신스', instrumentId: 'synth-pluck' });
  const c = createClip({ startTick: 0, lengthTick: 4 * PPQ });
  for (const midi of [60, 64, 67]) c.notes.push(createNote({ startTick: 0, lengthTick: PPQ, midi, velocity: 0.8 }));
  t.clips.push(c);
  t.midiEffects = fx;
  p.tracks.push(t);
  return p;
}
const played = (p: Project) => collectNoteEvents(p, 0, 4 * PPQ).map((e) => `${e.startTick / (PPQ / 4)}:${e.note.pitch.midi}`).join(' ');

test('아르페지에이터 — 화음을 16분으로 오르내린다, 원래 음 데이터는 그대로', () => {
  const p = chordSong([{ ...createMidiEffect('arpeggiator'), mode: 'up' } as MidiEffect]);
  assert.equal(played(p), '0:60 1:64 2:67 3:60');
  assert.equal(p.tracks[0]!.clips[0]!.notes.length, 3, '클립 데이터는 손대지 않는다');
  const updown = chordSong([{ type: 'arpeggiator', bypass: false, mode: 'updown', rate: PPQ / 4, octaves: 2, gate: 0.5 }]);
  assert.equal(played(updown), '0:60 1:64 2:67 3:72');
  const ev = collectNoteEvents(updown, 0, PPQ)[0]!;
  assert.equal(ev.lengthTick, PPQ / 8, '게이트 ½');
});

test('무작위 아르페지오도 같은 곡이면 같은 소리', () => {
  const a = chordSong([{ type: 'arpeggiator', bypass: false, mode: 'random', rate: PPQ / 8, octaves: 1, gate: 1 }]);
  const b = roundTrip(a);
  assert.equal(played(a), played(b));
});

test('코드 트리거·트랜스포저·세기·리피터·랜더마이저', () => {
  const base = createNote({ startTick: PPQ, midi: 60, velocity: 0.5 });
  const one = [base];
  assert.deepEqual(applyMidiEffect(one, { type: 'chordTrigger', bypass: false, intervals: [0, 3, 7] }, null).map((n) => n.pitch.midi), [60, 63, 67]);
  assert.equal(applyMidiEffect(one, { type: 'transposer', bypass: false, semitones: -24 }, null)[0]!.pitch.midi, 36);
  assert.equal(applyMidiEffect(one, { type: 'velocity', bypass: false, mode: 'scale', value: 3 }, null)[0]!.velocity, 1);
  const rep = applyMidiEffect(one, { type: 'noteRepeater', bypass: false, repeats: 2, delay: PPQ / 2, feedback: 0.5, transpose: 12 }, null);
  assert.deepEqual(rep.map((n) => [n.startTick / PPQ, n.pitch.midi, n.velocity]), [[1, 60, 0.5], [1.5, 72, 0.25], [2, 84, 0.125]]);
  assert.equal(new Set(rep.map((n) => n.id)).size, 3, '만들어진 음은 서로 다른 id');
  const r1 = applyMidiEffect(one, { type: 'randomizer', bypass: false, timing: 30, velocity: 0.1 }, null)[0]!;
  const r2 = applyMidiEffect(one, { type: 'randomizer', bypass: false, timing: 30, velocity: 0.1 }, null)[0]!;
  assert.deepEqual(r1, r2);
  assert.ok(Math.abs(r1.startTick - PPQ) <= 30);
});

test('스케일 맞추기는 곡의 조성을 따른다 · 끄면 그대로', () => {
  const one = [createNote({ startTick: 0, midi: 61 })];
  assert.equal(applyMidiEffect(one, { type: 'scaleQuantizer', bypass: false }, { tonic: 'C', mode: 'major' })[0]!.pitch.midi, 60);
  assert.equal(applyMidiEffect(one, { type: 'scaleQuantizer', bypass: false }, { tonic: 'A', mode: 'major' })[0]!.pitch.midi, 61);
  assert.equal(applyMidiEffect(one, { type: 'scaleQuantizer', bypass: true }, null)[0]!.pitch.midi, 61);
});

test('이펙트가 없으면 같은 배열 — 예전과 같은 경로', () => {
  const p = chordSong([]);
  assert.equal(processedNotes(p.tracks[0]!, p.tracks[0]!.clips[0]!, null), p.tracks[0]!.clips[0]!.notes);
  assert.deepEqual(roundTrip(chordSong([createMidiEffect('noteRepeater')])).tracks[0]!.midiEffects, [createMidiEffect('noteRepeater')]);
});

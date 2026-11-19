/**
 * 악보 표기 (`LOGIC_PARITY.md` 1-5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyProject, createNote } from './factory.ts';
import type { Note, Project } from './project.ts';
import { PPQ } from './time.ts';
import { chooseClef, keyFifths, notate, spell, toMusicXml } from './notation.ts';

const proj = (key: Project['key'] = null): Project => ({ ...createEmptyProject('악보'), key });
const n = (start: number, len: number, midi: number): Note => createNote({ startTick: start * PPQ, lengthTick: len * PPQ, midi });
const sig = (p: Project, notes: Note[]) => notate(p, notes, 0, 0, 1)[0]!.events
  .map((e) => `${e.kind === 'rest' ? 'r' : e.pitches.map((x) => `${x.step}${x.alter === 1 ? '#' : x.alter === -1 ? 'b' : ''}${x.octave}`).join('+')}:${e.type}${e.dots ? '.' : ''}${e.tie ? '~' : ''}`).join(' ');

test('조표 — 장조·단조(나란한조)', () => {
  assert.equal(keyFifths({ tonic: 'G', mode: 'major' }), 1);
  assert.equal(keyFifths({ tonic: 'F', mode: 'major' }), -1);
  assert.equal(keyFifths({ tonic: 'E', mode: 'minor' }), 1);
  assert.equal(keyFifths({ tonic: 'C', mode: 'minor' }), -3);
  assert.equal(keyFifths(null), 0);
});

test('음 이름 — 조표가 내림이면 내림, 조표와 다르면 임시표', () => {
  assert.deepEqual([spell(61, 0).step, spell(61, 0).alter, spell(61, 0).accidental], ['C', 1, 'sharp']);
  assert.deepEqual([spell(61, -3).step, spell(61, -3).alter], ['D', -1]);
  assert.equal(spell(66, 1).accidental, null, 'G 장조의 F# 은 임시표 없음');
  assert.equal(spell(65, 1).accidental, 'natural', 'G 장조의 F 는 제자리표');
});

test('마디 채우기 — 4분·쉼표·온쉼표', () => {
  assert.equal(sig(proj(), [n(0, 1, 60), n(2, 1, 64)]), 'C4:quarter r:quarter E4:quarter r:quarter');
  assert.equal(sig(proj(), []), 'r:whole');
  assert.equal(sig(proj(), [n(0, 3, 67)]), 'G4:half. r:quarter');
});

test('박 경계를 넘는 음은 나눠 붙임줄, 화음은 함께', () => {
  assert.equal(sig(proj(), [n(0.5, 1, 60)]), 'r:eighth C4:eighth~ C4:eighth r:eighth r:half');
  assert.equal(sig(proj(), [n(0, 1, 64), n(0, 1, 60), n(0, 1, 67)]), 'C4+E4+G4:quarter r:quarter r:half');
});

test('마디를 넘는 음은 다음 마디로 이어진다', () => {
  const ms = notate(proj(), [n(3, 2, 72)], 0, 0, 2);
  assert.equal(ms[0]!.events.at(-1)!.tie, true);
  assert.equal(ms[1]!.events[0]!.kind, 'note');
  assert.equal(ms[1]!.events[0]!.duration, PPQ);
});

test('음자리표 고르기 · MusicXML', () => {
  assert.equal(chooseClef([n(0, 1, 40), n(1, 1, 45)]), 'bass');
  assert.equal(chooseClef([n(0, 1, 72)]), 'treble');
  const p = proj({ tonic: 'D', mode: 'major' });
  const xml = toMusicXml(p, [{ name: '피아노 & 보컬', clef: 'treble', measures: notate(p, [n(0, 1, 66), n(0, 1, 62)], 0, 0, 2) }]);
  assert.match(xml, /<fifths>2<\/fifths>/);
  assert.match(xml, /<chord\/><pitch><step>F<\/step><alter>1<\/alter>/);
  assert.match(xml, /피아노 &amp; 보컬/);
  assert.match(xml, /<measure number="2">/);
  assert.equal((xml.match(/<measure /g) ?? []).length, 2);
});

test('악보 편집 — 누른 자리 → 조표 붙은 음, 큰보표 판단·나누기, 음 id 가 따라온다', async () => {
  const { midiFromDiatonic, wantsGrandStaff, splitGrandStaff, notate } = await import('./notation.ts');
  const { createEmptyProject, createNote } = await import('./factory.ts');
  // C4 = 4·7+0 = 28, F4 = 31
  assert.equal(midiFromDiatonic(28, 0), 60);
  assert.equal(midiFromDiatonic(31, 1), 66, 'G 장조의 F 자리는 F♯');
  assert.equal(midiFromDiatonic(34, -1), 70, 'F 장조의 B 자리는 B♭');
  const low = createNote({ startTick: 0, lengthTick: 480, midi: 43 });
  const high = createNote({ startTick: 0, lengthTick: 480, midi: 72 });
  assert.equal(wantsGrandStaff([low, high], false), true);
  assert.equal(wantsGrandStaff([high], false), false);
  const parts = splitGrandStaff([low, high]);
  assert.deepEqual([parts.treble.length, parts.bass.length], [1, 1]);
  const p = createEmptyProject('n');
  const m = notate(p, [low, high], 0, 0, 1);
  const ev = m[0]!.events.find((e) => e.kind === 'note')!;
  assert.deepEqual(ev.ids, [low.id, high.id]);
});

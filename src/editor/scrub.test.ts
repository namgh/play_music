import { test } from 'node:test';
import assert from 'node:assert/strict';

import { notesInSpan, SCRUB_LIMIT } from './scrub.ts';
import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';

test('스크럽 — 지나간 구간에서 시작하는 음, 뒤로 끌어도, 뮤트는 빼고', () => {
  const p = createEmptyProject('s');
  const a = createTrack({ name: 'a', instrumentId: 'acoustic-piano' });
  const c = createClip({ startTick: 960, lengthTick: 1920 });
  c.notes.push(createNote({ startTick: 0, lengthTick: 240, midi: 60 }), createNote({ startTick: 480, lengthTick: 240, midi: 64 }));
  a.clips.push(c);
  const m = createTrack({ name: 'm', instrumentId: 'kick' });
  const mc = createClip({ startTick: 960, lengthTick: 960 });
  mc.notes.push(createNote({ startTick: 0, lengthTick: 240, midi: 36 }));
  m.clips.push(mc);
  m.mute = true;
  p.tracks.push(a, m);
  assert.deepEqual(notesInSpan(p, 900, 1000).map((n) => n.midi), [60]);
  assert.deepEqual(notesInSpan(p, 1500, 900).map((n) => n.midi), [60, 64]);
  assert.deepEqual(notesInSpan(p, 0, 900), []);
  for (let i = 0; i < 20; i++) c.notes.push(createNote({ startTick: 10 + i, lengthTick: 10, midi: 70 }));
  assert.equal(notesInSpan(p, 900, 1100).length, SCRUB_LIMIT);
});

test('오디오 스크럽 — 그 자리의 에셋 초 (다듬기·거꾸로 반영)', async () => {
  const { audioAt } = await import('./scrub.ts');
  const p = createEmptyProject('a');
  const t = createTrack({ name: 'v', instrumentId: 'acoustic-guitar' });
  const c = createClip({ startTick: 960, lengthTick: 1920 });
  c.audio = { assetId: 'x', name: 'v', assetSec: 4, offsetSec: 0.5, gainDb: -3, fadeInSec: 0, fadeOutSec: 0, reverse: false };
  t.clips.push(c);
  p.tracks.push(t);
  const sec = (tick: number) => tick / 960 * 0.5; // 120 BPM
  assert.deepEqual(audioAt(p, 1920, sec), [{ assetId: 'x', offsetSec: 1, gainDb: -3 }]);
  assert.deepEqual(audioAt(p, 0, sec), []);
  c.audio.reverse = true;
  assert.equal(audioAt(p, 1920, sec)[0]!.offsetSec, 3);
});

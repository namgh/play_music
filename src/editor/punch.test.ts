import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyPunch, NoteRecorder, punchAudioWindow } from './recording.ts';

test('펀치 — 구간 앞 준비 연주는 버리고, 끝을 넘는 음은 자른다', () => {
  const r = new NoteRecorder();
  r.noteOn(60, 0.8, 100); r.noteOff(60, 400);   // 구간 전
  r.noteOn(62, 0.8, 1000); r.noteOff(62, 1200); // 안
  r.noteOn(64, 0.8, 1800);                      // 안에서 눌러 끝을 넘김
  const played = r.finish(2600);
  const kept = applyPunch(played, 960, 1920);
  assert.deepEqual(kept.map((p) => [p.midi, p.onTick, p.offTick]), [[62, 1000, 1200], [64, 1800, 1920]]);
});

test('펀치 오디오 — 녹음한 소리에서 구간만', () => {
  assert.deepEqual(punchAudioWindow(10, 8, 12, 15), { offsetSec: 2, lengthSec: 3 });
  assert.deepEqual(punchAudioWindow(10, 3, 12, 15), { offsetSec: 2, lengthSec: 1 });
  assert.equal(punchAudioWindow(10, 1, 12, 15), null);
});

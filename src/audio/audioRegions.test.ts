/**
 * 오디오 클립 재생 계획 (`LOGIC_PARITY.md` 1-5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createTrack } from '../model/factory.ts';
import type { AudioRegion, Project } from '../model/project.ts';
import { roundTrip } from '../model/persistence.ts';
import { PPQ } from '../model/time.ts';
import { splitClip } from '../editor/edits.ts';
import { fadeAt, planAudio } from './audioRegions.ts';

const region = (patch: Partial<AudioRegion> = {}): AudioRegion => ({
  assetId: 'abc', name: '보컬.wav', assetSec: 10, offsetSec: 1, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, reverse: false, ...patch,
});

function song(r: AudioRegion): Project {
  const p = createEmptyProject('오디오');
  p.tempo.bpm = 120; // 1박 = 0.5초, 1마디 = 2초
  const t = createTrack({ name: '보컬', instrumentId: 'acoustic-guitar' });
  t.gain = 0.5;
  const c = createClip({ startTick: 4 * PPQ, lengthTick: 8 * PPQ });
  c.audio = r;
  t.clips.push(c);
  p.tracks.push(t);
  return p;
}

test('처음부터 재생 — 클립 시작 시각에, 에셋 오프셋부터, 클립 길이만큼', () => {
  const [plan] = planAudio(song(region()), 0);
  assert.deepEqual([plan!.whenSec, plan!.offsetSec, plan!.durationSec, plan!.gain], [2, 1, 4, 0.5]);
});

test('클립 중간에서 재생 — 바로, 지난 만큼 건너뛰고', () => {
  const [plan] = planAudio(song(region()), 6 * PPQ);
  assert.deepEqual([plan!.whenSec, plan!.offsetSec, plan!.durationSec, plan!.elapsedSec], [0, 2, 3, 1]);
  assert.equal(planAudio(song(region()), 20 * PPQ).length, 0, '지나간 클립은 없다');
});

test('에셋이 짧으면 거기서 끝 · 거꾸로는 거울 자리 · 게인 dB', () => {
  const [short] = planAudio(song(region({ assetSec: 3 })), 0);
  assert.equal(short!.durationSec, 2);
  const [rev] = planAudio(song(region({ reverse: true, gainDb: -6 })), 0);
  assert.equal(rev!.offsetSec, 10 - (1 + 4));
  assert.ok(Math.abs(rev!.gain - 0.5 * Math.pow(10, -6 / 20)) < 1e-9);
});

test('페이드 배율', () => {
  const p = { fadeInSec: 1, fadeOutSec: 2, regionSec: 4 };
  assert.deepEqual([0, 0.5, 1, 2, 3, 4].map((t) => fadeAt(p, t)), [0, 0.5, 1, 1, 0.5, 0]);
});

test('오디오 클립 나누기는 에셋 자리를 이어 준다 · 저장 왕복', () => {
  const p = song(region());
  const { project: split } = splitClip(p, p.tracks[0]!.clips[0]!.id, 6 * PPQ);
  const [left, right] = split.tracks[0]!.clips;
  assert.equal(left!.audio!.offsetSec, 1);
  assert.equal(right!.audio!.offsetSec, 2, '2박 = 1초 뒤');
  const plans = planAudio(split, 0);
  assert.deepEqual(plans.map((x) => [x.whenSec, x.offsetSec, x.durationSec]), [[2, 1, 1], [3, 2, 3]]);
  assert.deepEqual(roundTrip(split), split);
});

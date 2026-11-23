import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignMix, copyableInMp4, mixStart, pickVideoMime } from './videoExport.ts';

test('영상과 내보내기 — 영상이 곡 중간에서 시작하면 믹스를 건너뛰고, 먼저 시작하면 기다린다', () => {
  assert.deepEqual(mixStart(0), { skipSec: 0, delaySec: 0 });
  assert.deepEqual(mixStart(4.5), { skipSec: 4.5, delaySec: 0 });
  assert.deepEqual(mixStart(-2), { skipSec: 0, delaySec: 2 });
});

test('녹화 형식 — 되는 것 중 첫째, 없으면 null', () => {
  assert.equal(pickVideoMime((m) => m === 'video/webm'), 'video/webm');
  assert.equal(pickVideoMime((m) => m.startsWith('video/webm')), 'video/webm;codecs=vp9,opus');
  assert.equal(pickVideoMime(() => false), null);
});

test('다시 싸기 — 믹스를 영상 시각에 맞춘다: 곡 중간이면 건너뛰고, 먼저 시작하면 앞이 무음, 넘치는 값은 자른다', () => {
  const mix = [Float32Array.from([0.1, 0.2, 0.3, 0.4, 2, -2])];
  // 표본율 2 — 1초 = 2표본
  assert.deepEqual([...alignMix(mix, 2, 1, 2)[0]!].map((v) => +v.toFixed(2)), [0.3, 0.4, 1, -1]);
  assert.deepEqual([...alignMix(mix, 2, -1, 2)[0]!].map((v) => +v.toFixed(2)), [0, 0, 0.1, 0.2]);
  // 곡이 영상보다 짧으면 남는 자리는 무음
  assert.deepEqual([...alignMix(mix, 2, 0, 4)[0]!].map((v) => +v.toFixed(2)), [0.1, 0.2, 0.3, 0.4, 1, -1, 0, 0]);
  // 곡이 끝난 뒤에 시작하는 영상 — 전부 무음, 길이는 영상 길이
  assert.deepEqual([...alignMix(mix, 2, 10, 1)[0]!], [0, 0]);
});

test('MP4 — H.264·H.265 만 그대로 옮긴다. VP9 을 MP4 에 넣으면 다른 플레이어가 못 연다', () => {
  assert.equal(copyableInMp4('avc'), true);
  assert.equal(copyableInMp4('hevc'), true);
  assert.equal(copyableInMp4('vp9'), false);
  assert.equal(copyableInMp4('vp8'), false);
  assert.equal(copyableInMp4(null), false);
});

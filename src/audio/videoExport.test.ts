import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixStart, pickVideoMime } from './videoExport.ts';

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

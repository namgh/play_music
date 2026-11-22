import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitTempoToHit, formatTimecode, frameSeconds } from './timecode.ts';

test('타임코드 — 24프레임, 시작 01:00:00:00', () => {
  assert.equal(formatTimecode(0, { fps: 24, startSec: 0 }), '00:00:00:00');
  assert.equal(formatTimecode(1.5, { fps: 24, startSec: 0 }), '00:00:01:12');
  assert.equal(formatTimecode(12 + 8 / 24, { fps: 24, startSec: 3600 }), '01:00:12:08');
  assert.equal(formatTimecode(3661, { fps: 25, startSec: 0 }), '01:01:01:00');
});

test('타임코드 — 23.976 은 실제 속도로 세고 정수 프레임으로 적는다', () => {
  // 실제 1초에는 23.976 프레임 — 23번째 프레임까지만 찼다
  assert.equal(formatTimecode(1, { fps: 23.976, startSec: 0 }), '00:00:00:23');
  assert.equal(formatTimecode(1001 / 1000, { fps: 23.976, startSec: 0 }), '00:00:01:00');
  assert.ok(Math.abs(frameSeconds(29.97) - 1001 / 30000) < 1e-12);
  assert.equal(frameSeconds(25), 1 / 25);
});

test('히트 포인트 — 가까운 박이 그 시각에 오도록 템포를 조금 바꾼다', () => {
  // 120BPM 에서 10.2초 = 20.4박 → 20박이 10.2초에 오려면 117.647
  const fit = fitTempoToHit(120, 10.2)!;
  assert.equal(fit.beat, 20);
  assert.ok(Math.abs(fit.bpm - 117.647) < 0.001);
  assert.ok(Math.abs((fit.beat * 60) / fit.bpm - 10.2) < 1e-4, '바꾼 템포에서 20박 = 10.2초');
  assert.ok(Math.abs(fit.wasOffSec - -0.2) < 1e-9, '원래는 박이 0.2초 일렀다');
  // 이미 박 위면 그대로
  assert.equal(fitTempoToHit(120, 10)!.bpm, 120);
});

test('히트 포인트 — 너무 많이 바꿔야 하면 하지 않는다', () => {
  // 120BPM 에서 0.7초 = 1.4박 → 1박을 0.7초에 맞추려면 85.7BPM (−29%)
  assert.equal(fitTempoToHit(120, 0.7), null);
  assert.equal(fitTempoToHit(120, 0), null);
});

test('타임코드 설정은 곡 파일에 남는다', async () => {
  const { deserializeProject, serializeProject } = await import('./persistence.ts');
  const { createEmptyProject } = await import('./factory.ts');
  const starterForTest = () => createEmptyProject('영화');
  const back = deserializeProject(serializeProject({ ...starterForTest(), timecode: { fps: 23.976, startSec: 3600 } }));
  assert.deepEqual(back.timecode, { fps: 23.976, startSec: 3600 });
  assert.equal(deserializeProject(serializeProject(starterForTest())).timecode, undefined);
});

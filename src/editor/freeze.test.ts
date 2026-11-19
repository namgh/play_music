import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bounceInPlace, freezeTrack, soloRenderProject, unfreezeTrack } from './freeze.ts';
import { protectedChange } from './tracks.ts';
import { roundTrip } from '../model/persistence.ts';
import { createClip, createEmptyProject, createTrack } from '../model/factory.ts';

function song() {
  const p = createEmptyProject('f');
  const a = createTrack({ name: '신스', instrumentId: 'synth-pad' });
  a.clips.push(createClip({ startTick: 0, lengthTick: 1920 }));
  a.effects = [{ type: 'chromaverb', bypass: false, params: {} }];
  const b = createTrack({ name: '킥', instrumentId: 'kick' });
  p.tracks.push(a, b);
  return { p, a, b };
}

test('바운스 인 플레이스 — 바로 아래 새 오디오 트랙, 원래는 뮤트', () => {
  const { p, a } = song();
  const out = bounceInPlace(p, a.id, { assetId: 'x', seconds: 4 });
  assert.equal(out.project.tracks.length, 3);
  assert.equal(out.project.tracks[1]!.id, out.trackId);
  assert.equal(out.project.tracks[1]!.kind, 'audio');
  assert.equal(out.project.tracks[1]!.clips[0]!.audio!.assetId, 'x');
  assert.equal(out.project.tracks[0]!.mute, true);
});

test('프리즈 — 얼리면 뮤트·보호·숨은 렌더 트랙, 풀면 원래대로, 저장해도 남는다', () => {
  const { p, a } = song();
  const frozen = freezeTrack(p, a.id, { assetId: 'y', seconds: 4 });
  const src = frozen.tracks.find((t) => t.id === a.id)!;
  assert.equal(src.mute, true);
  assert.equal(src.locked, true);
  const render = frozen.tracks.find((t) => t.freezeOf === a.id)!;
  assert.equal(render.hidden, true);
  // 얼린 동안 원래 트랙은 고칠 수 없다
  const edited = { ...frozen, tracks: frozen.tracks.map((t) => (t.id === a.id ? { ...t, clips: [] } : t)) };
  assert.equal(protectedChange(frozen, edited), '신스');
  const back = roundTrip(frozen);
  assert.equal(back.tracks.find((t) => t.id === a.id)!.frozen!.audioTrackId, render.id);
  const thawed = unfreezeTrack(back, a.id);
  assert.equal(thawed.tracks.length, 2);
  const t = thawed.tracks.find((x) => x.id === a.id)!;
  assert.equal(t.mute, false);
  assert.equal(t.locked, undefined);
  assert.equal(t.frozen, undefined);
});

test('렌더용 곡 — 그 트랙만, 마스터 이펙트 없이', () => {
  const { p, a } = song();
  p.master.effects = [{ type: 'eq', bypass: false, params: {} }];
  const r = soloRenderProject({ ...p, tracks: p.tracks.map((t) => (t.id === a.id ? { ...t, mute: true } : t)) }, a.id);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0]!.mute, false);
  assert.equal(r.master.effects.length, 0);
  assert.equal(r.tracks[0]!.effects.length, 1, '인서트는 구워진다');
});

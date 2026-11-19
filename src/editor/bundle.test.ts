import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { isZip, makeBundle, openBundle, projectAssetIds } from './bundle.ts';
import { readZip } from '../audio/zip.ts';
import { createEmptyProject, createClip, createTrack } from '../model/factory.ts';
import type { Project } from '../model/project.ts';

const idOf = (b: ArrayBuffer) => createHash('sha256').update(new Uint8Array(b)).digest('hex').slice(0, 32);

function songWithAudio(store: Map<string, ArrayBuffer>): Project {
  const p = createEmptyProject('소리 있는 곡');
  const t = createTrack({ name: '보컬', instrumentId: 'kick' });
  const wav = new Uint8Array([1, 2, 3, 4, 5, 250, 251]).buffer;
  const id = idOf(wav);
  store.set(id, wav);
  const c = createClip({ startTick: 0, lengthTick: 960 });
  c.audio = { assetId: id, name: '보컬.wav', assetSec: 1, offsetSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, reverse: false };
  t.clips.push(c);
  p.tracks.push(t);
  const vid = new Uint8Array([9, 9, 9]).buffer;
  store.set(idOf(vid), vid);
  p.video = { assetId: idOf(vid), name: 'v.mp4', durationSec: 3, offsetSec: 0 };
  return p;
}

test('묶음 — 곡과 에셋이 ZIP 하나에 들어가고, 열면 저장소로 되돌아간다', async () => {
  const store = new Map<string, ArrayBuffer>();
  const song = songWithAudio(store);
  assert.equal(projectAssetIds(song).length, 2);
  const { bytes, missing } = await makeBundle(song, async (id) => store.get(id) ?? null);
  assert.deepEqual(missing, []);
  assert.ok(isZip(bytes));
  assert.equal(readZip(bytes).size, 3);

  const fresh = new Map<string, ArrayBuffer>();
  const opened = await openBundle(bytes, async (b) => { const id = idOf(b); fresh.set(id, b); return id; });
  assert.equal(opened.project.name, '소리 있는 곡');
  assert.equal(opened.assets, 2);
  assert.deepEqual(opened.missing, []);
  for (const id of projectAssetIds(song)) assert.deepEqual(new Uint8Array(fresh.get(id)!), new Uint8Array(store.get(id)!));
});

test('묶음 — 저장소에 없는 에셋은 빠졌다고 알린다, 깨진 파일은 거절', async () => {
  const store = new Map<string, ArrayBuffer>();
  const song = songWithAudio(store);
  const { bytes, missing } = await makeBundle(song, async () => null);
  assert.equal(missing.length, 2);
  const opened = await openBundle(bytes, async () => 'x');
  assert.equal(opened.missing.length, 2);
  const broken = bytes.slice();
  broken[60] = broken[60]! ^ 0xff;
  await assert.rejects(() => openBundle(broken, async () => 'x'));
});

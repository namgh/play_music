import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, platformInfo } from './platform.ts';

test('웹은 장치가 몇 채널이든 스테레오만 — 이유를 말해 준다', () => {
  const c = capabilities({ kind: 'web', os: null }, 8, false);
  assert.equal(c.surround, false);
  assert.match(c.surroundReason!, /설치형/);
  assert.deepEqual(c.layouts.filter((l) => l.available).map((l) => l.id), ['stereo']);
  assert.equal(c.externalSync, false);
});

test('설치형 — 장치 채널 수만큼 배치가 열린다', () => {
  const stereo = capabilities({ kind: 'desktop', os: 'darwin' }, 2, true);
  assert.equal(stereo.surround, false);
  assert.match(stereo.surroundReason!, /2채널/);
  const six = capabilities({ kind: 'desktop', os: 'darwin' }, 6, true);
  assert.equal(six.surround, true);
  assert.equal(six.surroundReason, null);
  assert.deepEqual(six.layouts.filter((l) => l.available).map((l) => l.id), ['stereo', '5.1']);
  const twelve = capabilities({ kind: 'desktop', os: 'win32' }, 12, true);
  assert.deepEqual(twelve.layouts.filter((l) => l.available).map((l) => l.id), ['stereo', '5.1', '7.1', '7.1.4']);
});

test('껍데기가 심은 값이 없으면 웹이다', () => {
  assert.deepEqual(platformInfo(), { kind: 'web', os: null });
  (globalThis as { resona?: unknown }).resona = { kind: 'desktop', os: 'darwin' };
  assert.deepEqual(platformInfo(), { kind: 'desktop', os: 'darwin' });
  delete (globalThis as { resona?: unknown }).resona;
});

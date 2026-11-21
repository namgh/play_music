import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './settings.ts';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

test('오디오 설정 — 없으면 기본(시스템 장치·작은 지연), 저장하면 돌아온다', () => {
  store.clear();
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  saveSettings({ ...DEFAULT_SETTINGS, audioOutputId: 'out-1', audioInputId: 'in-2', latency: 'playback' });
  const s = loadSettings();
  assert.equal(s.audioOutputId, 'out-1');
  assert.equal(s.audioInputId, 'in-2');
  assert.equal(s.latency, 'playback');
});

test('망가진 값은 기본으로 — 옛 버전이 저장한 설정도 읽힌다', () => {
  store.set('settings-v1', JSON.stringify({ countInBars: 2, latency: 'warp', audioOutputId: 7 }));
  const s = loadSettings();
  assert.equal(s.countInBars, 2);
  assert.equal(s.latency, 'interactive');
  assert.equal(s.audioOutputId, null);
  store.set('settings-v1', '{{{');
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

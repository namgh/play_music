/**
 * 곡 보관함·버전·템플릿 (`LOGIC_PARITY.md` 1-1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INSTRUMENT_CATALOG } from '../instruments/definitions.ts';
import { TEMPLATES, projectFromTemplate } from '../model/templates.ts';
import { createEmptyProject } from '../model/factory.ts';
import { setTempo } from './edits.ts';
import {
  deleteVersion, getProject, LIBRARY_LIMIT, listProjects, listVersions, loadVersion, memoryKv, putProject, removeProject, saveVersion,
} from './library.ts';

test('템플릿 — 악기는 전부 카탈로그에 있고 트랙마다 곡 길이 클립', () => {
  for (const t of TEMPLATES) {
    const p = projectFromTemplate(t);
    assert.equal(p.tracks.length, t.tracks.length);
    for (const track of p.tracks) {
      assert.ok(INSTRUMENT_CATALOG.some((e) => e.id === track.instrumentId && !e.abstract), `${t.id}: ${track.instrumentId}`);
      assert.equal(track.clips.length, 1);
    }
    assert.equal(p.tempo.bpm, t.bpm);
  }
});

test('보관함 — 넣기·갱신(최근 것이 위)·꺼내기·지우기', () => {
  const kv = memoryKv();
  const a = createEmptyProject('가');
  const b = createEmptyProject('나');
  putProject(kv, a, 1);
  putProject(kv, b, 2);
  putProject(kv, { ...a, name: '가 고침' }, 3);
  assert.deepEqual(listProjects(kv).map((e) => e.name), ['가 고침', '나']);
  assert.equal(getProject(kv, a.id)!.name, '가 고침');
  removeProject(kv, b.id);
  assert.deepEqual(listProjects(kv).map((e) => e.name), ['가 고침']);
  assert.equal(getProject(kv, b.id), null);
});

test('보관함은 넘치면 가장 오래된 곡부터 지운다', () => {
  const kv = memoryKv();
  const first = createEmptyProject('처음');
  putProject(kv, first, 0);
  for (let i = 1; i <= LIBRARY_LIMIT; i++) putProject(kv, createEmptyProject(`곡 ${i}`), i);
  assert.equal(listProjects(kv).length, LIBRARY_LIMIT);
  assert.equal(getProject(kv, first.id), null);
});

test('버전 — 남기고, 같은 이름은 덮고, 되돌리고, 지운다', () => {
  const kv = memoryKv();
  let p = createEmptyProject('곡');
  saveVersion(kv, p, '브리지 바꾸기 전', 1);
  p = setTempo(p, 140);
  const v2 = saveVersion(kv, p, '빠르게', 2);
  saveVersion(kv, setTempo(p, 150), '빠르게', 3);
  assert.deepEqual(listVersions(kv, p.id).map((v) => v.name), ['빠르게', '브리지 바꾸기 전']);
  assert.equal(loadVersion(kv, p.id, v2.id)!.tempo.bpm, 150, '같은 이름은 덮어쓴다');
  const before = listVersions(kv, p.id).find((v) => v.name === '브리지 바꾸기 전')!;
  assert.equal(loadVersion(kv, p.id, before.id)!.tempo.bpm, 120);
  deleteVersion(kv, p.id, before.id);
  assert.deepEqual(listVersions(kv, p.id).map((v) => v.name), ['빠르게']);
  assert.equal(saveVersion(kv, p, '  ', 4).name, '버전 2');
});

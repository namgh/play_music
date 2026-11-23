/**
 * 곡 보관함·버전·템플릿 (`LOGIC_PARITY.md` 1-1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INSTRUMENT_CATALOG } from '../instruments/definitions.ts';
import { TEMPLATES, projectFromTemplate } from '../model/templates.ts';
import { createEmptyProject } from '../model/factory.ts';
import { setTempo } from './edits.ts';
import { serializeProject } from '../model/persistence.ts';
import {
  deleteVersion, getProject, LIBRARY_LIMIT, listProjects, listVersions, loadVersion, memoryKv, putProject, removeProject, saveVersion,
  makeRoom, setWithRoom,
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

test('저장소가 차면 오래된 곡을 내주고 새 곡을 넣는다 — 지금 곡은 지킨다', () => {
  const one = serializeProject(createEmptyProject('곡')).length;
  // 곡 셋 남짓 들어갈 자리
  const kv = memoryKv(one * 3 + 900);
  const songs = Array.from({ length: 6 }, (_, i) => createEmptyProject(`곡 ${i + 1}`));
  songs.forEach((p, i) => putProject(kv, p, 1000 + i));
  const names = listProjects(kv).map((e) => e.name);
  assert.equal(names[0], '곡 6');
  assert.ok(names.length >= 2 && names.length < 6, `남은 곡 ${names.length}`);
  assert.ok(!names.includes('곡 1'), '가장 오래된 곡부터 나간다');
  // 남은 곡은 모두 열린다 (목록만 남고 내용이 없는 곡이 없다)
  for (const e of listProjects(kv)) assert.ok(getProject(kv, e.id) !== null, e.name);
});

test('자리 만들기 — 지금 곡 하나만 남으면 더 내주지 않고 실패를 알린다', () => {
  const p = createEmptyProject('혼자');
  const kv = memoryKv(serializeProject(p).length + 400);
  putProject(kv, p, 1);
  assert.equal(makeRoom(kv, p.id), false);
  assert.throws(() => setWithRoom(kv, 'big', 'x'.repeat(100000), p.id));
  assert.ok(getProject(kv, p.id) !== null);
});

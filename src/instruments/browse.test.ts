/**
 * 브라우저 검색·패치 (`LOGIC_PARITY.md` 1-6).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INSTRUMENT_CATALOG } from './definitions.ts';
import { addPatch, removePatch, searchInstruments } from './browse.ts';

const names = (r: { name: string }[]) => r.map((e) => e.name);

test('검색 — 낱말을 전부 포함, 분류 거르기, 추상 악기는 빼기', () => {
  assert.ok(names(searchInstruments(INSTRUMENT_CATALOG, { text: '베이스 신스', category: null })).includes('신스 베이스'));
  const drums = searchInstruments(INSTRUMENT_CATALOG, { text: '', category: '드럼' });
  assert.ok(drums.length >= 10 && drums.every((e) => e.category === '드럼'));
  assert.ok(searchInstruments(INSTRUMENT_CATALOG, { text: '', category: null }).every((e) => !e.abstract));
  assert.ok(names(searchInstruments(INSTRUMENT_CATALOG, { text: '모달', category: null })).includes('마림바'), '합성 방식으로도 찾는다');
  assert.deepEqual(searchInstruments(INSTRUMENT_CATALOG, { text: '없는악기', category: null }), []);
});

test('패치 — 최근 것이 위, 같은 이름은 덮어쓰기, 지우기', () => {
  let list = addPatch([], { name: '따뜻한 로즈', instrumentId: 'electric-piano-rhodes', toneId: 'default', toneParams: { damping: 0.4 } }, 1);
  list = addPatch(list, { name: '밝은 기타', instrumentId: 'acoustic-guitar', toneId: 'default', toneParams: null }, 2);
  list = addPatch(list, { name: '따뜻한 로즈', instrumentId: 'electric-piano-rhodes', toneId: 'default', toneParams: { damping: 0.6 } }, 3);
  assert.deepEqual(list.map((p) => p.name), ['따뜻한 로즈', '밝은 기타']);
  assert.deepEqual(list[0]!.toneParams, { damping: 0.6 });
  assert.deepEqual(removePatch(list, list[1]!.id).map((p) => p.name), ['따뜻한 로즈']);
  assert.equal(addPatch([], { name: '  ', instrumentId: 'kick', toneId: 'default', toneParams: null }, 4)[0]!.name, '내 음색');
});

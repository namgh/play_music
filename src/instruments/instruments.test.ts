/**
 * 악기 정의 회귀 테스트.
 *
 * 가장 중요한 것: **정의만 추가해서 새 악기가 나온다** (`sound.md` 9-1).
 * 이 성질이 깨지면 악기 하나 늘릴 때마다 엔진을 건드리게 되고 확장이 멈춘다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BUILT_IN_INSTRUMENTS, createRegistry, playableInstrumentIds } from './definitions.ts';
import { clampParams, instrumentParams, InstrumentResolveError, resolveInstrument } from './resolve.ts';
import type { InstrumentDefinition } from './types.ts';

const registry = createRegistry();

test('모든 내장 악기가 해석된다', () => {
  for (const id of playableInstrumentIds()) {
    const r = resolveInstrument(id, registry);
    assert.ok(r.voice, `${id}: voice 없음`);
    assert.ok(r.name.length > 0);
    assert.ok(r.range.low < r.range.high, `${id}: 음역이 뒤집혔다`);
  }
});

test('상속이 부모 → 자식 순으로 덮어쓴다', () => {
  const lp = resolveInstrument('electric-guitar-lp', registry);
  // 정의에 한 줄만 적었다
  assert.equal(lp.params.scaleLengthMm, 628);
  // 나머지는 부모(electric-guitar)에서
  assert.equal(lp.params.sustainSec, 5);
  // 그 위(string-base)에서
  assert.equal(lp.params.pluckPosition, 0.18);
  assert.deepEqual(lp.lineage, ['electric-guitar-lp', 'electric-guitar', 'string-base']);
});

test('레스폴과 스트랫은 줄 길이만 다르다', () => {
  // 제품이 실제로 주장하는 미세한 차이. 이 둘이 파라미터 하나로 갈린다는 게 핵심
  const strat = resolveInstrument('electric-guitar', registry);
  const lp = resolveInstrument('electric-guitar-lp', registry);
  const differing = Object.keys(strat.params).filter((k) => strat.params[k] !== lp.params[k]);
  assert.deepEqual(differing, ['scaleLengthMm']);
  assert.equal(strat.params.scaleLengthMm, 648);
  assert.equal(lp.params.scaleLengthMm, 628);
});

test('정의만 추가해서 새 악기가 나온다 — 엔진 코드 수정 0줄', () => {
  // sound.md 9-1 의 판정 기준 그 자체.
  // 밴조를 20줄이 아니라 6줄로 추가한다
  const banjo: InstrumentDefinition = {
    id: 'banjo',
    schemaVersion: 1,
    name: '밴조',
    extends: 'acoustic-guitar',
    params: { scaleLengthMm: 673, stiffness: 0.03, damping: 0.09, sustainSec: 0.9, pluckHardness: 0.9 },
  };

  const extended = createRegistry([...BUILT_IN_INSTRUMENTS, banjo]);
  const r = resolveInstrument('banjo', extended);

  assert.equal(r.voice, 'waveguide-string', '보이스 타입은 상속받는다');
  assert.equal(r.params.scaleLengthMm, 673);
  assert.equal(r.params.pluckPosition, 0.18, '안 적은 값은 상속된다');
  // 음색 프리셋도 상속된다 → 새 악기가 프리셋까지 갖고 태어난다
  assert.ok('밝은' in r.tones);
  // 파라미터 선언(UI 자동 생성용)도 상속된다 → 편집 화면이 저절로 생긴다
  assert.equal(r.paramSpecs.scaleLengthMm?.label, '줄 길이');
});

test('없는 부모를 상속하면 누가 상속했는지 알려준다', () => {
  const bad = createRegistry([
    ...BUILT_IN_INSTRUMENTS,
    { id: 'broken', schemaVersion: 1, name: '깨진 것', extends: 'nope' },
  ]);
  assert.throws(
    () => resolveInstrument('broken', bad),
    (err: unknown) => err instanceof InstrumentResolveError && /nope.*broken/s.test(String(err)),
  );
});

test('순환 상속은 에러다', () => {
  const cyclic = createRegistry([
    { id: 'a', schemaVersion: 1, name: 'A', extends: 'b', voice: 'waveguide-string' },
    { id: 'b', schemaVersion: 1, name: 'B', extends: 'a' },
  ]);
  assert.throws(() => resolveInstrument('a', cyclic), InstrumentResolveError);
});

test('선언 없는 파라미터는 에러다', () => {
  // 선언이 없으면 UI 를 만들 수 없고, 조용히 무시하면 나중에 원인을 못 찾는다
  const sloppy = createRegistry([
    ...BUILT_IN_INSTRUMENTS,
    { id: 'typo', schemaVersion: 1, name: '오타', extends: 'acoustic-guitar', params: { scaleLenght: 600 } },
  ]);
  assert.throws(() => resolveInstrument('typo', sloppy), /scaleLenght/);
});

test('음색 프리셋 → 내 음색 오버라이드 순으로 적용된다', () => {
  const guitar = resolveInstrument('acoustic-guitar', registry);

  const plain = instrumentParams(guitar, 'default', null);
  assert.equal(plain.pluckHardness, 0.4);

  const bright = instrumentParams(guitar, '밝은', null);
  assert.equal(bright.pluckHardness, 0.8);

  // "내 음색"이 프리셋을 덮어쓴다 (sound.md 8절)
  const mine = instrumentParams(guitar, '밝은', { pluckHardness: 0.05, scaleLengthMm: 700 });
  assert.equal(mine.pluckHardness, 0.05);
  assert.equal(mine.scaleLengthMm, 700);
  assert.equal(mine.pluckPosition, 0.1, '프리셋의 나머지 값은 남는다');
});

test('없는 음색을 지정하면 에러다', () => {
  const guitar = resolveInstrument('acoustic-guitar', registry);
  assert.throws(() => instrumentParams(guitar, '없는음색', null), InstrumentResolveError);
});

test('파라미터가 선언된 범위로 클램프된다', () => {
  const guitar = resolveInstrument('acoustic-guitar', registry);
  const clamped = clampParams(guitar, { scaleLengthMm: 5000, stiffness: -1, pluckPosition: 0.25 });
  assert.equal(clamped.scaleLengthMm, 900);
  assert.equal(clamped.stiffness, 0);
  assert.equal(clamped.pluckPosition, 0.25);
});

test('악기 id 중복은 등록 시점에 막는다', () => {
  assert.throws(() => createRegistry([...BUILT_IN_INSTRUMENTS, BUILT_IN_INSTRUMENTS[1]!]), /중복/);
});

test('기준 정의는 연주용 악기 목록에 없다', () => {
  assert.ok(!playableInstrumentIds().includes('string-base'));
  assert.ok(playableInstrumentIds().includes('ukulele-soprano'));
});

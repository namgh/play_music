/**
 * 오토메이션 — 모든 대상·편집·기록 모드 (`LOGIC_PARITY.md` 1-9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyProject, createTrack } from '../model/factory.ts';
import type { Project } from '../model/project.ts';
import { roundTrip } from '../model/persistence.ts';
import { createEffect } from '../audio/effects.ts';
import { automationTargets, denormalizeParam, normalizeParam } from '../audio/automation.ts';
import {
  addAutomationPoint, clearAutomationLane, deleteAutomationPoint, lanePoints, moveAutomationPoint, recorderStep,
  setAutomationMode, writeAutomation,
} from './automationEdits.ts';

function one(): Project {
  const p = createEmptyProject('오토메이션');
  const t = createTrack({ name: '패드', instrumentId: 'synth-pad' });
  t.effects = [createEffect('eq'), createEffect('delay')];
  p.tracks.push(t);
  return p;
}
const id = (p: Project) => p.tracks[0]!.id;

test('대상 목록 — 볼륨·팬·이펙트 파라미터, 지금 값을 0~1 로', () => {
  const p = one();
  const targets = automationTargets(p.tracks[0]!);
  const names = targets.map((t) => t.target);
  assert.ok(names.includes('volume') && names.includes('pan'));
  assert.ok(names.includes('fx:0:midHz') && names.includes('fx:1:mix') && names.includes('fx:1:timeMs'));
  assert.equal(targets.find((t) => t.target === 'pan')!.info.current, 0.5);
  assert.equal(targets.find((t) => t.target === 'pan')!.info.format(0.25), 'L50');
});

test('로그 파라미터는 지수로 오가고 왕복한다', () => {
  const spec = { label: 'f', min: 200, max: 5000, default: 1000, curve: 'log' as const };
  assert.equal(Math.round(denormalizeParam(spec, 0)), 200);
  assert.equal(Math.round(denormalizeParam(spec, 1)), 5000);
  assert.equal(Math.round(denormalizeParam(spec, 0.5)), 1000);
  assert.ok(Math.abs(normalizeParam(spec, denormalizeParam(spec, 0.3)) - 0.3) < 1e-9);
});

test('점 놓기·옮기기(이웃을 못 넘는다)·지우기, 빈 레인은 사라진다', () => {
  let p = one();
  p = addAutomationPoint(p, id(p), 'pan', 100, 0.2);
  p = addAutomationPoint(p, id(p), 'pan', 300, 0.8);
  p = addAutomationPoint(p, id(p), 'pan', 100, 1.5);
  assert.deepEqual(lanePoints(p, id(p), 'pan'), [{ tick: 100, value: 1 }, { tick: 300, value: 0.8 }]);
  p = moveAutomationPoint(p, id(p), 'pan', 0, 999, 0.4);
  assert.deepEqual(lanePoints(p, id(p), 'pan')[0], { tick: 299, value: 0.4 });
  p = deleteAutomationPoint(p, id(p), 'pan', 0);
  p = deleteAutomationPoint(p, id(p), 'pan', 0);
  assert.deepEqual(p.tracks[0]!.automation, []);
  p = addAutomationPoint(p, id(p), 'fx:1:mix', 0, 0.5);
  assert.deepEqual(clearAutomationLane(p, id(p), 'fx:1:mix').tracks[0]!.automation, []);
});

test('기록 — 구간의 옛 점을 지우고 시작·끝에 점', () => {
  let p = one();
  for (const t of [0, 100, 200, 300, 400]) p = addAutomationPoint(p, id(p), 'volume', t, 1);
  p = writeAutomation(p, id(p), 'volume', { fromTick: 150, toTick: 350 }, 0.3);
  assert.deepEqual(lanePoints(p, id(p), 'volume').map((x) => [x.tick, x.value]),
    [[0, 1], [100, 1], [150, 0.3], [350, 0.3], [400, 1]]);
});

test('기록 모드 — 터치는 잡는 동안만, 래치는 놓아도 계속, 쓰기는 늘', () => {
  const run = (mode: 'touch' | 'latch' | 'write', touches: boolean[]) => {
    let state = { lastTick: null as number | null, latched: false };
    return touches.map((touching, i) => {
      const r = recorderStep(mode, state, { tick: i * 10, touching });
      state = r.next;
      return r.write ? `${r.write.fromTick}-${r.write.toTick}` : '·';
    }).join(' ');
  };
  assert.equal(run('touch', [false, true, true, false, true]), '· 10-10 10-20 · 40-40');
  assert.equal(run('latch', [false, true, false, false]), '· 10-10 10-20 20-30');
  assert.equal(run('write', [false, false, false]), '0-0 0-10 10-20');
});

test('모드·모든 대상이 저장 왕복, 모르는 대상은 버린다', () => {
  let p = one();
  p = setAutomationMode(p, id(p), 'latch');
  p = addAutomationPoint(p, id(p), 'fx:0:midHz', 0, 0.5);
  p = addAutomationPoint(p, id(p), 'pan', 10, 0.1);
  assert.deepEqual(roundTrip(p), p);
  const raw = JSON.parse(JSON.stringify(p));
  raw.tracks[0].automation.push({ target: 'mystery', points: [{ tick: 0, value: 1 }] });
  assert.equal(roundTrip(raw).tracks[0]!.automation.length, 2);
  assert.equal('automationMode' in setAutomationMode(p, id(p), 'read').tracks[0]!, false);
});

test('기록한 곡선 다듬기 — 직선 위의 점은 지우고 꺾이는 점은 남긴다', async () => {
  const { simplifyLane } = await import('./automationEdits.ts');
  let p = one();
  for (let t = 0; t <= 100; t += 10) p = addAutomationPoint(p, id(p), 'volume', t, t <= 50 ? 1 : 0.5);
  p = simplifyLane(p, id(p), 'volume');
  assert.deepEqual(lanePoints(p, id(p), 'volume').map((x) => [x.tick, x.value]), [[0, 1], [50, 1], [60, 0.5], [100, 0.5]]);
});

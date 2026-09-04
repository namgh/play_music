import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AutomationPoint } from '../model/project.ts';
import { PPQ } from '../model/time.ts';
import { automationValueAtTick, scheduleGainAutomation } from './automation.ts';

test('점이 없으면 1 — 오토메이션 없는 트랙은 예전과 같다', () => {
  assert.equal(automationValueAtTick([], 0), 1);
  assert.equal(automationValueAtTick([], 100_000), 1);
});

test('점 사이는 직선 보간한다', () => {
  const points: AutomationPoint[] = [
    { tick: 0, value: 0 },
    { tick: PPQ, value: 1 },
  ];
  assert.equal(automationValueAtTick(points, 0), 0);
  assert.equal(automationValueAtTick(points, PPQ), 1);
  assert.equal(automationValueAtTick(points, PPQ / 2), 0.5);
  assert.equal(automationValueAtTick(points, PPQ / 4), 0.25);
});

test('양 끝 밖은 마지막 값을 유지한다 — 페이드 뒤에도 갑자기 안 튄다', () => {
  const points: AutomationPoint[] = [
    { tick: PPQ, value: 0.2 },
    { tick: 2 * PPQ, value: 0.8 },
  ];
  assert.equal(automationValueAtTick(points, 0), 0.2);
  assert.equal(automationValueAtTick(points, 3 * PPQ), 0.8);
});

test('한 점만 있으면 그 값이 전 구간에 깔린다', () => {
  const points: AutomationPoint[] = [{ tick: PPQ, value: 0.5 }];
  assert.equal(automationValueAtTick(points, 0), 0.5);
  assert.equal(automationValueAtTick(points, 10 * PPQ), 0.5);
});

test('여러 구간을 순서대로 보간한다', () => {
  const points: AutomationPoint[] = [
    { tick: 0, value: 1 },
    { tick: PPQ, value: 0 },
    { tick: 2 * PPQ, value: 1 },
  ];
  assert.equal(automationValueAtTick(points, PPQ), 0);
  assert.equal(automationValueAtTick(points, 1.5 * PPQ), 0.5);
});

// AudioParam 은 브라우저 전용이라 최소한만 흉내 낸 가짜로 스케줄 호출을 검증한다
class FakeParam {
  calls: { fn: string; value: number; time: number }[] = [];
  cancelScheduledValues(time: number): void { this.calls.push({ fn: 'cancel', value: 0, time }); }
  setValueAtTime(value: number, time: number): void { this.calls.push({ fn: 'set', value, time }); }
  linearRampToValueAtTime(value: number, time: number): void { this.calls.push({ fn: 'ramp', value, time }); }
}

test('오토메이션이 없으면 고정값 하나만 예약한다', () => {
  const param = new FakeParam();
  scheduleGainAutomation(param as unknown as AudioParam, [], { bpm: 120 }, 0.34, 0, 5);
  assert.deepEqual(param.calls, [
    { fn: 'cancel', value: 0, time: 5 },
    { fn: 'set', value: 0.34, time: 5 },
  ]);
});

test('베이스 스칼라가 점 값에 곱해진다', () => {
  const param = new FakeParam();
  const points: AutomationPoint[] = [{ tick: 0, value: 0.5 }, { tick: PPQ, value: 1 }];
  scheduleGainAutomation(param as unknown as AudioParam, points, { bpm: 120 }, 0.34, 0, 0);
  const ramp = param.calls.find((c) => c.fn === 'ramp');
  assert.ok(ramp);
  assert.equal(ramp!.value, 0.34);
  // PPQ 틱 = 4분음표 하나 = 120bpm 에서 0.5초
  assert.ok(Math.abs(ramp!.time - 0.5) < 1e-9);
});

test('재생 헤드가 곡 중간이면 그 지점의 보간값에서 시작하고, 지난 점은 예약하지 않는다', () => {
  const param = new FakeParam();
  const points: AutomationPoint[] = [
    { tick: 0, value: 0 },
    { tick: PPQ, value: 1 },
    { tick: 2 * PPQ, value: 0 },
  ];
  // PPQ/2 에서 재생을 시작한다 — 첫 구간의 중간값(0.5)에서 시작해야 한다
  scheduleGainAutomation(param as unknown as AudioParam, points, { bpm: 120 }, 1, PPQ / 2, 10);
  assert.deepEqual(param.calls[0], { fn: 'cancel', value: 0, time: 10 });
  assert.equal(param.calls[1]!.fn, 'set');
  assert.ok(Math.abs(param.calls[1]!.value - 0.5) < 1e-9);
  // 지난 점(tick 0)은 램프로 다시 예약되지 않는다 — 남은 두 점만
  const ramps = param.calls.filter((c) => c.fn === 'ramp');
  assert.equal(ramps.length, 2);
});

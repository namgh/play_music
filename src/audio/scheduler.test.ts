/**
 * 스케줄러 회귀 테스트. 가짜 클럭을 써서 오디오 없이 전부 검증한다.
 *
 * 지키는 성질:
 *  - 같은 음이 두 번 예약되지 않는다
 *  - 타이머가 늦게 깨어나도 음은 제자리에 떨어진다 (예약 시각이 밀리지 않는다)
 *  - 음소거·솔로가 반영된다
 *  - 클립 밖으로 나가는 음이 잘린다
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectNoteEvents, LookaheadScheduler } from './scheduler.ts';
import type { ScheduledNote, SchedulerHost } from './scheduler.ts';
import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import { PPQ } from '../model/time.ts';
import type { Project } from '../model/project.ts';

function demoProject(): Project {
  const project = createEmptyProject('테스트');
  project.tempo.bpm = 120; // 4분음표 = 0.5초

  const track = createTrack({ name: '기타', instrumentId: 'acoustic-guitar' });
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ, label: 'A' });
  clip.notes.push(
    createNote({ startTick: 0, lengthTick: PPQ, midi: 60 }),
    createNote({ startTick: PPQ, lengthTick: PPQ, midi: 62 }),
    createNote({ startTick: 2 * PPQ, lengthTick: PPQ, midi: 64 }),
    createNote({ startTick: 3 * PPQ, lengthTick: PPQ, midi: 65 }),
  );
  track.clips.push(clip);
  project.tracks.push(track);
  return project;
}

class FakeHost implements SchedulerHost {
  time = 0;
  calls: { event: ScheduledNote; atTime: number; durationSec: number }[] = [];
  now(): number { return this.time; }
  scheduleNote(event: ScheduledNote, atTime: number, durationSec: number): void {
    this.calls.push({ event, atTime, durationSec });
  }
}

test('구간 수집은 [from, to) 반개구간이다', () => {
  const p = demoProject();
  assert.equal(collectNoteEvents(p, 0, PPQ).length, 1);          // 0 만
  assert.equal(collectNoteEvents(p, 0, PPQ + 1).length, 2);      // 0, PPQ
  assert.equal(collectNoteEvents(p, PPQ, 3 * PPQ).length, 2);    // PPQ, 2PPQ
  assert.equal(collectNoteEvents(p, 0, 4 * PPQ).length, 4);
});

test('결과는 시작 틱 순으로 정렬된다', () => {
  const p = demoProject();
  // 일부러 뒤섞어서 넣는다
  const clip = p.tracks[0]!.clips[0]!;
  clip.notes.reverse();
  const events = collectNoteEvents(p, 0, 4 * PPQ);
  const ticks = events.map((e) => e.startTick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
});

test('클립 밖으로 나가는 음은 클립 끝에서 잘린다', () => {
  const p = demoProject();
  const clip = p.tracks[0]!.clips[0]!;
  clip.notes[3]!.lengthTick = 10 * PPQ; // 클립 길이는 4 PPQ
  const events = collectNoteEvents(p, 0, 4 * PPQ);
  const last = events.at(-1)!;
  assert.equal(last.startTick, 3 * PPQ);
  assert.equal(last.lengthTick, PPQ, '클립 끝까지만 남아야 한다');
});

test('음소거된 트랙은 나오지 않고, 솔로가 있으면 솔로만 나온다', () => {
  const p = demoProject();
  const second = createTrack({ name: '베이스', instrumentId: 'electric-bass' });
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ });
  clip.notes.push(createNote({ startTick: 0, midi: 40 }));
  second.clips.push(clip);
  p.tracks.push(second);

  assert.equal(collectNoteEvents(p, 0, 4 * PPQ).length, 5);

  p.tracks[0]!.mute = true;
  assert.equal(collectNoteEvents(p, 0, 4 * PPQ).length, 1);

  p.tracks[0]!.mute = false;
  p.tracks[1]!.solo = true;
  const soloed = collectNoteEvents(p, 0, 4 * PPQ);
  assert.equal(soloed.length, 1);
  assert.equal(soloed[0]!.note.pitch.midi, 40);
});

test('같은 음을 두 번 예약하지 않는다', () => {
  const host = new FakeHost();
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.6 });
  scheduler.start(demoProject(), 0);

  // 여러 번 pump 해도 이미 예약한 구간은 다시 예약되지 않는다
  for (let i = 0; i < 10; i++) scheduler.pump();

  const ids = host.calls.map((c) => c.event.noteId);
  assert.equal(new Set(ids).size, ids.length, `중복 예약: ${ids.length - new Set(ids).size}건`);
});

test('타이머가 늦게 깨어나도 예약 시각이 밀리지 않는다', () => {
  const host = new FakeHost();
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(demoProject(), 0);

  // 타이머가 불규칙하게(심하게 늦게) 깨어나는 상황을 흉내낸다
  for (const jump of [0.03, 0.19, 0.02, 0.4, 0.07, 0.5, 0.31, 0.6]) {
    host.time += jump;
    scheduler.pump();
  }

  assert.equal(host.calls.length, 4, '음 4개가 모두 예약돼야 한다');
  // 120BPM 에서 4분음표는 0.5초. 시작이 0초였으므로 0, 0.5, 1.0, 1.5 초에 떨어져야 한다
  const times = host.calls.map((c) => c.atTime);
  assert.deepEqual(times.map((t) => Number(t.toFixed(6))), [0, 0.5, 1, 1.5]);
  // 길이도 0.5초
  for (const c of host.calls) assert.ok(Math.abs(c.durationSec - 0.5) < 1e-9);
});

test('중간부터 재생하면 그 앞의 음은 나오지 않는다', () => {
  const host = new FakeHost();
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 2 });
  scheduler.start(demoProject(), 2 * PPQ);
  scheduler.pump();

  assert.equal(host.calls.length, 2);
  assert.deepEqual(host.calls.map((c) => c.event.note.pitch.midi), [64, 65]);
  // 재생 시작 지점의 음은 시작 시각(0초)에 떨어진다
  assert.equal(host.calls[0]!.atTime, 0);
  assert.equal(host.calls[1]!.atTime, 0.5);
});

test('재생 위치가 클럭을 따라간다', () => {
  const host = new FakeHost();
  const scheduler = new LookaheadScheduler(host);
  assert.equal(scheduler.positionTicks(), 0);

  scheduler.start(demoProject(), 0);
  host.time = 1; // 120BPM 에서 1초 = 4분음표 2개
  assert.ok(Math.abs(scheduler.positionTicks() - 2 * PPQ) < 1e-9);

  scheduler.stop();
  assert.equal(scheduler.isRunning, false);
});

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

import { collectBeatEvents, collectNoteEvents, LookaheadScheduler } from './scheduler.ts';
import type { ScheduledClick, ScheduledNote, SchedulerHost } from './scheduler.ts';
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
  clicks: { click: ScheduledClick; atTime: number }[] = [];
  now(): number { return this.time; }
  scheduleNote(event: ScheduledNote, atTime: number, durationSec: number): void {
    this.calls.push({ event, atTime, durationSec });
  }
  scheduleClick(click: ScheduledClick, atTime: number): void {
    this.clicks.push({ click, atTime });
  }
}

/** 클럭을 조금씩 밀면서 pump — 실제 타이머에 가깝게 */
function run(scheduler: LookaheadScheduler, host: FakeHost, seconds: number, step = 0.02): void {
  const until = host.time + seconds;
  while (host.time < until) {
    host.time = Math.min(until, host.time + step);
    scheduler.pump();
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

// ---------------------------------------------------------------------------
// 루프 재생 (`WORKPLAN.md` 2-5)
//
// 여기가 가장 조용히 틀리는 지점이다. 예약 진행도를 곡 위치로 들고 있으면 되감기는
// 순간 "이미 예약함" 판정이 뒤로 돌아가 같은 음을 두 번 낸다.
// ---------------------------------------------------------------------------

/** 2마디 루프를 켠 프로젝트 */
function loopedProject(startTick = 0, endTick = 2 * PPQ): Project {
  const p = demoProject();
  p.loop = { startTick, endTick, enabled: true };
  return p;
}

test('루프가 꺼져 있으면 예전과 똑같이 동작한다', () => {
  const host = new FakeHost();
  const p = loopedProject();
  p.loop!.enabled = false;

  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(p, 0);
  run(scheduler, host, 2.2);

  assert.equal(host.calls.length, 4, '루프가 꺼졌는데 반복됐거나 음이 빠졌다');
});

test('루프 안의 음이 매 회차마다 정확히 한 번씩 난다', () => {
  const host = new FakeHost();
  // 0~2박 루프. 120BPM 에서 한 회차 = 1초
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(loopedProject(0, 2 * PPQ), 0);

  // 2.5초까지 + 룩어헤드 0.1 → horizon 2.6. 3회차의 음(t=2.0, 2.5)까지 들어오고
  // 4회차 첫 음(t=3.0)은 안 들어온다. **룩어헤드를 안 세면 하나 더 나온다**
  run(scheduler, host, 2.5);

  const midis = host.calls.map((c) => c.event.note.pitch.midi);
  // 루프 밖(64, 65)은 절대 나오면 안 된다
  assert.ok(!midis.includes(64) && !midis.includes(65), `루프 밖 음이 났다: ${midis}`);

  // 회차당 60, 62 하나씩
  const sixty = midis.filter((m) => m === 60).length;
  const sixtyTwo = midis.filter((m) => m === 62).length;
  assert.equal(sixty, 3, `60 이 ${sixty}번 (3회차면 3번)`);
  assert.equal(sixtyTwo, 3, `62 가 ${sixtyTwo}번`);
});

test('루프 회차 사이 간격이 정확하다 — 경계에서 밀리지 않는다', () => {
  const host = new FakeHost();
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(loopedProject(0, 2 * PPQ), 0);
  run(scheduler, host, 2.5);

  const at60 = host.calls.filter((c) => c.event.note.pitch.midi === 60).map((c) => c.atTime);
  // 루프 길이 = 2박 = 1초. 0, 1, 2초에 떨어져야 한다
  assert.deepEqual(at60.map((t) => Number(t.toFixed(6))), [0, 1, 2]);
});

test('루프 시작이 0 이 아니어도 맞는다', () => {
  const host = new FakeHost();
  // 1박~3박 루프 → 62, 64 만 반복
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(loopedProject(PPQ, 3 * PPQ), PPQ);
  // 62 는 t=0, 1.0 / 64 는 t=0.5, 1.5. horizon 1.65 까지 각각 2개
  run(scheduler, host, 1.55);

  const midis = host.calls.map((c) => c.event.note.pitch.midi);
  assert.ok(midis.every((m) => m === 62 || m === 64), `루프 밖 음이 났다: ${midis}`);
  assert.equal(midis.filter((m) => m === 62).length, 2);
  assert.equal(midis.filter((m) => m === 64).length, 2);
});

test('루프 앞에서 시작하면 흘러들어간 뒤 반복한다', () => {
  const host = new FakeHost();
  // 2박~4박 루프인데 0 에서 시작 → 60, 62 를 한 번 지나고 64, 65 를 반복
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(loopedProject(2 * PPQ, 4 * PPQ), 0);
  run(scheduler, host, 3.05);

  const midis = host.calls.map((c) => c.event.note.pitch.midi);
  assert.equal(midis.filter((m) => m === 60).length, 1, '루프 앞 음은 한 번만');
  assert.equal(midis.filter((m) => m === 62).length, 1);
  assert.ok(midis.filter((m) => m === 64).length >= 2, '루프 안 음이 반복되지 않았다');
});

test('재생 위치가 루프 안으로 감긴다', () => {
  const host = new FakeHost();
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(loopedProject(0, 2 * PPQ), 0);

  host.time = 1.25; // 한 회차(1초) + 0.25초
  const pos = scheduler.positionTicks();
  assert.ok(pos >= 0 && pos < 2 * PPQ, `위치 ${pos} 가 루프(0~${2 * PPQ}) 밖이다`);
  assert.ok(Math.abs(pos - PPQ / 2) < 1e-6, `0.25초 = 반 박이어야 하는데 ${pos}`);
});

test('길이 0 루프는 무시한다 — 재생이 멈춘 것처럼 보이면 안 된다', () => {
  const host = new FakeHost();
  const p = demoProject();
  p.loop = { startTick: PPQ, endTick: PPQ, enabled: true };

  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(p, 0);
  run(scheduler, host, 2.2);

  assert.equal(host.calls.length, 4, '길이 0 루프가 재생을 막았다');
});

// ---------------------------------------------------------------------------
// 메트로놈
// ---------------------------------------------------------------------------

test('박 수집은 [from, to) 반개구간이고 마디 첫 박에 강세가 있다', () => {
  const p = demoProject(); // 4/4
  const beats = collectBeatEvents(p, 0, 4 * PPQ);
  assert.deepEqual(beats.map((b) => b.startTick), [0, PPQ, 2 * PPQ, 3 * PPQ]);
  assert.deepEqual(beats.map((b) => b.accent), [true, false, false, false]);

  // 왼쪽 끝은 포함, 오른쪽 끝은 제외
  assert.equal(collectBeatEvents(p, PPQ, 2 * PPQ).length, 1);
  assert.equal(collectBeatEvents(p, PPQ + 1, 2 * PPQ).length, 0);
});

test('메트로놈은 켜야 나온다', () => {
  const host = new FakeHost();
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.start(demoProject(), 0);
  run(scheduler, host, 1.55);
  assert.equal(host.clicks.length, 0, '끄고 있는데 클릭이 났다');

  const host2 = new FakeHost();
  const s2 = new LookaheadScheduler(host2, { lookaheadSec: 0.1 });
  s2.setMetronome(true);
  s2.start(demoProject(), 0);
  run(s2, host2, 1.55); // horizon 1.65 → 0, 0.5, 1, 1.5 네 박

  // 120BPM 4/4 에서 박은 0.5초
  assert.equal(host2.clicks.length, 4);
  assert.deepEqual(host2.clicks.map((c) => Number(c.atTime.toFixed(6))), [0, 0.5, 1, 1.5]);
  assert.equal(host2.clicks[0]!.click.accent, true);
  assert.equal(host2.clicks[1]!.click.accent, false);
});

test('메트로놈도 루프에서 중복되지 않는다', () => {
  const host = new FakeHost();
  const scheduler = new LookaheadScheduler(host, { lookaheadSec: 0.1 });
  scheduler.setMetronome(true);
  scheduler.start(loopedProject(0, 2 * PPQ), 0);
  run(scheduler, host, 2.5);

  // 회차당 2박 × 3회차
  assert.equal(host.clicks.length, 6, `클릭 ${host.clicks.length}개 (2박 × 3회차 = 6)`);
  const times = host.clicks.map((c) => Number(c.atTime.toFixed(6)));
  assert.deepEqual(times, [0, 0.5, 1, 1.5, 2, 2.5]);
});

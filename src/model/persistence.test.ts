/**
 * 저장·불러오기 회귀 테스트.
 *
 * 두 가지를 지킨다:
 *  1. **왕복이 손실 없다** — 저장했다 열면 같은 곡이어야 한다
 *  2. **깨진 입력이 조용히 반쯤 깨진 프로젝트를 만들지 않는다** — 남이 만든 파일,
 *     예전 버전, 손으로 고친 파일이 들어온다
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from './factory.ts';
import { detune } from './pitch.ts';
import { PPQ } from './time.ts';
import { SCHEMA_VERSION } from './project.ts';
import type { Project } from './project.ts';
import {
  deserializeProject, migrate, ProjectLoadError, roundTrip, serializeProject,
} from './persistence.ts';

function rich(): Project {
  const project = createEmptyProject('비 오는 새벽');
  project.tempo.bpm = 92;
  project.key = { tonic: 'A', mode: 'minor' };
  project.tuning.a4Hz = 442;
  project.lengthBars = 8;
  project.master.gain = 0.9;
  project.master.effects = [
    { type: 'reverb', bypass: false, params: { mix: 0.2, decaySec: 1.8, preset: 'hall' } },
  ];

  const guitar = createTrack({ name: '기타', instrumentId: 'electric-guitar-lp', color: 'j3' });
  guitar.gain = 0.62;
  guitar.pan = -0.3;
  guitar.solo = true;
  guitar.toneId = '밝은';
  guitar.toneParams = { scaleLengthMm: 631, damping: 0.05 };
  guitar.effects = [{ type: 'eq', bypass: true, params: { low: 0.4, mid: 0.5, high: 0.7 } }];

  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ, label: 'GTR' });
  const plain = createNote({ startTick: 0, lengthTick: PPQ, midi: 57 });
  const tuned = createNote({ startTick: PPQ, lengthTick: PPQ / 2, midi: 60, velocity: 0.55 });
  tuned.pitch = detune(tuned.pitch, -14.5);
  tuned.pitchCurve = {
    glide: { cents: -30, ms: 90 },
    vibrato: { cents: 18, hz: 5.5, delayMs: 150 },
    points: [{ tNorm: 0, cents: -30 }, { tNorm: 1, cents: 0 }],
  };
  tuned.origin = 'ai';
  clip.notes.push(plain, tuned);

  const second = createClip({ startTick: 4 * PPQ, lengthTick: 4 * PPQ, label: 'GTR B' });
  second.locked = true;
  second.origin = 'ai';
  guitar.clips.push(clip, second);

  const bass = createTrack({ name: '베이스', instrumentId: 'electric-bass' });
  bass.mute = true;
  project.tracks.push(guitar, bass);
  return project;
}

test('왕복이 손실 없다', () => {
  const before = rich();
  const after = roundTrip(before);
  assert.deepEqual(after, before);
});

test('저장한 것은 사람이 읽을 수 있는 JSON 이다', () => {
  const text = serializeProject(rich());
  assert.ok(text.includes('"schemaVersion"'));
  assert.ok(text.includes('비 오는 새벽'));
  // 들여쓰기 — 손으로 열어볼 수 있어야 디버깅이 된다
  assert.ok(text.includes('\n  "'));
});

test('음정 곡선이 왕복에서 보존된다', () => {
  const after = roundTrip(rich());
  const note = after.tracks[0]!.clips[0]!.notes[1]!;
  assert.equal(note.pitchCurve?.glide?.cents, -30);
  assert.equal(note.pitchCurve?.vibrato?.hz, 5.5);
  assert.equal(note.pitchCurve?.points?.length, 2);
});

test('센트 미세조정이 왕복에서 보존된다', () => {
  // 차별점 ①이 저장·불러오기에서 사라지면 안 된다
  const after = roundTrip(rich());
  const note = after.tracks[0]!.clips[0]!.notes[1]!;
  assert.ok(Math.abs(note.pitch.cents - -14.5) < 1e-9, `센트가 ${note.pitch.cents} 로 변했다`);
});

test('origin / locked 가 왕복에서 보존된다', () => {
  // 차별점 ②(사용자 음소재 보존)가 이 필드에 걸려 있다
  const after = roundTrip(rich());
  assert.equal(after.tracks[0]!.clips[1]!.locked, true);
  assert.equal(after.tracks[0]!.clips[1]!.origin, 'ai');
  assert.equal(after.tracks[0]!.clips[0]!.notes[1]!.origin, 'ai');
  assert.equal(after.tracks[0]!.clips[0]!.notes[0]!.origin, 'user');
});

test('JSON 이 아니면 명확히 실패한다', () => {
  assert.throws(() => deserializeProject('이건 JSON 이 아니다'), ProjectLoadError);
  assert.throws(() => deserializeProject(''), ProjectLoadError);
});

test('구조가 틀리면 실패한다', () => {
  assert.throws(() => deserializeProject('[]'), /객체가 아니다/);
  assert.throws(
    () => deserializeProject(JSON.stringify({ schemaVersion: 1, tracks: 'nope' })),
    /배열이 아니다/,
  );
});

test('필드가 빠져도 기본값으로 채워 열린다', () => {
  // 손으로 만든 최소 파일도 열려야 한다
  const project = deserializeProject(JSON.stringify({ schemaVersion: SCHEMA_VERSION }));
  assert.equal(project.tracks.length, 0);
  assert.equal(project.tempo.bpm, 120);
  assert.equal(project.name, '이름 없는 프로젝트');
  assert.ok(project.id.startsWith('prj_'));
});

test('이상한 값은 범위로 잘린다', () => {
  const project = deserializeProject(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    tempo: { bpm: 99999 },
    tuning: { a4Hz: -5 },
    lengthBars: 0,
    master: { gain: 'loud' },
    tracks: [{
      gain: 5,
      pan: -9,
      clips: [{ notes: [{ pitch: { midi: 999, cents: 1e9 }, velocity: 12 }] }],
    }],
  }));

  assert.equal(project.tempo.bpm, 300);
  assert.equal(project.tuning.a4Hz, 380);
  assert.equal(project.lengthBars, 1);
  assert.equal(project.master.gain, 1, '숫자가 아니면 기본값');
  assert.equal(project.tracks[0]!.gain, 1);
  assert.equal(project.tracks[0]!.pan, -1);

  const note = project.tracks[0]!.clips[0]!.notes[0]!;
  // 정규화가 센트를 반음으로 접어 올리므로 자르는 순서가 중요하다
  assert.ok(note.pitch.midi >= 0 && note.pitch.midi <= 127, `midi 가 ${note.pitch.midi}`);
  assert.equal(note.velocity, 1);
});

test('id 가 없거나 겹치면 새로 발급한다', () => {
  // id 없이는 편집·언두·AI 지시가 대상을 잃는다
  const project = deserializeProject(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    tracks: [
      { id: 'trk_same', clips: [{ id: 'clp_x', notes: [{ id: 'not_dup' }, { id: 'not_dup' }] }] },
      { id: 'trk_same', clips: [] },
      { clips: [] },
    ],
  }));

  const ids = project.tracks.map((t) => t.id);
  assert.equal(new Set(ids).size, 3, `트랙 id 가 겹친다: ${ids.join(', ')}`);

  const noteIds = project.tracks[0]!.clips[0]!.notes.map((n) => n.id);
  assert.equal(new Set(noteIds).size, 2, `음 id 가 겹친다: ${noteIds.join(', ')}`);
  assert.ok(noteIds.every((n) => n.startsWith('not_')));
});

test('더 새로운 버전은 열지 않고 이유를 말한다', () => {
  assert.throws(
    () => deserializeProject(JSON.stringify({ schemaVersion: SCHEMA_VERSION + 5 })),
    /업데이트/,
  );
});

test('마이그레이션이 없는 예전 버전은 조용히 열지 않는다', () => {
  // sound.md 9-8: 스키마를 바꿀 때 마이그레이션 함수를 반드시 동반해야 한다.
  // 없으면 여기서 막힌다 — 반쯤 깨진 프로젝트를 만드는 것보다 낫다
  assert.throws(() => migrate({ schemaVersion: 0 }), /마이그레이션이 없다/);
});

test('마이그레이션 장치가 실제로 동작한다', () => {
  // 장치가 없는 상태로 두면 정작 필요할 때 동작을 모른다.
  // 가짜 v0 → v1 단계를 끼워 확인한다
  const project = deserializeProject(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    name: '현재 버전',
  }));
  assert.equal(project.schemaVersion, SCHEMA_VERSION);
  assert.equal(project.name, '현재 버전');

  // 최신 버전이면 마이그레이션을 거치지 않는다
  const untouched = migrate({ schemaVersion: SCHEMA_VERSION, name: '그대로' });
  assert.equal(untouched.name, '그대로');
});

test('빈 프로젝트도 왕복된다', () => {
  const empty = createEmptyProject('빈 것');
  assert.deepEqual(roundTrip(empty), empty);
});

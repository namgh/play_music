/**
 * MIDI 입출력 (`ROADMAP.md` P3).
 *
 * **브라우저 없이 완전히 검증되는 몇 안 되는 기능**이다 — 순수 파일 포맷이라
 * 왕복(내보내기 → 가져오기)이 그대로 테스트된다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeMidi, encodeMidi, MidiError } from './midi.ts';
import { createClip, createEmptyProject, createNote, createTrack } from './factory.ts';
import { PPQ } from './time.ts';
import type { Project } from './project.ts';

function songProject(): Project {
  const project = createEmptyProject('테스트 곡');
  project.tempo.bpm = 92;
  project.timeSignature = { num: 3, den: 4 };
  project.lengthBars = 4;

  const track = createTrack({ name: '멜로디', instrumentId: 'acoustic-guitar' });
  const clip = createClip({ startTick: 2 * PPQ, lengthTick: 8 * PPQ, label: 'A' });
  clip.notes.push(
    { ...createNote({ startTick: 0, lengthTick: PPQ, midi: 60 }), velocity: 0.8 },
    { ...createNote({ startTick: PPQ, lengthTick: PPQ / 2, midi: 64 }), velocity: 0.5 },
    { ...createNote({ startTick: 2 * PPQ, lengthTick: 2 * PPQ, midi: 67 }), velocity: 1 },
  );
  track.clips.push(clip);
  project.tracks.push(track);
  return project;
}

test('내보낸 파일이 MIDI 규격 머리를 갖는다', () => {
  const { bytes } = encodeMidi(songProject());
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'MThd');
  // 분해능은 우리 내부와 같은 PPQ 여야 한다 — 바꾸면 모든 틱을 다시 계산해야 한다
  assert.equal((bytes[12]! << 8) | bytes[13]!, PPQ);
});

test('왕복하면 음정·시작·길이가 유지된다', () => {
  const original = songProject();
  const restored = decodeMidi(encodeMidi(original).bytes);

  const source = original.tracks[0]!.clips[0]!;
  const target = restored.tracks[0]!.clips[0]!;
  assert.equal(target.notes.length, source.notes.length);

  // MIDI 는 클립 개념이 없다 — 곡 전체 기준 위치로 편다. 그래서 클립 시작을 더해 비교한다
  const sorted = [...target.notes].sort((a, b) => a.startTick - b.startTick);
  source.notes.forEach((note, i) => {
    const got = sorted[i]!;
    assert.equal(got.pitch.midi, note.pitch.midi, `${i}번 음정`);
    assert.equal(got.startTick, source.startTick + note.startTick, `${i}번 시작`);
    assert.equal(got.lengthTick, note.lengthTick, `${i}번 길이`);
  });
});

test('왕복하면 템포와 박자가 유지된다', () => {
  const original = songProject();
  const restored = decodeMidi(encodeMidi(original).bytes);
  assert.ok(Math.abs(restored.tempo.bpm - 92) < 0.5, `BPM ${restored.tempo.bpm}`);
  assert.deepEqual(restored.timeSignature, { num: 3, den: 4 });
});

test('세기가 대략 유지된다', () => {
  // 0~1 을 0~127 로 접었다 펴므로 반올림 오차만 있어야 한다
  const original = songProject();
  const restored = decodeMidi(encodeMidi(original).bytes);
  const sorted = [...restored.tracks[0]!.clips[0]!.notes].sort((a, b) => a.startTick - b.startTick);
  original.tracks[0]!.clips[0]!.notes.forEach((note, i) => {
    assert.ok(Math.abs(sorted[i]!.velocity - note.velocity) < 0.01, `${i}번 세기`);
  });
});

test('트랙 이름이 유지된다 — 한글도', () => {
  const restored = decodeMidi(encodeMidi(songProject()).bytes);
  assert.equal(restored.tracks[0]!.name, '멜로디');
});

test('센트를 버렸다고 알린다 — 조용히 반올림하지 않는다', () => {
  // "정밀한 음정"이 제품의 주장인데 조용히 버리면 사용자는 그대로 나갔다고 믿는다
  const project = songProject();
  project.tracks[0]!.clips[0]!.notes[0]!.pitch.cents = 33.3;

  const { droppedCents } = encodeMidi(project);
  assert.equal(droppedCents, 1);
  assert.equal(encodeMidi(songProject()).droppedCents, 0, '센트가 없는데 알렸다');
});

test('여러 트랙이 각자 나가고 각자 돌아온다', () => {
  const project = songProject();
  const second = createTrack({ name: '베이스', instrumentId: 'electric-bass' });
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ });
  clip.notes.push(createNote({ startTick: 0, lengthTick: PPQ, midi: 40 }));
  second.clips.push(clip);
  project.tracks.push(second);

  const restored = decodeMidi(encodeMidi(project).bytes);
  assert.equal(restored.tracks.length, 2);
  assert.equal(restored.tracks[1]!.name, '베이스');
  assert.equal(restored.tracks[1]!.clips[0]!.notes[0]!.pitch.midi, 40);
});

test('클립 밖으로 나가는 음은 클립 끝에서 잘린다', () => {
  // 스케줄러와 **같은 규칙**이어야 한다. 다르면 들은 것과 내보낸 파일이 달라진다
  const project = createEmptyProject('잘림');
  const track = createTrack({ name: 'T', instrumentId: 'acoustic-guitar' });
  const clip = createClip({ startTick: 0, lengthTick: 2 * PPQ });
  clip.notes.push(createNote({ startTick: PPQ, lengthTick: 8 * PPQ, midi: 60 }));
  track.clips.push(clip);
  project.tracks.push(track);

  const restored = decodeMidi(encodeMidi(project).bytes);
  assert.equal(restored.tracks[0]!.clips[0]!.notes[0]!.lengthTick, PPQ);
});

test('벨로시티 0 인 노트온을 노트오프로 읽는다', () => {
  // 많은 파일이 이 형태를 쓴다. 안 다루면 음이 안 꺼져 곡 끝까지 늘어난다
  const body = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 120 BPM
    0x00, 0x90, 60, 100, // 노트온
    0x60, 0x90, 60, 0, // 벨로시티 0 = 노트오프
    0x00, 0xff, 0x2f, 0x00,
  ];
  const bytes = Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (body.length >> 24) & 0xff, (body.length >> 16) & 0xff,
    (body.length >> 8) & 0xff, body.length & 0xff,
    ...body,
  ]);
  const project = decodeMidi(bytes);
  assert.equal(project.tracks[0]!.clips[0]!.notes[0]!.lengthTick, 0x60);
});

test('다른 분해능도 우리 PPQ 로 환산한다', () => {
  // 안 하면 템포는 맞는데 음 길이만 배로 틀어진다
  const division = 480; // PPQ 960 의 절반
  const body = [
    0x00, 0x90, 60, 100,
    0xf0, 0x00, 0x80, 60, 0, // 델타 0x7800? — 아래에서 VLQ 로 480 을 쓴다
    0x00, 0xff, 0x2f, 0x00,
  ];
  // 480 은 VLQ 로 0x83 0x60
  const fixed = [
    0x00, 0x90, 60, 100,
    0x83, 0x60, 0x80, 60, 0,
    0x00, 0xff, 0x2f, 0x00,
  ];
  void body;
  const bytes = Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, (division >> 8) & 0xff, division & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    0, 0, (fixed.length >> 8) & 0xff, fixed.length & 0xff,
    ...fixed,
  ]);
  const project = decodeMidi(bytes);
  // 480틱(division 기준 1박) → 우리 PPQ 로 960
  assert.equal(project.tracks[0]!.clips[0]!.notes[0]!.lengthTick, PPQ);
});

test('MIDI 가 아니면 조용히 넘어가지 않고 실패한다', () => {
  assert.throws(() => decodeMidi(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), MidiError);
});

test('음이 없는 파일은 실패한다', () => {
  const body = [0x00, 0xff, 0x2f, 0x00];
  const bytes = Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, body.length, ...body,
  ]);
  assert.throws(() => decodeMidi(bytes), /음이 하나도 없다/);
});

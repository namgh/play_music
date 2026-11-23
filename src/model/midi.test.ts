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
import { GM_DRUM_INSTRUMENTS, GM_PROGRAM_INSTRUMENTS } from './gmInstruments.ts';
import { playableInstrumentIds } from '../instruments/definitions.ts';
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

// ---------------------------------------------------------------------------
// GM 악기 지정 — 밖에서 받은 곡 MIDI 를 넣는 경로
//
// 이게 없으면 트랙이 전부 같은 소리로 들어와서, 16트랙짜리 곡을 넣은 사람은
// 악기를 열여섯 번 손으로 고른 뒤에야 들어 볼 수 있다.

/** 한 트랙짜리 SMF 를 만든다 (기존 테스트들과 같은 형태) */
function smf(body: number[], division = PPQ, trackCount = 1, format = 1): Uint8Array {
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, trackCount,
    (division >> 8) & 0xff, division & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (body.length >> 24) & 0xff, (body.length >> 16) & 0xff,
    (body.length >> 8) & 0xff, body.length & 0xff,
    ...body,
  ]);
}

test('프로그램 체인지를 악기로 읽는다', () => {
  // GM 34(0부터 세면 33) = Electric Bass (finger)
  const project = decodeMidi(smf([
    0x00, 0xc0, 33,
    0x00, 0x90, 40, 100,
    0x60, 0x90, 40, 0,
    0x00, 0xff, 0x2f, 0x00,
  ]));
  assert.equal(project.tracks[0]!.instrumentId, 'electric-bass');
});

test('프로그램 체인지가 없으면 GM 기본값(피아노)이다', () => {
  // 기타로 두면 "왜 전부 기타지"가 된다 — 규격의 기본값을 따른다
  const project = decodeMidi(smf([
    0x00, 0x90, 60, 100,
    0x60, 0x90, 60, 0,
    0x00, 0xff, 0x2f, 0x00,
  ]));
  assert.equal(project.tracks[0]!.instrumentId, 'acoustic-piano');
});

test('10번 채널은 타악기별로 트랙이 갈린다', () => {
  // GM 에서 10번 채널은 음 높이가 아니라 **어떤 타악기인지**를 가리킨다.
  // 우리는 드럼 하나가 악기 하나라, 한 트랙으로 두면 킥·스네어가 같은 소리가 난다
  const project = decodeMidi(smf([
    0x00, 0x99, 36, 100, 0x00, 0x99, 36, 0, // 킥
    0x00, 0x99, 38, 100, 0x00, 0x99, 38, 0, // 스네어
    0x00, 0x99, 42, 90, 0x00, 0x99, 42, 0, // 하이햇
    0x00, 0xff, 0x2f, 0x00,
  ]));
  const ids = project.tracks.map((t) => t.instrumentId).sort();
  assert.deepEqual(ids, ['hihat', 'kick', 'snare']);
  assert.ok(project.tracks.every((t) => t.clips[0]!.notes.length === 1));
});

test('한 트랙에 여러 채널이 섞여 있으면 채널로 가른다', () => {
  // 포맷 0 은 16채널이 한 덩어리다. 안 가르면 베이스와 리드가 한 악기로 합쳐진다
  const project = decodeMidi(smf([
    0x00, 0xc0, 0, // 채널1 = 피아노
    0x00, 0xc1, 33, // 채널2 = 일렉 베이스
    0x00, 0x90, 60, 100, 0x00, 0x90, 60, 0,
    0x00, 0x91, 40, 100, 0x00, 0x91, 40, 0,
    0x00, 0xff, 0x2f, 0x00,
  ], PPQ, 1, 0));
  assert.equal(project.tracks.length, 2);
  assert.deepEqual(project.tracks.map((t) => t.instrumentId).sort(),
    ['acoustic-piano', 'electric-bass']);
});

test('채널이 다르면 같은 음이라도 서로의 노트오프를 훔치지 않는다', () => {
  // 음 번호만으로 짝을 맞추면 포맷 0 에서 길이가 엉킨다
  const project = decodeMidi(smf([
    0x00, 0x90, 60, 100, // 채널1 시작
    0x00, 0x91, 60, 100, // 채널2 시작 (같은 음)
    0x30, 0x91, 60, 0, // 채널2 만 끝
    0x30, 0x90, 60, 0, // 채널1 끝
    0x00, 0xff, 0x2f, 0x00,
  ], PPQ, 1, 0));
  const lengths = project.tracks
    .map((t) => t.clips[0]!.notes[0]!.lengthTick)
    .sort((a, b) => a - b);
  assert.deepEqual(lengths, [0x30, 0x60]);
});

test('GM 표의 악기가 전부 실재한다', () => {
  // 오타 하나면 그 프로그램을 쓴 곡이 렌더에서 터진다. 표는 코드가 아니라
  // 데이터라 타입이 안 잡아 준다 — 그래서 여기서 잡는다
  const known = new Set(playableInstrumentIds());
  const missing = [...new Set([...GM_PROGRAM_INSTRUMENTS, ...Object.values(GM_DRUM_INSTRUMENTS)])]
    .filter((id) => !known.has(id));
  assert.deepEqual(missing, [], `없는 악기를 가리킨다: ${missing.join(', ')}`);
  assert.equal(GM_PROGRAM_INSTRUMENTS.length, 128, 'GM 프로그램은 128개다');
});

test('가사 — 음에 붙은 가사가 MIDI(FF 05)로 나갔다가 같은 음으로 돌아온다', () => {
  const project = createEmptyProject('노래');
  const track = createTrack({ name: '멜로디', instrumentId: 'acoustic-guitar' });
  const clip = createClip({ startTick: PPQ * 4, lengthTick: PPQ * 8 });
  const words = ['창', '밖', '에', null, 'snow ❄'];
  clip.notes = words.map((w, i) => {
    const note = createNote({ startTick: i * PPQ, lengthTick: PPQ, midi: 60 + i });
    return w ? { ...note, lyric: w } : note;
  });
  track.clips.push(clip);
  project.tracks.push(track);

  const back = decodeMidi(encodeMidi(project).bytes);
  const notes = back.tracks[0]!.clips[0]!.notes;
  assert.deepEqual(notes.map((n) => n.lyric ?? null), words);
  // 가사는 음의 자리·높이를 건드리지 않는다
  assert.deepEqual(notes.map((n) => n.startTick), words.map((_, i) => PPQ * 4 + i * PPQ));
  assert.deepEqual(notes.map((n) => n.pitch.midi), words.map((_, i) => 60 + i));
});

/**
 * 표준 MIDI 파일 입출력 (`ROADMAP.md` P3).
 *
 * **없으면 사용자가 갇힌다.** 다른 DAW 에서 만든 것을 못 가져오고, 여기서 만든 것을
 * 못 가져나간다. 그건 "곡 하나를 여기서 끝낸다"의 반대편 문턱이다.
 *
 * 순수 함수다 — 브라우저 API 를 쓰지 않으므로 Node 에서 그대로 테스트된다.
 * 이 프로젝트에서 **브라우저 없이 완전히 검증되는 몇 안 되는 기능**이다.
 *
 * ## 센트는 MIDI 로 나가지 않는다
 *
 * 우리 `Pitch` 는 `{midi, cents}` 인데 표준 MIDI 의 노트 번호는 정수뿐이다.
 * 센트를 피치벤드로 내보내면 **채널 단위**라 동시에 울리는 음들이 서로를 덮어쓴다
 * (MPE 는 채널을 음마다 하나씩 쓰는 별도 규격이라 범위가 다르다).
 *
 * 그래서 내보낼 때 센트를 **버리고, 버렸다고 알린다.** 조용히 반올림하면
 * "정밀한 음정"이라는 제품의 주장과 정면으로 어긋난다 — 사용자는 자기 곡이
 * 그대로 나갔다고 믿게 된다.
 */

import type { Clip, Project, Track } from './project.ts';
import { createClip, createEmptyProject, createNote, createTrack } from './factory.ts';
import { PPQ } from './time.ts';

export class MidiError extends Error {}

/** 마이크로초/사분음표 → BPM */
const MICROS_PER_MINUTE = 60_000_000;

// --- 쓰기 -------------------------------------------------------------------

/** 가변 길이 수 (VLQ). MIDI 의 델타 타임 형식이다 */
function writeVarInt(out: number[], value: number): void {
  const v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  let rest = v >>> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  out.push(...bytes);
}

function writeChunk(id: string, body: readonly number[]): number[] {
  const out: number[] = [];
  for (const ch of id) out.push(ch.charCodeAt(0));
  out.push((body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff);
  out.push(...body);
  return out;
}

interface MidiEvent {
  tick: number;
  /** 같은 틱이면 노트오프를 먼저 — 같은 음을 이어 칠 때 새 음이 바로 꺼진다 */
  order: number;
  bytes: number[];
}

/** 트랙 하나를 MTrk 바디로 */
function trackBody(track: Track, channel: number, extraHead: readonly number[]): number[] {
  const events: MidiEvent[] = [];

  for (const clip of track.clips) {
    for (const note of clip.notes) {
      const start = clip.startTick + note.startTick;
      // 클립 밖으로 나가는 음은 클립 끝에서 자른다 — 스케줄러와 같은 규칙이다
      const end = Math.min(start + note.lengthTick, clip.startTick + clip.lengthTick);
      if (end <= start) continue;

      const key = Math.max(0, Math.min(127, Math.round(note.pitch.midi)));
      const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * 127)));
      events.push({ tick: start, order: 1, bytes: [0x90 | channel, key, velocity] });
      events.push({ tick: end, order: 0, bytes: [0x80 | channel, key, 0] });
    }
  }

  events.sort((a, b) => (a.tick - b.tick) || (a.order - b.order));

  const body: number[] = [...extraHead];
  // 트랙 이름 (FF 03)
  const name = [...track.name].flatMap((ch) => {
    const code = ch.codePointAt(0) ?? 63;
    // UTF-8 로 쓴다. 규격은 ASCII 를 가정하지만 실제 DAW 들이 UTF-8 을 읽는다
    if (code < 0x80) return [code];
    if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)];
    return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
  });
  writeVarInt(body, 0);
  body.push(0xff, 0x03);
  writeVarInt(body, name.length);
  body.push(...name);

  let last = 0;
  for (const event of events) {
    writeVarInt(body, event.tick - last);
    last = event.tick;
    body.push(...event.bytes);
  }

  writeVarInt(body, 0);
  body.push(0xff, 0x2f, 0x00); // End of Track
  return body;
}

export interface MidiExportResult {
  bytes: Uint8Array;
  /** 센트가 버려진 음의 개수. 0 이 아니면 사용자에게 알려야 한다 */
  droppedCents: number;
}

/**
 * 프로젝트 → 표준 MIDI 파일 (포맷 1).
 *
 * 분해능은 우리 내부와 같은 **PPQ 960** 을 쓴다. 다른 값으로 바꾸면 모든 틱을
 * 다시 계산해야 하고 반올림 오차가 생긴다.
 */
export function encodeMidi(project: Project): MidiExportResult {
  const tracks = project.tracks;
  const chunks: number[][] = [];

  // 첫 트랙 머리에 템포·박자를 넣는다 (포맷 1 의 관례)
  const head: number[] = [];
  const microsPerBeat = Math.round(MICROS_PER_MINUTE / project.tempo.bpm);
  writeVarInt(head, 0);
  head.push(0xff, 0x51, 0x03,
    (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff);
  writeVarInt(head, 0);
  // 분모는 2의 지수로 쓴다 (4 → 2, 8 → 3)
  const denominatorPower = Math.round(Math.log2(project.timeSignature.den));
  head.push(0xff, 0x58, 0x04, project.timeSignature.num, denominatorPower, 24, 8);

  tracks.forEach((track, index) => {
    // 채널 9 는 규격상 드럼 전용이라 건너뛴다 — 다른 DAW 가 그 채널을 드럼으로 읽는다
    const channel = index % 15 >= 9 ? (index % 15) + 1 : index % 15;
    chunks.push(writeChunk('MTrk', trackBody(track, channel, index === 0 ? head : [])));
  });

  if (chunks.length === 0) {
    chunks.push(writeChunk('MTrk', trackBody(createTrack({ name: '빈 트랙', instrumentId: 'acoustic-guitar' }), 0, head)));
  }

  const header = writeChunk('MThd', [
    0x00, 0x01, // 포맷 1
    (chunks.length >> 8) & 0xff, chunks.length & 0xff,
    (PPQ >> 8) & 0xff, PPQ & 0xff,
  ]);

  const droppedCents = tracks.reduce(
    (sum, track) => sum + track.clips.reduce(
      (n, clip) => n + clip.notes.filter((note) => note.pitch.cents !== 0).length, 0,
    ), 0,
  );

  return { bytes: Uint8Array.from([...header, ...chunks.flat()]), droppedCents };
}

// --- 읽기 -------------------------------------------------------------------

class Reader {
  private at = 0;
  private readonly bytes: Uint8Array;

  // **파라미터 프로퍼티를 쓰지 않는다.** Node 의 타입 스트리핑은 변환이 아니라
  // 제거라서 `constructor(private x)` 가 통째로 실패한다 (`HANDOFF.md` 작업 규칙)
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean { return this.at >= this.bytes.length; }
  get position(): number { return this.at; }

  byte(): number {
    if (this.at >= this.bytes.length) throw new MidiError('파일이 중간에서 끝났다');
    return this.bytes[this.at++]!;
  }

  uint32(): number {
    return (this.byte() << 24 | this.byte() << 16 | this.byte() << 8 | this.byte()) >>> 0;
  }

  uint16(): number { return this.byte() << 8 | this.byte(); }

  tag(): string {
    return String.fromCharCode(this.byte(), this.byte(), this.byte(), this.byte());
  }

  varInt(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new MidiError('가변 길이 수가 너무 길다');
  }

  skip(count: number): void { this.at += count; }
  seek(to: number): void { this.at = to; }
}

interface OpenNote { tick: number; velocity: number }

/**
 * 표준 MIDI 파일 → 프로젝트.
 *
 * 다른 분해능(division)으로 온 파일은 **우리 PPQ 로 환산한다.** 안 하면 템포가
 * 맞는데 음 길이만 배로 틀어진다.
 */
export function decodeMidi(bytes: Uint8Array, name = '가져온 곡'): Project {
  const reader = new Reader(bytes);
  if (reader.tag() !== 'MThd') throw new MidiError('MIDI 파일이 아니다');
  const headerLength = reader.uint32();
  reader.uint16(); // 포맷 — 0·1·2 모두 트랙을 순서대로 읽으면 된다
  const trackCount = reader.uint16();
  const division = reader.uint16();
  if ((division & 0x8000) !== 0) throw new MidiError('SMPTE 타임코드 파일은 아직 못 읽는다');
  if (division === 0) throw new MidiError('분해능이 0 이다');
  reader.skip(headerLength - 6);

  const project = createEmptyProject(name);
  project.tracks = [];
  const scale = PPQ / division;
  let longestTick = 0;

  for (let index = 0; index < trackCount && !reader.done; index++) {
    const tag = reader.tag();
    const length = reader.uint32();
    const end = reader.position + length;
    if (tag !== 'MTrk') { reader.seek(end); continue; }

    const notes: { startTick: number; lengthTick: number; midi: number; velocity: number }[] = [];
    const open = new Map<number, OpenNote>();
    let tick = 0;
    let running = 0;
    let trackName = `트랙 ${index + 1}`;

    while (reader.position < end) {
      tick += reader.varInt() * scale;
      let status = reader.byte();
      if ((status & 0x80) === 0) {
        // 러닝 스테이터스 — 상태 바이트를 생략한 것이다. 되돌려 놓고 앞 상태를 쓴다
        reader.seek(reader.position - 1);
        status = running;
      } else if (status < 0xf0) {
        running = status;
      }

      if (status === 0xff) {
        const type = reader.byte();
        const len = reader.varInt();
        const start = reader.position;
        if (type === 0x51 && len === 3) {
          const micros = (reader.byte() << 16) | (reader.byte() << 8) | reader.byte();
          if (micros > 0) project.tempo.bpm = Math.round((MICROS_PER_MINUTE / micros) * 100) / 100;
        } else if (type === 0x58 && len >= 2) {
          project.timeSignature = { num: reader.byte(), den: 2 ** reader.byte() };
        } else if (type === 0x03) {
          const raw: number[] = [];
          for (let i = 0; i < len; i++) raw.push(reader.byte());
          const decoded = new TextDecoder().decode(Uint8Array.from(raw)).trim();
          if (decoded) trackName = decoded;
        }
        reader.seek(start + len);
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        reader.skip(reader.varInt());
        continue;
      }

      const kind = status & 0xf0;
      if (kind === 0x90 || kind === 0x80) {
        const key = reader.byte();
        const velocity = reader.byte();
        // **벨로시티 0 인 노트온은 노트오프다.** 많은 파일이 이 형태를 쓴다 —
        // 안 다루면 음이 영원히 안 꺼지고 길이가 곡 끝까지 늘어난다
        if (kind === 0x90 && velocity > 0) {
          open.set(key, { tick, velocity });
        } else {
          const started = open.get(key);
          if (started) {
            open.delete(key);
            const lengthTick = Math.max(1, Math.round(tick - started.tick));
            notes.push({
              startTick: Math.round(started.tick),
              lengthTick,
              midi: key,
              velocity: started.velocity / 127,
            });
          }
        }
      } else if (kind === 0xc0 || kind === 0xd0) {
        reader.byte();
      } else {
        reader.byte();
        reader.byte();
      }
    }
    reader.seek(end);

    if (notes.length === 0) continue;

    const track = createTrack({ name: trackName, instrumentId: 'acoustic-guitar' });
    const lastTick = Math.max(...notes.map((n) => n.startTick + n.lengthTick));
    longestTick = Math.max(longestTick, lastTick);

    const clip: Clip = createClip({ startTick: 0, lengthTick: lastTick, label: trackName });
    clip.notes = notes.map((n) => {
      const note = createNote({
        startTick: n.startTick,
        lengthTick: n.lengthTick,
        midi: n.midi,
      });
      return { ...note, velocity: n.velocity };
    });
    track.clips.push(clip);
    project.tracks.push(track);
  }

  if (project.tracks.length === 0) throw new MidiError('음이 하나도 없다');

  const barTicks = PPQ * 4 * (project.timeSignature.num / project.timeSignature.den);
  project.lengthBars = Math.max(1, Math.ceil(longestTick / barTicks));
  return project;
}

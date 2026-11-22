/**
 * 예제 곡 — 다 지어진 곡을 열어 **고쳐 가며** 배운다.
 *
 * 녹음 파일이 아니라 전부 음(노트)이다. 그래서 멜로디 한 음, 코드 하나, 악기 하나까지
 * 편집기에서 그대로 바꿀 수 있다 — 오디오로 구운 AI 노래에서는 안 되는 일이다.
 * 구간마다 클립을 나눠 깔아서 "후렴만 복제", "벌스만 뮤트" 가 바로 된다.
 *
 * AI 가 지은 것이므로 음·클립의 출처는 `ai` 다 (`project.ts` 의 Origin).
 * 가사는 멜로디 음에 붙어 있다 (악보 보기에서 음 아래에 적힌다).
 */

import type { EffectSpec, Project } from './project.ts';
import { PPQ } from './time.ts';
import {
  createClip, createEmptyProject, createNote, createTrack, newChordId, newMarkerId, newSectionId,
} from './factory.ts';

export interface DemoSong {
  id: string;
  name: string;
  description: string;
  bpm: number;
  bars: number;
  meter: string;
  key: NonNullable<Project['key']>;
  build: () => Project;
}

// ---------------------------------------------------------------------------
// 작은 작곡 도구 — 박(4분음표) 단위로 적는다
// ---------------------------------------------------------------------------

/** 곡 시작 기준 박 자리의 음 하나 */
interface Ev { beat: number; len: number; midi: number; vel: number; lyric?: string | undefined }
/** 멜로디 한 음: [음이름 또는 쉼(null), 길이(박)] */
type Mel = [string | null, number];
type Chord = [root: string, quality: 'maj' | 'min'];
interface Part {
  name: string;
  instrumentId: string;
  color: string;
  gain: number;
  pan?: number;
  effects?: EffectSpec[];
  events: Ev[];
}

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'F#5' → 78 (C4 = 60) */
export function midiOf(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`음이름을 읽을 수 없습니다: ${name}`);
  return PC[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}

const rootPc = (c: Chord) => PC[c[0][0]!]! + (c[0].endsWith('#') ? 1 : 0);
/** 코드의 세 음을 `low` 부터 한 옥타브 안에 모은다 (오름차순) — 코드가 바뀌어도 손이 덜 움직인다 */
function voiced(c: Chord, low: number): number[] {
  const r = rootPc(c);
  return [0, c[1] === 'maj' ? 4 : 3, 7]
    .map((i) => low + ((((r + i - low) % 12) + 12) % 12))
    .sort((a, b) => a - b);
}
const rootAt = (c: Chord, low: number) => low + ((((rootPc(c) - low) % 12) + 12) % 12);

/** 멜로디를 차례로 깐다. 가사는 쉼이 아닌 음에 한 글자씩 */
function sing(startBeat: number, shape: Mel[], vel: number, lyrics = ''): Ev[] {
  const syllables = [...lyrics.replace(/\s+/g, '')];
  const out: Ev[] = [];
  let beat = startBeat;
  for (const [name, len] of shape) {
    if (name) out.push({ beat, len: len * 0.96, midi: midiOf(name), vel, lyric: syllables.shift() });
    beat += len;
  }
  return out;
}

const reverb = (mix: number, decaySec: number): EffectSpec => (
  { type: 'reverb', bypass: false, params: { mix, decaySec, dampingHz: 5000 } }
);
const delay = (timeMs: number, mix: number): EffectSpec => (
  { type: 'delay', bypass: false, params: { timeMs, feedback: 0.3, mix, dampingHz: 3500 } }
);

interface SongSpec {
  name: string;
  bpm: number;
  beatsPerBar: number;
  key: NonNullable<Project['key']>;
  sections: [name: string, bars: number][];
  /** 마디마다 코드 하나 */
  chords: Chord[];
  parts: Part[];
}

/** 적어 둔 것을 프로젝트로 — 구간마다 클립 하나, 코드·구간·마커는 글로벌 트랙에 */
function assemble(spec: SongSpec): Project {
  const bar = spec.beatsPerBar * PPQ;
  const project = createEmptyProject(spec.name);
  project.tempo.bpm = spec.bpm;
  project.timeSignature = { num: spec.beatsPerBar, den: 4 };
  project.key = spec.key;
  project.lengthBars = spec.chords.length;
  // 리버브·딜레이 꼬리가 얹혀도 잘리지 않게 머리 위를 비워 둔다
  project.master.gain = 0.8;

  let at = 0;
  const ranges = spec.sections.map(([name, bars]) => {
    const r = { name, start: at * bar, end: (at + bars) * bar };
    at += bars;
    return r;
  });
  project.sections = ranges.map((r) => ({ id: newSectionId(), startTick: r.start, lengthTick: r.end - r.start, name: r.name }));
  project.markers = ranges.map((r) => ({ id: newMarkerId(), tick: r.start, name: r.name }));
  project.chords = spec.chords
    .map((c, i) => ({ id: newChordId(), tick: i * bar, root: c[0], quality: c[1], bass: null }))
    .filter((c, i) => i === 0 || c.root !== spec.chords[i - 1]![0] || c.quality !== spec.chords[i - 1]![1]);

  for (const part of spec.parts) {
    const track = createTrack({ name: part.name, instrumentId: part.instrumentId, color: part.color });
    track.gain = part.gain;
    track.pan = part.pan ?? 0;
    track.effects = part.effects ?? [];
    for (const r of ranges) {
      const notes = part.events
        .map((e) => ({ e, tick: Math.round(e.beat * PPQ) }))
        .filter(({ tick }) => tick >= r.start && tick < r.end)
        .map(({ e, tick }) => {
          const note = createNote({
            startTick: tick - r.start,
            lengthTick: Math.max(30, Math.min(Math.round(e.len * PPQ), r.end - tick)),
            midi: e.midi,
            velocity: e.vel,
            origin: 'ai',
          });
          if (e.lyric) note.lyric = e.lyric;
          return note;
        });
      if (notes.length === 0) continue;
      track.clips.push(createClip({ startTick: r.start, lengthTick: r.end - r.start, label: r.name, origin: 'ai', notes }));
    }
    project.tracks.push(track);
  }
  return project;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

// ---------------------------------------------------------------------------
// 1. 첫눈 오는 밤 — 겨울 댄스곡 (C장조, 124 BPM)
//    인트로 4 · 벌스 8 · 프리코러스 4 · 코러스 8 · 브리지 4 · 아웃트로 4
// ---------------------------------------------------------------------------

function firstSnowNight(): Project {
  const B = 4;
  const Am: Chord = ['A', 'min']; const F: Chord = ['F', 'maj']; const C: Chord = ['C', 'maj']; const G: Chord = ['G', 'maj'];
  const chords: Chord[] = [
    Am, F, C, G, // 인트로
    Am, F, C, G, Am, F, C, G, // 벌스
    F, G, Am, G, // 프리코러스
    F, G, C, Am, F, G, C, C, // 코러스
    Am, F, C, G, // 브리지
    F, G, C, C, // 아웃트로
  ];
  const INTRO = range(0, 4); const PRE = range(12, 16);
  const CHORUS = range(16, 24); const BRIDGE = range(24, 28); const OUTRO = range(28, 32);
  const LAST = 31;

  const kick: Ev[] = []; const clap: Ev[] = []; const hat: Ev[] = []; const bells: Ev[] = []; const crash: Ev[] = [];
  const bass: Ev[] = []; const pad: Ev[] = []; const pluck: Ev[] = []; const glock: Ev[] = [];
  const hit = (list: Ev[], bar: number, beat: number, midi: number, vel: number, len = 0.25) => list.push({ beat: bar * B + beat, len, midi, vel });

  for (const bar of range(0, 32)) {
    const chord = chords[bar]!;
    const inBridge = BRIDGE.includes(bar);
    const big = CHORUS.includes(bar) || OUTRO.includes(bar);

    // 킥 — 네 박 다 (포 온 더 플로어). 브리지에서는 첫 박만 남겨 숨을 고른다
    if (bar >= 2) {
      const beats = inBridge ? [0] : bar === LAST ? [0, 1, 2] : [0, 1, 2, 3];
      for (const b of beats) hit(kick, bar, b, 36, 0.95);
    }
    // 클랩 — 2·4박
    if (bar >= 4 && !(inBridge && bar < 26)) for (const b of [1, 3]) hit(clap, bar, b, 39, 0.8);
    if (bar === 15) for (const b of [2.5, 3.5]) hit(clap, bar, b, 39, 0.6); // 코러스로 넘어가는 채움
    // 하이햇 — 엇박 8분
    if (bar >= 2 && !(inBridge && bar < 26)) for (const b of [0.5, 1.5, 2.5, 3.5]) hit(hat, bar, b, 42, 0.5);
    // 썰매 방울 (탬버린) — 겨울 느낌은 여기서 난다
    if (big) for (let s = 0; s < 16; s++) hit(bells, bar, s / 4, 54, s % 2 === 0 ? 0.45 : 0.22, 0.2);
    else if (INTRO.includes(bar) || inBridge) for (let s = 0; s < 8; s++) hit(bells, bar, s / 2, 54, s % 2 === 0 ? 0.38 : 0.24, 0.2);
    if (bar === 4 || bar === 16 || bar === 28) hit(crash, bar, 0, 49, 0.7, 2);

    // 베이스 — 벌스는 엇박(킥 사이), 코러스는 옥타브 8분
    const root = rootAt(chord, 36);
    if (INTRO.includes(bar) || inBridge) { if (bar >= 2) bass.push({ beat: bar * B, len: 3.8, midi: root, vel: 0.7 }); }
    else if (big) for (let s = 0; s < 8; s++) bass.push({ beat: bar * B + s / 2, len: 0.4, midi: root + (s % 2 ? 12 : 0), vel: s % 2 ? 0.7 : 0.85 });
    else for (const b of [0.5, 1.5, 2.5, 3.5]) bass.push({ beat: bar * B + b, len: 0.4, midi: root, vel: 0.82 });

    // 패드 — 마디마다 코드
    for (const midi of voiced(chord, 55)) pad.push({ beat: bar * B, len: 3.95, midi, vel: PRE.includes(bar) ? 0.6 : 0.5 });

    // 플럭 아르페지오 — 코러스에서 16분으로 촘촘해진다
    const [s0, s1, s2] = voiced(chord, 60) as [number, number, number];
    if (big) for (let s = 0; s < 16; s++) pluck.push({ beat: bar * B + s / 4, len: 0.22, midi: [s0, s1, s2, s1][s % 4]!, vel: s % 4 === 0 ? 0.62 : 0.42 });
    else if (!INTRO.includes(bar)) for (let s = 0; s < 8; s++) pluck.push({ beat: bar * B + s / 2, len: 0.4, midi: [s0, s2, s1, s2][s % 4]!, vel: (PRE.includes(bar) ? 0.4 + (bar - 12) * 0.06 : 0.45) + (s % 4 === 0 ? 0.1 : 0) });

    // 글로켄슈필 — 인트로·브리지는 8분 훅, 코러스는 듬성듬성
    const [g0, g1, g2] = voiced(chord, 72) as [number, number, number];
    if (INTRO.includes(bar) || inBridge) [g0, g2, g1, g2, g0, g2, g1, g2].forEach((midi, s) => glock.push({ beat: bar * B + s / 2, len: 0.45, midi, vel: s % 4 === 0 ? 0.6 : 0.42 }));
    else if (big) for (const [b, midi] of [[0, g2], [1.5, g1], [3, g2]] as const) glock.push({ beat: bar * B + b, len: 0.9, midi, vel: 0.5 });
  }

  // 멜로디 — 벌스는 낮게 말하듯, 프리코러스에서 올라가서, 코러스에서 가장 높은 음을 친다
  const verse: Mel[] = [
    [null, 0.5], ['E4', 0.5], ['A4', 0.5], ['A4', 0.5], ['B4', 0.5], ['C5', 1], ['B4', 0.5],
    ['A4', 1.5], [null, 0.5], ['A4', 0.5], ['C5', 0.5], ['A4', 1],
    [null, 0.5], ['G4', 0.5], ['C5', 0.5], ['C5', 0.5], ['D5', 0.5], ['E5', 1], ['D5', 0.5],
    ['D5', 1.5], [null, 0.5], ['B4', 0.5], ['D5', 0.5], ['B4', 1],
  ];
  const pre: Mel[] = [
    ['C5', 1], ['C5', 1], ['D5', 1], ['E5', 1],
    ['D5', 1], ['D5', 1], ['E5', 1], ['G5', 1],
    ['E5', 1.5], ['E5', 0.5], ['G5', 1], ['A5', 1],
    ['G5', 1], ['A5', 1], ['B5', 2],
  ];
  const hookA: Mel[] = [
    ['C5', 0.5], ['C5', 0.5], ['A5', 1.5], [null, 0.5], ['A5', 0.5], ['G5', 0.5],
    ['G5', 1.5], [null, 0.5], ['D5', 0.5], ['D5', 0.5], ['G5', 0.5], ['G5', 0.5],
  ];
  const chorus: Mel[] = [
    ...hookA,
    ['E5', 0.5], ['E5', 0.5], ['G5', 1.5], [null, 1.5],
    [null, 1], ['E5', 0.5], ['E5', 0.5], ['D5', 0.5], ['C5', 0.5], ['A4', 1],
    ...hookA,
    ['E5', 0.5], ['E5', 0.5], ['C6', 2], [null, 1],
    [null, 1], ['G5', 0.5], ['G5', 0.5], ['E5', 0.5], ['D5', 0.5], ['C5', 1],
  ];
  const outro: Mel[] = [
    ...hookA,
    ['E5', 0.5], ['E5', 0.5], ['C6', 2], [null, 1],
    [null, 1], ['G5', 0.5], ['G5', 0.5], ['E5', 0.5], ['D5', 0.5], ['C5', 1],
  ];
  const lead: Ev[] = [
    ...sing(4 * B, verse, 0.72, '창밖에하얀눈 이내려와 거리마다불빛 이춤을춰'),
    ...sing(8 * B, verse, 0.74, '두손을꼭잡고 서달려가 얼어붙은마음 도녹아가'),
    ...sing(12 * B, pre, 0.8, '오늘밤은 멈추지않 아더크게 소리쳐'),
    ...sing(16 * B, chorus, 0.9, '눈이와오늘 밤온세상이 반짝여 하얀겨울밤 눈이와너와 나발맞춰서 춤을춰 밤새도록예'),
    ...sing(28 * B, outro, 0.9, '눈이와너와 나발맞춰서 춤을춰 하얀겨울밤'),
  ];

  const eighthDot = Math.round((60000 / 124) * 0.75);
  return assemble({
    name: '첫눈 오는 밤',
    bpm: 124,
    beatsPerBar: B,
    key: { tonic: 'C', mode: 'major' },
    sections: [['인트로', 4], ['벌스', 8], ['프리코러스', 4], ['코러스', 8], ['브리지', 4], ['아웃트로', 4]],
    chords,
    parts: [
      { name: '멜로디 (가사)', instrumentId: 'synth-lead', color: 'j5', gain: 0.2, effects: [delay(eighthDot, 0.16), reverb(0.16, 1.8)], events: lead },
      { name: '글로켄슈필', instrumentId: 'glockenspiel', color: 'j3', gain: 0.6, pan: 0.3, effects: [reverb(0.28, 2.4)], events: glock },
      { name: '플럭', instrumentId: 'synth-pluck', color: 'j1', gain: 0.15, pan: -0.3, effects: [delay(eighthDot, 0.14)], events: pluck },
      { name: '패드', instrumentId: 'synth-pad', color: 'j4', gain: 0.14, effects: [reverb(0.25, 2.6)], events: pad },
      { name: '신스 베이스', instrumentId: 'synth-bass', color: 'j2', gain: 0.15, events: bass },
      { name: '킥', instrumentId: 'kick', color: 'j6', gain: 0.75, events: kick },
      { name: '클랩', instrumentId: 'clap', color: 'j6', gain: 0.6, events: clap },
      { name: '하이햇', instrumentId: 'hihat', color: 'j6', gain: 0.35, pan: 0.15, events: hat },
      { name: '썰매 방울', instrumentId: 'tambourine', color: 'j6', gain: 0.3, pan: -0.2, events: bells },
      { name: '크래시', instrumentId: 'crash-cymbal', color: 'j6', gain: 0.45, events: crash },
    ],
  });
}

// ---------------------------------------------------------------------------
// 2. 작은 종소리 — 캐롤풍 왈츠 (G장조, 3/4, 108 BPM)
//    인트로 4 · 1절 8 · 2절 8 · 후렴 8 · 아웃트로 4
// ---------------------------------------------------------------------------

function littleBells(): Project {
  const B = 3;
  const G: Chord = ['G', 'maj']; const D: Chord = ['D', 'maj']; const Em: Chord = ['E', 'min']; const C: Chord = ['C', 'maj'];
  const chords: Chord[] = [
    G, C, G, D, // 인트로
    G, D, Em, C, G, Em, C, D, // 1절 — 반쯤 열어 두고 끝난다 (D)
    G, D, Em, C, G, C, D, G, // 2절 — 으뜸으로 닫는다 (G)
    C, D, G, Em, C, D, G, G, // 후렴
    C, D, G, G, // 아웃트로
  ];
  const INTRO = range(0, 4); const V1 = range(4, 12); const CHORUS = range(20, 28);

  const piano: Ev[] = []; const cbass: Ev[] = []; const harp: Ev[] = []; const chime: Ev[] = [];
  const sleigh: Ev[] = []; const pad: Ev[] = [];

  for (const bar of range(0, 32)) {
    const chord = chords[bar]!;
    const at = bar * B;
    const soft = INTRO.includes(bar) ? 0.8 : 1;
    const last = bar === 31;

    // 피아노 — 왈츠 반주: 쿵(낮은 음) 짝 짝(코드)
    piano.push({ beat: at, len: last ? 2.9 : 0.95, midi: rootAt(chord, 41), vel: 0.62 * soft });
    for (const b of last ? [] : [1, 2]) for (const midi of voiced(chord, 55)) piano.push({ beat: at + b, len: 0.8, midi, vel: 0.4 * soft });
    if (last) for (const midi of voiced(chord, 55)) piano.push({ beat: at, len: 2.9, midi, vel: 0.45 });

    // 콘트라베이스 피치카토 — 첫 박, 후렴은 셋째 박에 5도
    if (bar >= 4) {
      const root = rootAt(chord, 31);
      cbass.push({ beat: at, len: 0.9, midi: root, vel: 0.75 });
      if (CHORUS.includes(bar)) cbass.push({ beat: at + 2, len: 0.8, midi: root + 7, vel: 0.55 });
    }

    // 하프 — 8분 아르페지오로 올라간다. 1절은 비워 두어 2절부터 풍성해지게
    if (!V1.includes(bar)) {
      const [h0, h1, h2] = voiced(chord, 48) as [number, number, number];
      const up = [h0, h1, h2, h0 + 12, h1 + 12, h2 + 12];
      (last ? up.slice(0, 1) : up).forEach((midi, s) => harp.push({ beat: at + s / 2, len: last ? 2.9 : 0.9, midi, vel: s === 0 ? 0.5 : 0.36 }));
    }

    // 차임벨 — 구간이 바뀌는 자리에서 한 번
    if ([0, 4, 12, 20, 24, 28, 31].includes(bar)) chime.push({ beat: at, len: 2.9, midi: rootAt(chord, 55), vel: 0.5 });

    // 썰매 방울 — 2절부터
    if (bar >= 12 && !last) {
      sleigh.push({ beat: at, len: 0.2, midi: 54, vel: 0.5 }, { beat: at + 1, len: 0.2, midi: 54, vel: 0.3 }, { beat: at + 2, len: 0.2, midi: 54, vel: 0.3 });
      if (CHORUS.includes(bar)) for (const b of [0.5, 1.5, 2.5]) sleigh.push({ beat: at + b, len: 0.2, midi: 54, vel: 0.18 });
    }

    // 패드 — 2절부터 깔리는 따뜻한 바닥
    if (bar >= 12) for (const midi of voiced(chord, 55)) pad.push({ beat: at, len: 2.95, midi, vel: 0.42 });
  }

  const verseA: Mel[] = [
    ['D5', 1], ['G5', 1], ['B5', 1],
    ['A5', 2], ['F#5', 1],
    ['G5', 1], ['E5', 1], ['G5', 1],
    ['E5', 3],
    ['D5', 1], ['G5', 1], ['B5', 1],
    ['B5', 2], ['G5', 1],
    ['E5', 1], ['G5', 1], ['F#5', 1],
    ['A5', 3],
  ];
  const verseB: Mel[] = [
    ...verseA.slice(0, 10),
    ['D5', 1], ['G5', 1], ['B5', 1],
    ['C6', 2], ['G5', 1],
    ['A5', 1], ['F#5', 1], ['A5', 1],
    ['G5', 3],
  ];
  const chorus: Mel[] = [
    ['E5', 1], ['G5', 1], ['C6', 1],
    ['D6', 2], ['A5', 1],
    ['B5', 1], ['D6', 1], ['B5', 1],
    ['G5', 3],
    ['E5', 1], ['G5', 1], ['C6', 1],
    ['D6', 2], ['A5', 1],
    ['B5', 1], ['A5', 1], ['G5', 1],
    ['G5', 3],
  ];
  const tag: Mel[] = [['E5', 1], ['G5', 1], ['C6', 1], ['D6', 2], ['A5', 1], ['B5', 3], ['G5', 3]];
  const introMotif: Mel[] = [['D5', 1], ['G5', 1], ['B5', 1], ['C6', 2], ['G5', 1], ['B5', 3], ['A5', 3]];

  const melody: Ev[] = [
    ...sing(4 * B, verseA, 0.66, '작은종 소리 울려퍼 져 하얀눈 길위 에내려 와'),
    ...sing(12 * B, verseB, 0.7, '창가에 촛불 하나켜 고 그대오 기를 기다려 요'),
    ...sing(20 * B, chorus, 0.8, '메리메 리크 리스마 스 온세상 에사 랑이가 득'),
    ...sing(28 * B, tag, 0.7),
  ];
  const glock: Ev[] = [
    ...sing(0, introMotif, 0.55),
    ...sing(20 * B, chorus, 0.5),
    ...sing(28 * B, tag, 0.5),
  ];

  return assemble({
    name: '작은 종소리',
    bpm: 108,
    beatsPerBar: B,
    key: { tonic: 'G', mode: 'major' },
    sections: [['인트로', 4], ['1절', 8], ['2절', 8], ['후렴', 8], ['아웃트로', 4]],
    chords,
    parts: [
      { name: '멜로디 (가사)', instrumentId: 'celesta', color: 'j5', gain: 0.8, effects: [reverb(0.26, 2.8)], events: melody },
      { name: '글로켄슈필', instrumentId: 'glockenspiel', color: 'j3', gain: 0.5, pan: 0.3, effects: [reverb(0.3, 2.8)], events: glock },
      { name: '피아노', instrumentId: 'acoustic-piano', color: 'j1', gain: 0.4, pan: -0.1, effects: [reverb(0.16, 2.2)], events: piano },
      { name: '하프', instrumentId: 'harp', color: 'j4', gain: 0.4, pan: -0.35, effects: [reverb(0.24, 2.6)], events: harp },
      { name: '패드', instrumentId: 'synth-pad', color: 'j4', gain: 0.13, effects: [reverb(0.3, 3)], events: pad },
      { name: '콘트라베이스', instrumentId: 'double-bass-pizz', color: 'j2', gain: 0.6, events: cbass },
      { name: '차임벨', instrumentId: 'tubular-bell', color: 'j3', gain: 0.6, pan: 0.2, effects: [reverb(0.35, 3.2)], events: chime },
      { name: '썰매 방울', instrumentId: 'tambourine', color: 'j6', gain: 0.35, pan: 0.25, events: sleigh },
    ],
  });
}

export const DEMO_SONGS: DemoSong[] = [
  {
    id: 'first-snow-night', name: '첫눈 오는 밤', description: '겨울 댄스곡 — 네 박 킥, 썰매 방울, 높이 치는 후렴',
    bpm: 124, bars: 32, meter: '4/4', key: { tonic: 'C', mode: 'major' }, build: firstSnowNight,
  },
  {
    id: 'little-bells', name: '작은 종소리', description: '캐롤풍 왈츠 — 첼레스타 멜로디, 하프, 차임벨',
    bpm: 108, bars: 32, meter: '3/4', key: { tonic: 'G', mode: 'major' }, build: littleBells,
  },
];

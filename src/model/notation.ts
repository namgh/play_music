/**
 * 악보 표기 — 음표 데이터를 마디·음표 모양·쉼표·붙임줄·조표·임시표로 (Logic Score Editor,
 * `LOGIC_PARITY.md` 1-5). 그리기(SVG)와 MusicXML 이 같은 결과를 쓴다. 순수 함수.
 *
 * 연주 데이터를 그대로 그리면 32분음표 쉼표 투성이가 된다. 그래서 **16분 격자로 맞춘 뒤**
 * 박 경계를 넘는 음은 나눠 붙임줄로 잇는다 — 사람이 읽는 악보의 기본 규칙이다.
 * 동시에 시작하는 음은 화음 하나로, 겹치는 다른 길이는 가장 짧은 것에 맞춘다(한 성부).
 */

import type { MusicalKey, Note, Project } from './project.ts';
import { barStartTick, positionAt } from './meter.ts';
import { tonicSemitone } from './pitch.ts';
import { PPQ, ticksPerBar, ticksPerBeat } from './time.ts';
import type { Ticks, TimeSignature } from './time.ts';

export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export interface Spelled { midi: number; step: Step; alter: -1 | 0 | 1; octave: number; /** 그 자리에 임시표를 그리나 */ accidental: 'sharp' | 'flat' | 'natural' | null }
export type NoteType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th';

export interface NEvent {
  kind: 'note' | 'rest';
  /** 마디 안 위치 (틱) */
  offset: Ticks;
  duration: Ticks;
  type: NoteType;
  dots: 0 | 1;
  pitches: Spelled[];
  /** 다음 조각과 붙임줄로 이어지나 */
  tie: boolean;
}

export interface Measure {
  index: number;
  timeSignature: TimeSignature;
  /** 이 마디에서 박자가 바뀌었나 (박자표를 다시 그린다) */
  showTime: boolean;
  events: NEvent[];
}

export const GRID = PPQ / 4;

const DURATIONS: { ticks: Ticks; type: NoteType; dots: 0 | 1 }[] = [
  { ticks: PPQ * 4, type: 'whole', dots: 0 },
  { ticks: PPQ * 3, type: 'half', dots: 1 },
  { ticks: PPQ * 2, type: 'half', dots: 0 },
  { ticks: PPQ * 1.5, type: 'quarter', dots: 1 },
  { ticks: PPQ, type: 'quarter', dots: 0 },
  { ticks: PPQ * 0.75, type: 'eighth', dots: 1 },
  { ticks: PPQ / 2, type: 'eighth', dots: 0 },
  { ticks: PPQ * 0.375, type: '16th', dots: 1 },
  { ticks: PPQ / 4, type: '16th', dots: 0 },
];

/** 조표 — 올림(+)·내림(−) 개수 (MusicXML fifths) */
export function keyFifths(key: MusicalKey | null): number {
  if (!key) return 0;
  const root = tonicSemitone(key.tonic) ?? 0;
  // 장조로 바꿔 5도권 자리를 찾는다 (단조는 나란한조)
  const major = key.mode === 'minor' ? (root + 3) % 12 : root;
  const table: Record<number, number> = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5 };
  const f = table[major] ?? 0;
  // F# 장조(6)는 그대로, Db(−5)는 내림으로 — 흔히 쓰는 쪽
  return f;
}

const SHARP_ORDER: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** 조표가 이 음이름에 붙이는 변화 */
export function keyAlter(fifths: number, step: Step): -1 | 0 | 1 {
  if (fifths > 0 && SHARP_ORDER.slice(0, fifths).includes(step)) return 1;
  if (fifths < 0 && FLAT_ORDER.slice(0, -fifths).includes(step)) return -1;
  return 0;
}

const SHARP_NAMES: [Step, -1 | 0 | 1][] = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT_NAMES: [Step, -1 | 0 | 1][] = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];

/** 음 이름 붙이기 — 조표가 내림이면 내림으로, 아니면 올림으로. 조표와 다르면 임시표 */
export function spell(midi: number, fifths: number): Spelled {
  const pc = ((midi % 12) + 12) % 12;
  const [step, alter] = (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[pc]!;
  const octave = Math.floor(midi / 12) - 1;
  const ka = keyAlter(fifths, step);
  const accidental = alter === ka ? null : alter === 1 ? 'sharp' : alter === -1 ? 'flat' : 'natural';
  return { midi, step, alter, octave, accidental };
}

/** 길이를 박 경계에 맞는 표준 음표들로 나눈다 */
/** 쉼표는 점을 쓰지 않는다 (점 4분쉼표보다 4분+8분쉼표가 읽기 쉽다) */
function split(offset: Ticks, duration: Ticks, ts: TimeSignature, allowDots = true): { offset: Ticks; d: (typeof DURATIONS)[number] }[] {
  const out: { offset: Ticks; d: (typeof DURATIONS)[number] }[] = [];
  const beat = ticksPerBeat(ts);
  let pos = offset;
  let left = duration;
  while (left >= GRID) {
    const pick = DURATIONS.find((c) => {
      if (c.ticks > left || (!allowDots && c.dots)) return false;
      const base = c.dots ? (c.ticks * 2) / 3 : c.ticks;
      // 박보다 긴 음은 박 경계에서, 짧은 음은 자기 길이 배수 자리에서만 시작한다
      return base >= beat ? pos % beat === 0 && (base < PPQ * 2 || pos % (PPQ * 2) === 0) : pos % base === 0 && Math.floor(pos / beat) === Math.floor((pos + c.ticks - 1) / beat);
    }) ?? DURATIONS[DURATIONS.length - 1]!;
    out.push({ offset: pos, d: pick });
    pos += pick.ticks;
    left -= pick.ticks;
  }
  return out;
}

const q = (t: Ticks) => Math.round(t / GRID) * GRID;

/**
 * 클립(곡 기준 `startTick` 에서 시작) 의 음을 마디로. `fromBar` 부터 `bars` 개.
 * 결과는 마디마다 음·쉼표가 빈틈없이 채워져 있다.
 */
export function notate(project: Project, notes: readonly Note[], clipStart: Ticks, fromBar: number, bars: number): Measure[] {
  const fifths = keyFifths(project.key);
  const measures: Measure[] = [];
  let prevTs: TimeSignature | null = null;
  // 곡 기준 시작·끝으로 맞추고, 같은 시작끼리 묶는다
  const events = notes
    .map((n) => ({ start: q(clipStart + n.startTick), end: q(clipStart + n.startTick + n.lengthTick), midi: n.pitch.midi }))
    .map((e) => ({ ...e, end: Math.max(e.end, e.start + GRID) }))
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
  const groups: { start: Ticks; end: Ticks; midis: number[] }[] = [];
  for (const e of events) {
    const g = groups[groups.length - 1];
    if (g && g.start === e.start) { g.midis.push(e.midi); g.end = Math.min(g.end, e.end); }
    else groups.push({ start: e.start, end: e.end, midis: [e.midi] });
  }
  // 다음 묶음이 시작하면 앞 묶음을 거기서 끊는다 (한 성부)
  for (let i = 0; i < groups.length - 1; i++) groups[i]!.end = Math.min(groups[i]!.end, groups[i + 1]!.start);

  for (let b = fromBar; b < fromBar + bars; b++) {
    const pos = barStartTick(project, b);
    const ts = positionAt(project, pos).timeSignature;
    const len = ticksPerBar(ts);
    const out: NEvent[] = [];
    let cursor = 0;
    const rest = (from: Ticks, to: Ticks) => {
      for (const p of split(from, to - from, ts, false)) out.push({ kind: 'rest', offset: p.offset, duration: p.d.ticks, type: p.d.type, dots: p.d.dots, pitches: [], tie: false });
    };
    for (const g of groups) {
      const s = Math.max(g.start, pos) - pos;
      const e = Math.min(g.end, pos + len) - pos;
      if (e <= 0 || s >= len || e <= s) continue;
      if (s > cursor) rest(cursor, s);
      const pieces = split(s, e - s, ts);
      const continues = g.end > pos + len; // 다음 마디로 이어진다
      pieces.forEach((p, i) => out.push({
        kind: 'note', offset: p.offset, duration: p.d.ticks, type: p.d.type, dots: p.d.dots,
        pitches: [...g.midis].sort((a, c) => a - c).map((m) => spell(m, fifths)),
        tie: i < pieces.length - 1 || continues,
      }));
      cursor = e;
    }
    if (cursor < len) {
      // 마디 전체가 비면 온쉼표 하나
      if (cursor === 0) out.push({ kind: 'rest', offset: 0, duration: len, type: 'whole', dots: 0, pitches: [], tie: false });
      else rest(cursor, len);
    }
    measures.push({ index: b, timeSignature: ts, showTime: !prevTs || prevTs.num !== ts.num || prevTs.den !== ts.den, events: out });
    prevTs = ts;
  }
  return measures;
}

/** 높은음자리표·낮은음자리표 고르기 — 음 평균이 가운데 도 아래면 낮은음 */
export function chooseClef(notes: readonly Note[]): 'treble' | 'bass' {
  if (notes.length === 0) return 'treble';
  const avg = notes.reduce((a, n) => a + n.pitch.midi, 0) / notes.length;
  return avg < 58 ? 'bass' : 'treble';
}

// ---------------------------------------------------------------------------
// MusicXML — Logic·MuseScore·Finale·Sibelius 가 다 읽는 교환 형식
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toMusicXml(project: Project, parts: { name: string; measures: Measure[]; clef: 'treble' | 'bass' }[]): string {
  const fifths = keyFifths(project.key);
  const partList = parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name></score-part>`).join('');
  const body = parts.map((p, i) => {
    const measures = p.measures.map((m, mi) => {
      const attrs = mi === 0 || m.showTime
        ? `<attributes>${mi === 0 ? `<divisions>${PPQ}</divisions><key><fifths>${fifths}</fifths></key>` : ''}<time><beats>${m.timeSignature.num}</beats><beat-type>${m.timeSignature.den}</beat-type></time>${mi === 0 ? `<clef><sign>${p.clef === 'bass' ? 'F' : 'G'}</sign><line>${p.clef === 'bass' ? 4 : 2}</line></clef>` : ''}</attributes>`
        : '';
      const tempo = mi === 0 && i === 0 ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${project.tempo.bpm}</per-minute></metronome></direction-type><sound tempo="${project.tempo.bpm}"/></direction>` : '';
      const notes = m.events.map((e) => {
        const common = `<duration>${e.duration}</duration>${e.kind === 'note' && e.tie ? '<tie type="start"/>' : ''}<type>${e.type}</type>${e.dots ? '<dot/>' : ''}`;
        if (e.kind === 'rest') return `<note><rest${e.type === 'whole' && e.offset === 0 && e.duration === m.events[0]!.duration && m.events.length === 1 ? ' measure="yes"' : ''}/>${common}</note>`;
        return e.pitches.map((pt, k) => `<note>${k > 0 ? '<chord/>' : ''}<pitch><step>${pt.step}</step>${pt.alter ? `<alter>${pt.alter}</alter>` : ''}<octave>${pt.octave}</octave></pitch>${common}${pt.accidental ? `<accidental>${pt.accidental}</accidental>` : ''}${e.tie ? '<notations><tied type="start"/></notations>' : ''}</note>`).join('');
      }).join('');
      return `<measure number="${m.index + 1}">${attrs}${tempo}${notes}</measure>`;
    }).join('');
    return `<part id="P${i + 1}">${measures}</part>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0"><work><work-title>${esc(project.name)}</work-title></work><part-list>${partList}</part-list>${body}</score-partwise>\n`;
}

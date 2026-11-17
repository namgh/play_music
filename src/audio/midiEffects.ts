/**
 * MIDI 이펙트 — 아르페지에이터 · 코드 트리거 · 트랜스포저 · 노트 리피터 · 세기 처리 ·
 * 스케일 맞추기 · 랜더마이저 (Logic MIDI plug-ins, `LOGIC_PARITY.md` 1-10·1-12).
 *
 * **스케줄 직전에 음 목록을 바꾸는 순수 함수다.** 음 데이터는 그대로 두고(피아노 롤은
 * 사용자가 친 것을 보여 준다) 소리만 바뀐다 — Logic 의 MIDI 이펙트도 리전 내용을
 * 바꾸지 않는다. 재생·내보내기가 같은 `collectNoteEvents` 를 거치므로 들은 것과 파일이
 * 같다. 무작위는 **음 id 로 씨앗을 정해** 같은 곡은 언제나 같은 소리다.
 */

import type { Clip, MidiEffect, MusicalKey, Note, NoteId, Track } from '../model/project.ts';
import { tonicSemitone } from '../model/pitch.ts';
import { PPQ } from '../model/time.ts';
import type { Ticks } from '../model/time.ts';

const clampMidi = (m: number) => Math.max(0, Math.min(127, Math.round(m)));
const clampVel = (v: number) => Math.max(0.01, Math.min(1, v));

/** 문자열 → 0~1 결정적 난수 (FNV-1a) */
function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 0x100000000;
}

const derive = (note: Note, tag: string): NoteId => `${note.id}~${tag}` as NoteId;

function arpeggiate(notes: Note[], fx: Extract<MidiEffect, { type: 'arpeggiator' }>): Note[] {
  // 동시에 시작하는 음(±1/32박)을 화음 하나로 묶는다
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
  const groups: Note[][] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0]!.startTick - n.startTick) <= PPQ / 8) g.push(n);
    else groups.push([n]);
  }
  const out: Note[] = [];
  for (const chord of groups) {
    const start = chord[0]!.startTick;
    const end = Math.max(...chord.map((n) => n.startTick + n.lengthTick));
    const base = [...chord].sort((a, b) => a.pitch.midi - b.pitch.midi);
    const ladder: Note[] = [];
    for (let o = 0; o < Math.max(1, fx.octaves); o++) {
      for (const n of base) ladder.push({ ...n, pitch: { ...n.pitch, midi: clampMidi(n.pitch.midi + 12 * o) } });
    }
    const order = fx.mode === 'up' ? ladder
      : fx.mode === 'down' ? [...ladder].reverse()
        : fx.mode === 'updown' ? [...ladder, ...[...ladder].reverse().slice(1, -1)]
          : fx.mode === 'played' ? [...chord].sort((a, b) => a.startTick - b.startTick)
            : ladder; // random 은 아래에서 고른다
    let step = 0;
    for (let t = start; t < end; t += fx.rate, step++) {
      const pick = fx.mode === 'random'
        ? ladder[Math.floor(hash01(`${chord[0]!.id}:${step}`) * ladder.length)]!
        : order[step % order.length]!;
      out.push({
        ...pick,
        id: derive(pick, `a${step}`),
        startTick: t,
        lengthTick: Math.max(1, Math.round(Math.min(fx.rate * fx.gate, end - t))),
      });
    }
  }
  return out;
}

function inScale(midi: number, key: MusicalKey): boolean {
  const root = tonicSemitone(key.tonic) ?? 0;
  const steps = key.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return steps.includes((((midi - root) % 12) + 12) % 12);
}

/** 한 이펙트를 음 목록에 */
export function applyMidiEffect(notes: Note[], fx: MidiEffect, key: MusicalKey | null): Note[] {
  if (fx.bypass) return notes;
  switch (fx.type) {
    case 'transposer':
      return notes.map((n) => ({ ...n, pitch: { ...n.pitch, midi: clampMidi(n.pitch.midi + fx.semitones) } }));
    case 'chordTrigger':
      return notes.flatMap((n) => [n, ...fx.intervals.filter((i) => i !== 0).map((i) => ({
        ...n, id: derive(n, `c${i}`), pitch: { ...n.pitch, midi: clampMidi(n.pitch.midi + i) },
      }))]);
    case 'velocity':
      return notes.map((n) => ({ ...n, velocity: clampVel(fx.mode === 'fixed' ? fx.value : fx.mode === 'scale' ? n.velocity * fx.value : n.velocity + fx.value) }));
    case 'noteRepeater':
      return notes.flatMap((n) => [n, ...Array.from({ length: Math.max(0, fx.repeats) }, (_, i) => ({
        ...n,
        id: derive(n, `r${i + 1}`),
        startTick: n.startTick + fx.delay * (i + 1),
        velocity: clampVel(n.velocity * Math.pow(fx.feedback, i + 1)),
        pitch: { ...n.pitch, midi: clampMidi(n.pitch.midi + fx.transpose * (i + 1)) },
      }))]);
    case 'scaleQuantizer': {
      const k = key ?? { tonic: 'C', mode: 'major' as const };
      return notes.map((n) => {
        for (let d = 0; d <= 6; d++) for (const m of [n.pitch.midi - d, n.pitch.midi + d]) {
          if (inScale(m, k)) return m === n.pitch.midi ? n : { ...n, pitch: { ...n.pitch, midi: clampMidi(m) } };
        }
        return n;
      });
    }
    case 'randomizer':
      return notes.map((n) => {
        const r1 = hash01(`${n.id}:t`) * 2 - 1;
        const r2 = hash01(`${n.id}:v`) * 2 - 1;
        return { ...n, startTick: Math.max(0, Math.round(n.startTick + r1 * fx.timing)), velocity: clampVel(n.velocity + r2 * fx.velocity) };
      });
    case 'arpeggiator':
      return arpeggiate(notes, fx);
    default:
      return notes;
  }
}

const cache = new WeakMap<Clip, { key: string; notes: Note[] }>();

/** 트랙의 MIDI 이펙트를 순서대로 거친 클립의 음. 같은 클립·같은 설정이면 다시 계산하지 않는다 */
export function processedNotes(track: Pick<Track, 'midiEffects'>, clip: Clip, key: MusicalKey | null): Note[] {
  const effects = track.midiEffects ?? [];
  if (effects.length === 0 || effects.every((e) => e.bypass)) return clip.notes;
  const cacheKey = JSON.stringify([effects, key]);
  const hit = cache.get(clip);
  if (hit && hit.key === cacheKey) return hit.notes;
  let notes = clip.notes;
  for (const fx of effects) notes = applyMidiEffect(notes, fx, key);
  notes = [...notes].sort((a, b) => a.startTick - b.startTick);
  cache.set(clip, { key: cacheKey, notes });
  return notes;
}

/** 기본값으로 채운 MIDI 이펙트 */
export function createMidiEffect(type: MidiEffect['type']): MidiEffect {
  switch (type) {
    case 'arpeggiator': return { type, bypass: false, mode: 'up', rate: PPQ / 4, octaves: 1, gate: 0.8 };
    case 'chordTrigger': return { type, bypass: false, intervals: [0, 4, 7] };
    case 'transposer': return { type, bypass: false, semitones: 12 };
    case 'velocity': return { type, bypass: false, mode: 'scale', value: 1 };
    case 'noteRepeater': return { type, bypass: false, repeats: 3, delay: PPQ / 2, feedback: 0.6, transpose: 0 };
    case 'scaleQuantizer': return { type, bypass: false };
    case 'randomizer': return { type, bypass: false, timing: PPQ / 32, velocity: 0.08 };
  }
}

export const MIDI_EFFECT_LABELS: Record<MidiEffect['type'], string> = {
  arpeggiator: '아르페지에이터',
  chordTrigger: '코드 트리거',
  transposer: '트랜스포저',
  velocity: '세기 처리',
  noteRepeater: '노트 리피터',
  scaleQuantizer: '스케일 맞추기',
  randomizer: '랜더마이저',
};

export type { Ticks };

/**
 * 코드 이론 — 코드 기호의 구성음, 표기, 그리고 음표에서 코드 알아내기.
 *
 * Logic 의 코드 트랙·Chord ID 에 대응한다. 알아내기는 **결정적 규칙**이다 —
 * 같은 음이면 언제나 같은 코드가 나온다. AI 가 아니라서 틀릴 때 왜 틀렸는지
 * 설명할 수 있어야 한다 (구성음 일치 점수를 그대로 돌려준다).
 */

import type { ChordQuality, ChordSymbol, Project } from './project.ts';
import { CHORD_QUALITIES, isClipAudible } from './project.ts';
import { NOTE_NAMES, tonicSemitone } from './pitch.ts';
import type { Ticks } from './time.ts';

/** 근음 기준 반음 간격 */
export const CHORD_INTERVALS: Record<ChordQuality, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  '6': [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  add9: [0, 2, 4, 7],
};

const SUFFIX: Record<ChordQuality, string> = {
  maj: '', min: 'm', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4',
  '7': '7', maj7: 'maj7', min7: 'm7', m7b5: 'm7♭5', dim7: 'dim7', '6': '6', min6: 'm6', add9: 'add9',
};

/** 'Am7', 'C/E' … */
export function chordLabel(chord: Pick<ChordSymbol, 'root' | 'quality' | 'bass'>): string {
  const base = `${chord.root}${SUFFIX[chord.quality]}`;
  return chord.bass && chord.bass !== chord.root ? `${base}/${chord.bass}` : base;
}

/** 구성음의 피치 클래스(0=C) */
export function chordPitchClasses(chord: Pick<ChordSymbol, 'root' | 'quality'>): number[] {
  const root = tonicSemitone(chord.root) ?? 0;
  return CHORD_INTERVALS[chord.quality].map((i) => (root + i) % 12);
}

/** 근음을 반음 단위로 옮긴 코드 (전조). 베이스도 같이 */
export function transposeChord<T extends Pick<ChordSymbol, 'root' | 'bass'>>(chord: T, semitones: number): T {
  const shift = (name: string) => NOTE_NAMES[(((tonicSemitone(name) ?? 0) + semitones) % 12 + 12) % 12]!;
  return { ...chord, root: shift(chord.root), bass: chord.bass === null ? null : shift(chord.bass) };
}

export interface ChordGuess {
  root: string;
  quality: ChordQuality;
  bass: string | null;
  /** 0~1. 구성음이 울린 무게 중 코드 밖 음이 차지한 비율을 뺀 값 */
  score: number;
}

/**
 * 피치 클래스별 무게(울린 길이 × 세기)에서 코드를 고른다.
 *
 * 점수 = 코드 구성음에 든 무게 − 밖의 무게 × 0.6 − 빠진 구성음 × 벌점.
 * 3화음을 4화음보다 조금 우대한다 — 7음이 약하게 스치기만 해도 7화음으로 부르면
 * 사람이 읽는 코드 표와 어긋난다.
 */
export function guessChord(weights: readonly number[], lowestPc: number | null): ChordGuess | null {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best: ChordGuess | null = null;
  let bestRaw = -Infinity;
  for (let root = 0; root < 12; root++) {
    for (const quality of CHORD_QUALITIES) {
      const pcs = CHORD_INTERVALS[quality].map((i) => (root + i) % 12);
      const inside = pcs.reduce((a, pc) => a + weights[pc]!, 0);
      const missing = pcs.filter((pc) => weights[pc]! <= total * 0.02).length;
      // 근음이 없으면 그 코드라고 부르기 어렵다
      if (weights[root]! <= total * 0.02) continue;
      const raw = (inside - (total - inside) * 0.6) / total
        - missing * 0.35
        - (pcs.length > 3 ? 0.04 : 0)
        // 맨 아래 음이 근음이면 같은 점수에서 그쪽을 고른다 (C6 대 Am7 같은 동음이의)
        + (lowestPc === root ? 0.05 : 0);
      if (raw > bestRaw) {
        bestRaw = raw;
        const bass = lowestPc !== null && lowestPc !== root && pcs.includes(lowestPc) ? NOTE_NAMES[lowestPc]! : null;
        best = { root: NOTE_NAMES[root]!, quality, bass, score: Math.max(0, Math.min(1, raw)) };
      }
    }
  }
  return best;
}

export interface AnalyzeOptions {
  /** 몇 틱마다 하나씩 판정하나 (보통 한 마디 또는 반 마디) */
  stepTick: Ticks;
  fromTick?: Ticks;
  toTick: Ticks;
  /** 분석에 넣을 트랙. 없으면 전부 — 드럼은 호출하는 쪽이 빼야 한다 */
  trackIds?: readonly string[];
  /** 이보다 낮은 점수는 버린다 */
  minScore?: number;
}

/**
 * 음표에서 코드 진행을 알아낸다 (Logic Chord ID 의 MIDI 쪽).
 * 같은 코드가 이어지면 하나로 묶는다. 결과는 `ChordSymbol` 에서 id 만 빠진 것.
 */
export function analyzeChords(project: Project, options: AnalyzeOptions): Omit<ChordSymbol, 'id'>[] {
  const step = Math.max(1, options.stepTick);
  const from = options.fromTick ?? 0;
  const wanted = options.trackIds ? new Set(options.trackIds) : null;
  const out: Omit<ChordSymbol, 'id'>[] = [];

  for (let start = from; start < options.toTick; start += step) {
    const end = start + step;
    const weights = new Array<number>(12).fill(0);
    let lowest: number | null = null;
    for (const track of project.tracks) {
      if (wanted && !wanted.has(track.id)) continue;
      if (track.mute) continue;
      for (const clip of track.clips) {
        if (!isClipAudible(clip)) continue;
        const clipEnd = clip.startTick + clip.lengthTick;
        for (const note of clip.notes) {
          const a = Math.max(start, clip.startTick + note.startTick);
          const b = Math.min(end, clip.startTick + note.startTick + note.lengthTick, clipEnd);
          if (b <= a) continue;
          weights[((note.pitch.midi % 12) + 12) % 12]! += (b - a) * (0.3 + note.velocity);
          if (lowest === null || note.pitch.midi < lowest) lowest = note.pitch.midi;
        }
      }
    }
    const guess = guessChord(weights, lowest === null ? null : ((lowest % 12) + 12) % 12);
    if (!guess || guess.score < (options.minScore ?? 0.2)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.root === guess.root && prev.quality === guess.quality && prev.bass === guess.bass) continue;
    out.push({ tick: start, root: guess.root, quality: guess.quality, bass: guess.bass });
  }
  return out;
}

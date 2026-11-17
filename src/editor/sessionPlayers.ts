/**
 * 세션 연주자 — 코드 트랙을 따라 드럼·베이스·건반 파트를 **규칙으로** 만든다
 * (Logic Session Players / Drummer, `LOGIC_PARITY.md` 1-6).
 *
 * 생성 AI 가 아니다. 스타일마다 정해 둔 리듬 틀에 복잡도·세기·필인을 얹고, 씨앗으로
 * 변주한다 — **같은 설정이면 언제나 같은 연주**라 되돌리기·다시 만들기가 예측된다.
 * 오프라인에서 돈다. 생성 AI(`AI_GENERATION.md`)는 착수 조건 전이라 여기에 없다.
 *
 * 만든 음은 보통 음이다 — 피아노 롤·스텝·이벤트 목록에서 그대로 고친다.
 */

import type { ChordSymbol, Clip, Note, Project, TrackId } from '../model/project.ts';
import { createClip, createNote } from '../model/factory.ts';
import { chordPitchClasses } from '../model/chords.ts';
import { positionAt } from '../model/meter.ts';
import { tonicSemitone } from '../model/pitch.ts';
import { PPQ } from '../model/time.ts';
import type { Ticks } from '../model/time.ts';
import { EditError } from './edits.ts';

const S = PPQ / 4; // 16분

/** 결정적 난수 (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DrumStyle = 'pop' | 'rock' | 'funk' | 'ballad' | 'hiphop';
export const DRUM_STYLES: Record<DrumStyle, { label: string; kick: number[]; snare: number[]; hat: number[]; ghost: number[] }> = {
  // 16칸 기준 — 숫자는 그 칸에서 칠 확률(1 = 늘)
  pop: { label: '팝', kick: [1, 0, 0, 0, 0, 0, 0, 0.3, 1, 0, 0.5, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], ghost: [0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.4] },
  rock: { label: '록', kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], ghost: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3] },
  funk: { label: '펑크', kick: [1, 0, 0, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0.5, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], ghost: [0, 0.4, 0, 0, 0, 0, 0, 0.6, 0, 0.5, 0, 0, 0, 0, 0.5, 0] },
  ballad: { label: '발라드', kick: [1, 0, 0, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], ghost: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  hiphop: { label: '힙합', kick: [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0], snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], hat: [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1], ghost: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0] },
};

export interface PlayerRange { fromTick: Ticks; toTick: Ticks }

/**
 * 이 트랙의 범위에 음을 쓴다 — 범위 안의 옛 음은 지우고(다시 만들기), 새 음은 그 자리를
 * 덮는 클립에 넣는다. 덮는 클립이 없는 빈 자리에는 클립을 새로 깐다(기존 클립은 건드리지 않는다).
 */
function writePart(project: Project, trackId: TrackId, range: PlayerRange, notes: Note[], label: string): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) throw new EditError(`트랙 ${trackId} 없음`);
  const inRange = (abs: Ticks) => abs >= range.fromTick && abs < range.toTick;
  // 1) 범위 안의 옛 음 지우기
  let clips: Clip[] = track.clips.map((c) => ({ ...c, notes: c.notes.filter((n) => !inRange(c.startTick + n.startTick)) }));
  // 2) 범위에서 클립이 없는 빈 자리를 찾아 클립을 깐다
  const covered = clips.filter((c) => c.startTick < range.toTick && range.fromTick < c.startTick + c.lengthTick)
    .map((c) => [Math.max(range.fromTick, c.startTick), Math.min(range.toTick, c.startTick + c.lengthTick)] as const)
    .sort((a, b) => a[0] - b[0]);
  let at = range.fromTick;
  for (const [a, b] of [...covered, [range.toTick, range.toTick] as const]) {
    if (a > at) clips.push(createClip({ startTick: at, lengthTick: a - at, label }));
    at = Math.max(at, b);
  }
  // 3) 새 음을 그 시작을 덮는 클립으로
  for (const n of notes) {
    const abs = range.fromTick + n.startTick;
    const host = clips.find((c) => abs >= c.startTick && abs < c.startTick + c.lengthTick && !c.audio);
    if (!host) continue; // 오디오 클립 자리 — 음을 넣지 않는다
    clips = clips.map((c) => (c.id === host.id ? { ...c, notes: [...c.notes, { ...n, startTick: abs - c.startTick }] } : c));
  }
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, clips } : t)) };
}

export interface DrumOptions {
  style: DrumStyle;
  /** 0~1 — 고스트 노트·추가 킥 */
  complexity: number;
  /** 0~1 — 세기, 하이햇 16분 */
  intensity: number;
  /** 구간 끝(또는 4마디마다) 필인 */
  fills: boolean;
  seed: number;
}

/**
 * 드러머 — 킥·스네어·하이햇 트랙에 나눠 친다. 트랙이 없는 소리는 건너뛴다.
 * 범위는 마디 경계여야 한다(아니면 첫 마디부터 어긋난다).
 */
export function generateDrums(
  project: Project,
  tracks: { kick?: TrackId | undefined; snare?: TrackId | undefined; hat?: TrackId | undefined },
  range: PlayerRange,
  o: DrumOptions,
): Project {
  const r = rng(o.seed);
  const pat = DRUM_STYLES[o.style];
  const parts = { kick: [] as Note[], snare: [] as Note[], hat: [] as Note[] };
  const sectionEnds = new Set((project.sections ?? []).map((s) => s.startTick + s.lengthTick));
  const vel = (base: number) => Math.max(0.15, Math.min(1, base * (0.65 + 0.35 * o.intensity) + (r() - 0.5) * 0.08));
  for (let bar = range.fromTick; bar < range.toTick;) {
    const pos = positionAt(project, bar);
    const len = pos.timeSignature.num * (PPQ * 4) / pos.timeSignature.den;
    const steps = Math.round(len / S);
    const barEnd = bar + len;
    const barIndex = pos.bar - positionAt(project, range.fromTick).bar;
    const fillBar = o.fills && (sectionEnds.has(barEnd) || (sectionEnds.size === 0 && barIndex % 4 === 3));
    for (let i = 0; i < steps; i++) {
      const at = bar + i * S - range.fromTick;
      const k = i % 16;
      const inFill = fillBar && i >= steps - 4;
      if (inFill) {
        // 마지막 박을 스네어로 채운다 — 세기가 올라가며 다음 마디 첫 박으로 몰아간다
        parts.snare.push(createNote({ startTick: at, lengthTick: S, midi: 38, velocity: vel(0.55 + (i - (steps - 4)) * 0.12) }));
        continue;
      }
      if (r() < pat.kick[k]! + (o.complexity > 0.6 && k % 4 === 3 ? 0.15 * o.complexity : 0)) {
        parts.kick.push(createNote({ startTick: at, lengthTick: S, midi: 36, velocity: vel(k % 8 === 0 ? 1 : 0.8) }));
      }
      if (pat.snare[k]! && r() < pat.snare[k]!) parts.snare.push(createNote({ startTick: at, lengthTick: S, midi: 38, velocity: vel(0.95) }));
      else if (r() < pat.ghost[k]! * o.complexity) parts.snare.push(createNote({ startTick: at, lengthTick: S, midi: 38, velocity: vel(0.3) }));
      const sixteenths = o.intensity > 0.7 || o.style === 'funk';
      const hatOn = pat.hat[k]! || (sixteenths && k % 2 === 1);
      if (hatOn && r() < (pat.hat[k]! || 0.85)) parts.hat.push(createNote({ startTick: at, lengthTick: S, midi: 42, velocity: vel(k % 4 === 0 ? 0.75 : 0.5) }));
    }
    bar = barEnd;
  }
  let next = project;
  if (tracks.kick) next = writePart(next, tracks.kick, range, parts.kick, '세션 드럼');
  if (tracks.snare) next = writePart(next, tracks.snare, range, parts.snare, '세션 드럼');
  if (tracks.hat) next = writePart(next, tracks.hat, range, parts.hat, '세션 드럼');
  return next;
}

/** 그 자리에 울리는 코드 (코드 트랙에서). 없으면 null */
export function chordAt(project: Project, tick: Ticks): ChordSymbol | null {
  let found: ChordSymbol | null = null;
  for (const c of project.chords ?? []) {
    if (c.tick > tick) break;
    found = c;
  }
  return found;
}

export type BassStyle = 'root' | 'rootFifth' | 'octave' | 'walking';
export const BASS_STYLES: Record<BassStyle, string> = { root: '근음', rootFifth: '근음·5도', octave: '옥타브', walking: '워킹' };

/** 베이스 — 코드 트랙을 따라. 근음은 E1~D#2 사이로 내려 둔다 */
export function generateBass(project: Project, trackId: TrackId, range: PlayerRange, o: { style: BassStyle; rhythm: 'quarters' | 'eighths' | 'syncopated'; seed: number }): Project {
  if ((project.chords ?? []).length === 0) throw new EditError('코드 트랙이 비었다 — 글로벌 트랙의 코드 줄에서 코드를 놓거나 "음에서 찾기"를 누르세요');
  const r = rng(o.seed);
  const notes: Note[] = [];
  const grid = o.rhythm === 'quarters' ? [0, 4, 8, 12] : o.rhythm === 'eighths' ? [0, 2, 4, 6, 8, 10, 12, 14] : [0, 3, 6, 8, 10, 14];
  for (let bar = range.fromTick; bar < range.toTick;) {
    const len = positionAt(project, bar).timeSignature.num * (PPQ * 4) / positionAt(project, bar).timeSignature.den;
    grid.forEach((step, gi) => {
      const at = bar + step * S;
      if (at >= range.toTick || at >= bar + len) return;
      const chord = chordAt(project, at);
      if (!chord) return;
      const root = 28 + (((tonicSemitone(chord.bass ?? chord.root) ?? 0) - 4 + 12) % 12); // E1 부터
      const pcs = chordPitchClasses(chord);
      const fifth = root + (((pcs[2] ?? pcs[1] ?? pcs[0]!) - pcs[0]! + 12) % 12);
      let midi = root;
      if (o.style === 'rootFifth' && gi % 2 === 1) midi = fifth;
      if (o.style === 'octave' && gi % 2 === 1) midi = root + 12;
      if (o.style === 'walking') {
        const next = chordAt(project, at + PPQ);
        const nextRoot = next ? 28 + (((tonicSemitone(next.bass ?? next.root) ?? 0) - 4 + 12) % 12) : root;
        midi = gi === grid.length - 1 && nextRoot !== root ? nextRoot + (nextRoot > root ? -1 : 1) : [root, root + (pcs[1]! - pcs[0]! + 12) % 12, fifth, root + 12][gi % 4]!;
      }
      const lengthTick = (o.rhythm === 'quarters' ? PPQ : S * 2) * (0.85 + r() * 0.1);
      notes.push(createNote({ startTick: at - range.fromTick, lengthTick: Math.round(lengthTick), midi, velocity: gi === 0 ? 0.9 : 0.75 + r() * 0.1 }));
    });
    bar += len;
  }
  return writePart(project, trackId, range, notes, '세션 베이스');
}

export type KeysStyle = 'pad' | 'comp' | 'arp';
export const KEYS_STYLES: Record<KeysStyle, string> = { pad: '길게 깔기', comp: '리듬 반주', arp: '분산화음' };

/**
 * 건반 — 코드를 가운데 도 근처에서 가까운 자리바꿈으로 잇는다(손이 덜 움직이게).
 * 이게 없으면 코드가 바뀔 때마다 덩어리째 위아래로 뛴다.
 */
export function generateKeys(project: Project, trackId: TrackId, range: PlayerRange, o: { style: KeysStyle; seed: number }): Project {
  if ((project.chords ?? []).length === 0) throw new EditError('코드 트랙이 비었다 — 코드를 먼저 놓으세요');
  const r = rng(o.seed);
  const notes: Note[] = [];
  let prev: number[] = [60, 64, 67];
  const voice = (pcs: number[]) => {
    // 각 구성음을 직전 화음 평균에 가장 가까운 옥타브로
    const center = prev.reduce((a, b) => a + b, 0) / prev.length;
    const v = pcs.slice(0, 4).map((pc) => {
      let m = 48 + pc;
      while (m < center - 6) m += 12;
      while (m > center + 6) m -= 12;
      return m;
    }).sort((a, b) => a - b);
    prev = v;
    return v;
  };
  const changes = [...new Set([range.fromTick, ...(project.chords ?? []).map((c) => c.tick).filter((t) => t > range.fromTick && t < range.toTick)])].sort((a, b) => a - b);
  changes.forEach((start, i) => {
    const end = changes[i + 1] ?? range.toTick;
    const chord = chordAt(project, start);
    if (!chord) return;
    const v = voice(chordPitchClasses(chord));
    if (o.style === 'pad') {
      for (const m of v) notes.push(createNote({ startTick: start - range.fromTick, lengthTick: end - start, midi: m, velocity: 0.6 }));
    } else if (o.style === 'comp') {
      for (let t = start; t < end; t += PPQ) {
        const hit = (t - start) % (PPQ * 2) === PPQ ? 0.5 : 0.7;
        for (const m of v) notes.push(createNote({ startTick: t - range.fromTick + (r() < 0.3 ? S : 0), lengthTick: S * 3, midi: m, velocity: hit + r() * 0.08 }));
      }
    } else {
      const order = [...v, v[1]! + 12, v[2]! + 12];
      let k = 0;
      for (let t = start; t < end; t += S * 2, k++) notes.push(createNote({ startTick: t - range.fromTick, lengthTick: S * 2, midi: order[k % order.length]!, velocity: 0.55 + (k % 4 === 0 ? 0.15 : 0) }));
    }
  });
  return writePart(project, trackId, range, notes, '세션 건반');
}

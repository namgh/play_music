/**
 * AI 도우미의 **편집 명령** — 모델은 음을 직접 쓰지 않고 이 목록에서 고른다.
 *
 * 왜 이렇게 하나: 모델이 곡 전체를 다시 써서 돌려주면 무엇이 바뀌었는지 알 수 없고,
 * 한 글자만 틀려도 곡이 깨진다. 명령은 앱에 이미 있는 편집 기능을 부르는 것이라
 * 결과가 예측되고, 적용 전에 사람 말로 보여 줄 수 있고, 되돌리기 한 번으로 돌아간다.
 *
 * 여기는 순수 함수다 — 모델도 화면도 모른다. 받은 명령은 **반드시 `parseAiReply` 로 다시 검사한다**
 * (모델이 준 것이든 서버가 준 것이든 바깥에서 온 자료다).
 */

import type { Clip, Note, NoteId, Project, Track } from '../model/project.ts';
import { createNote } from '../model/factory.ts';
import { positionAt } from '../model/meter.ts';
import { PPQ, ticksToSeconds } from '../model/time.ts';
import { findClip, moveNotes, quantizeNotes, setTempo, setTempoChange } from '../editor/edits.ts';
import { forceLegato, humanize, scaleQuantize, scaleVelocity } from '../editor/noteTools.ts';

export type AiCommand =
  | { type: 'transpose'; semitones: number; snapToKey: boolean }
  | { type: 'tempo'; bpm: number; scope: 'song' | 'range' }
  | { type: 'velocity'; factor: number }
  | { type: 'quantize'; grid: '1/4' | '1/8' | '1/16' | '1/32' }
  | { type: 'humanize'; amount: number }
  | { type: 'length'; factor: number }
  | { type: 'legato' }
  | { type: 'shift'; beats: number }
  | { type: 'replace'; notes: AiNote[] };

/** 모델과 주고받는 음 — 박 단위(클립 시작 = 0), MIDI 번호, 세기 0~1 */
export interface AiNote { beat: number; length: number; midi: number; velocity: number }

export interface AiReply {
  /** 사용자에게 보여 줄 한두 문장 */
  reply: string;
  /** 뜻이 둘 이상이면 되묻는다 — 그때 commands 는 비어 있다 */
  options: string[];
  commands: AiCommand[];
}

/** 무엇을 고친다는 것인가 — 고른 음이 있으면 그것, 없으면 고른 클립의 모든 음 */
export interface AiTarget {
  clipId: Clip['id'];
  noteIds: NoteId[];
  /** 고른 음만인가 (false 면 클립 전체) */
  partial: boolean;
}

export function resolveTarget(project: Project, clipId: Clip['id'] | null, selection: readonly NoteId[]): AiTarget | null {
  if (!clipId) return null;
  const found = findClip(project, clipId);
  if (!found || found.clip.audio) return null;
  const inClip = new Set(found.clip.notes.map((n) => n.id));
  const picked = selection.filter((id) => inClip.has(id));
  if (picked.length > 0) return { clipId, noteIds: picked, partial: picked.length < found.clip.notes.length };
  return { clipId, noteIds: found.clip.notes.map((n) => n.id), partial: false };
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** 화면에 보여 줄 "고른 것" 한 줄 */
export function describeTarget(project: Project, target: AiTarget): string {
  const found = findClip(project, target.clipId);
  if (!found) return '';
  const { track, clip } = found;
  const from = positionAt(project, clip.startTick).bar + 1;
  const to = positionAt(project, Math.max(clip.startTick, clip.startTick + clip.lengthTick - 1)).bar + 1;
  const name = clip.label || '클립';
  return `${name} · ${track.name} · ${target.noteIds.length}음 · ${from === to ? `${from}마디` : `${from}–${to}마디`}`;
}

/** 모델에게 보낼 곡의 맥락. **음표와 코드만** — 녹음한 소리·계정 정보는 들어가지 않는다 */
export function buildContext(project: Project, target: AiTarget): Record<string, unknown> {
  const found = findClip(project, target.clipId)!;
  const { track, clip } = found;
  const ids = new Set(target.noteIds);
  const start = clip.startTick; const end = clip.startTick + clip.lengthTick;
  return {
    song: {
      name: project.name, bpm: project.tempo.bpm,
      meter: `${project.timeSignature.num}/${project.timeSignature.den}`,
      key: project.key ? `${project.key.tonic} ${project.key.mode}` : null,
      bars: project.lengthBars,
      sections: (project.sections ?? []).map((s) => ({ name: s.name, fromBar: positionAt(project, s.startTick).bar + 1, bars: Math.round(s.lengthTick / (PPQ * 4 * project.timeSignature.num / project.timeSignature.den)) })),
    },
    target: {
      track: track.name, instrument: track.instrumentId, clip: clip.label || null,
      fromBar: positionAt(project, start).bar + 1, lengthBeats: round(clip.lengthTick / PPQ),
      scope: target.partial ? 'selected notes only' : 'whole clip',
      chords: (project.chords ?? []).filter((c) => c.tick >= start && c.tick < end)
        .map((c) => ({ beat: round((c.tick - start) / PPQ), chord: `${c.root}${c.quality === 'maj' ? '' : c.quality}${c.bass ? '/' + c.bass : ''}` })),
      notes: clip.notes.filter((n) => ids.has(n.id)).sort((a, b) => a.startTick - b.startTick)
        .map((n): AiNote => ({ beat: round(n.startTick / PPQ), length: round(n.lengthTick / PPQ), midi: n.pitch.midi, velocity: round(n.velocity, 2) })),
    },
    otherTracks: project.tracks.filter((t) => t.id !== track.id).map((t) => ({ name: t.name, instrument: t.instrumentId })),
  };
}

export const AI_SYSTEM = `You are the editing assistant inside RESONA, a music production app. The user has selected part of their song and tells you, in Korean, how to change it. You answer by choosing edit commands that the app will apply to the selected notes. You never output audio and you do not rewrite the song yourself except through the "replace" command.

Commands (apply to the selected notes unless noted):
- transpose: move pitch by semitones (+ up, - down). snapToKey=true keeps the result inside the song's key. "조금 높게" is usually +2 with snapToKey, "한 옥타브" is ±12.
- tempo: set BPM. scope "range" changes only the bars of the selected clip and returns to the old tempo after it; scope "song" changes the whole song. A modest "조금 빠르게" is about +6 to +10 BPM.
- velocity: multiply note loudness (1.15 = a bit stronger, 0.85 = softer).
- quantize: snap note starts to a grid.
- humanize: 0..1, small random timing and loudness changes so it sounds played by a person.
- length: multiply note lengths (0.5 = staccato, 1.5 = longer).
- legato: extend each note to the next one.
- shift: move notes in time by beats (+ later, - earlier).
- replace: replace the selected notes with new ones you write. Use this only when the request cannot be met by the other commands (e.g. "더 펑키하게", "리듬을 바꿔 줘", "새로 지어 줘"). Stay within the clip length, follow the given chords and key, and keep the instrument's range in mind.

Rules:
- Prefer the smallest change that does what was asked. One or two commands is normal.
- If the request has two plausible meanings that lead to different commands (e.g. "더 빠르게" could mean raising the tempo or using shorter, busier notes), do not guess: return no commands and give 2-3 short Korean options the user can pick.
- "reply" is one or two plain Korean sentences saying what will change and why it fits. No markdown.
- If nothing sensible can be done, return no commands and say why in "reply".`;

export function buildUserMessage(context: Record<string, unknown>, request: string): string {
  return `${JSON.stringify(context)}\n\n요청: ${request}`;
}

// ---- 검사 -------------------------------------------------------------------

const GRIDS = ['1/4', '1/8', '1/16', '1/32'] as const;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function parseCommand(raw: unknown): AiCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case 'transpose': return num(c.semitones) && Math.round(c.semitones) !== 0 ? { type: 'transpose', semitones: clamp(Math.round(c.semitones), -36, 36), snapToKey: c.snapToKey === true } : null;
    case 'tempo': return num(c.bpm) ? { type: 'tempo', bpm: clamp(Math.round(c.bpm * 100) / 100, 20, 300), scope: c.scope === 'song' ? 'song' : 'range' } : null;
    case 'velocity': return num(c.factor) && c.factor > 0 ? { type: 'velocity', factor: clamp(c.factor, 0.1, 4) } : null;
    case 'quantize': return GRIDS.includes(c.grid as typeof GRIDS[number]) ? { type: 'quantize', grid: c.grid as typeof GRIDS[number] } : null;
    case 'humanize': return num(c.amount) ? { type: 'humanize', amount: clamp(c.amount, 0, 1) } : null;
    case 'length': return num(c.factor) && c.factor > 0 ? { type: 'length', factor: clamp(c.factor, 0.05, 8) } : null;
    case 'legato': return { type: 'legato' };
    case 'shift': return num(c.beats) && c.beats !== 0 ? { type: 'shift', beats: clamp(c.beats, -64, 64) } : null;
    case 'replace': {
      if (!Array.isArray(c.notes)) return null;
      const notes = c.notes.slice(0, 2000).flatMap((n): AiNote[] => {
        const x = n as Record<string, unknown> | null;
        if (!x || !num(x.beat) || !num(x.length) || !num(x.midi) || x.beat < 0 || x.length <= 0) return [];
        return [{ beat: x.beat, length: x.length, midi: clamp(Math.round(x.midi), 0, 127), velocity: num(x.velocity) ? clamp(x.velocity, 0.05, 1) : 0.8 }];
      });
      return notes.length > 0 ? { type: 'replace', notes } : null;
    }
    default: return null;
  }
}

/** 바깥에서 온 답을 우리 형식으로. 모르는 명령·이상한 값은 버린다 (던지지 않는다 — 버린 수를 돌려준다) */
export function parseAiReply(raw: unknown): AiReply & { dropped: number } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.commands) ? r.commands : [];
  const commands = list.map(parseCommand).filter((c): c is AiCommand => c !== null).slice(0, 8);
  return {
    reply: typeof r.reply === 'string' ? r.reply.slice(0, 600) : '',
    options: Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).map((o) => o.slice(0, 60)).slice(0, 4) : [],
    commands,
    dropped: list.length - commands.length,
  };
}

// ---- 사람 말로 ---------------------------------------------------------------

/** 적용 전에 보여 줄 한 줄 — `big` 은 크게 찍을 값 */
export function describeCommand(c: AiCommand, project: Project): { big: string; text: string } {
  switch (c.type) {
    case 'transpose': return { big: `${c.semitones > 0 ? '+' : '−'}${Math.abs(c.semitones)} 반음`, text: Math.abs(c.semitones) % 12 === 0 ? `${Math.abs(c.semitones) / 12}옥타브 ${c.semitones > 0 ? '위로' : '아래로'}` : c.snapToKey && project.key ? '조에 맞게 옮깁니다' : '그대로 옮깁니다' };
    case 'tempo': return { big: `${project.tempo.bpm} → ${c.bpm}`, text: c.scope === 'song' ? '곡 전체 템포' : '이 구간만 템포를 바꾸고 끝나면 돌아옵니다' };
    case 'velocity': return { big: `세기 ×${round(c.factor, 2)}`, text: c.factor > 1 ? '더 세게' : '더 여리게' };
    case 'quantize': return { big: c.grid, text: '박자를 격자에 맞춥니다' };
    case 'humanize': return { big: `${Math.round(c.amount * 100)}%`, text: '사람이 친 것처럼 조금 흔듭니다' };
    case 'length': return { big: `길이 ×${round(c.factor, 2)}`, text: c.factor < 1 ? '음을 짧게 끊습니다' : '음을 길게 잇습니다' };
    case 'legato': return { big: '레가토', text: '다음 음까지 이어 줍니다' };
    case 'shift': return { big: `${c.beats > 0 ? '+' : '−'}${round(Math.abs(c.beats), 2)}박`, text: c.beats > 0 ? '뒤로 밉니다' : '앞으로 당깁니다' };
    case 'replace': return { big: `${c.notes.length}음`, text: '고른 음을 새로 쓴 음으로 바꿉니다' };
  }
}

// ---- 적용 -------------------------------------------------------------------

const GRID_TICKS: Record<typeof GRIDS[number], number> = { '1/4': PPQ, '1/8': PPQ / 2, '1/16': PPQ / 4, '1/32': PPQ / 8 };

function mapTargetNotes(project: Project, target: AiTarget, fn: (note: Note, clip: Clip) => Note): Project {
  const ids = new Set(target.noteIds);
  return {
    ...project,
    tracks: project.tracks.map((t): Track => (t.clips.some((c) => c.id === target.clipId)
      ? { ...t, clips: t.clips.map((c) => (c.id === target.clipId ? { ...c, notes: c.notes.map((n) => (ids.has(n.id) ? fn(n, c) : n)) } : c)) }
      : t)),
  };
}

/**
 * 명령들을 차례로 적용한 새 곡과, 그 뒤에 고쳐진 대상(replace 는 음 id 가 바뀐다)을 돌려준다.
 * 원래 곡은 건드리지 않는다 — 호출한 쪽이 한 번에 commit 하면 되돌리기도 한 번이다.
 */
export function applyAiCommands(project: Project, target: AiTarget, commands: readonly AiCommand[], seed = 1): { project: Project; target: AiTarget } {
  let p = project; let t = target;
  for (const c of commands) {
    const found = findClip(p, t.clipId);
    if (!found) break;
    const { clip } = found;
    switch (c.type) {
      case 'transpose':
        p = moveNotes(p, t.noteIds, { semitones: c.semitones });
        if (c.snapToKey && p.key) p = scaleQuantize(p, t.noteIds, p.key);
        break;
      case 'tempo':
        if (c.scope === 'song' || (clip.startTick === 0 && clip.startTick + clip.lengthTick >= ticksEnd(p))) p = setTempo(p, c.bpm);
        else {
          // 구간이 끝나면 **그 자리의 원래 템포**로 돌아온다 — 먼저 재 두고, 그다음에 바꾼다
          const end = clip.startTick + clip.lengthTick;
          const after = bpmJustAt(p, end);
          p = setTempoChange(p, clip.startTick, c.bpm);
          if (end < ticksEnd(p)) p = setTempoChange(p, end, after);
        }
        break;
      case 'velocity': p = scaleVelocity(p, t.noteIds, c.factor); break;
      case 'quantize': p = quantizeNotes(p, t.noteIds, GRID_TICKS[c.grid]); break;
      case 'humanize': p = humanize(p, t.noteIds, { timingTicks: Math.round(c.amount * PPQ / 16), velocity: c.amount * 0.15, seed }); break;
      case 'length': p = mapTargetNotes(p, t, (n) => ({ ...n, lengthTick: Math.max(PPQ / 32, Math.round(n.lengthTick * c.factor)) })); break;
      case 'legato': p = forceLegato(p, t.noteIds); break;
      case 'shift': {
        const d = Math.round(c.beats * PPQ);
        p = mapTargetNotes(p, t, (n, cl) => ({ ...n, startTick: Math.min(Math.max(0, cl.lengthTick - 1), Math.max(0, n.startTick + d)) }));
        break;
      }
      case 'replace': {
        const ids = new Set(t.noteIds);
        const fresh = c.notes
          .map((n) => ({ ...n, start: Math.round(n.beat * PPQ) }))
          .filter((n) => n.start < clip.lengthTick)
          .map((n) => ({ ...createNote({ startTick: n.start, lengthTick: Math.max(PPQ / 32, Math.min(Math.round(n.length * PPQ), clip.lengthTick - n.start)), midi: n.midi, velocity: n.velocity, origin: 'ai' }) }));
        p = { ...p, tracks: p.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((cl) => (cl.id === t.clipId ? { ...cl, notes: [...cl.notes.filter((n) => !ids.has(n.id)), ...fresh].sort((a, b) => a.startTick - b.startTick) } : cl)) })) };
        t = { ...t, noteIds: fresh.map((n) => n.id) };
        break;
      }
    }
  }
  return { project: p, target: t };
}

function ticksEnd(project: Project): number {
  return project.tracks.reduce((m, t) => t.clips.reduce((k, c) => Math.max(k, c.startTick + c.lengthTick), m), 0);
}

/** 그 틱에서 울리는 템포 (계단 변화 기준 — 그 틱의 변화 지점을 포함한다) */
function bpmJustAt(project: Project, tick: number): number {
  let bpm = project.tempo.bpm;
  for (const c of [...(project.tempo.changes ?? [])].sort((a, b) => a.tick - b.tick)) if (c.tick <= tick) bpm = c.bpm;
  return bpm;
}

/** 대상 구간이 곡의 몇 초부터 몇 초인가 — 미리 듣기가 그 자리만 튼다 */
export function targetSeconds(project: Project, target: AiTarget): { from: number; to: number } | null {
  const found = findClip(project, target.clipId);
  if (!found) return null;
  return { from: ticksToSeconds(found.clip.startTick, project.tempo), to: ticksToSeconds(found.clip.startTick + found.clip.lengthTick, project.tempo) };
}

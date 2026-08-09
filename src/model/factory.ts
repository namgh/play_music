/**
 * 프로젝트 데이터 생성기. ID 발급이 여기 한 곳에만 있어야 한다 —
 * ID 규칙이 흩어지면 언두·AI 지시("이 음을 A→B로")가 대상을 잃는다.
 */

import { DEFAULT_TEMPO, DEFAULT_TIME_SIGNATURE, PPQ, ticksPerBar } from './time.ts';
import { DEFAULT_TUNING, pitch } from './pitch.ts';
import { SCHEMA_VERSION } from './project.ts';
import type {
  Clip, ClipId, Note, NoteId, Origin, Project, ProjectId, Track, TrackId,
} from './project.ts';

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

export const newProjectId = (): ProjectId => `prj_${randomId()}`;
export const newTrackId = (): TrackId => `trk_${randomId()}`;
export const newClipId = (): ClipId => `clp_${randomId()}`;
export const newNoteId = (): NoteId => `not_${randomId()}`;

export function createNote(opts: {
  startTick: number;
  lengthTick?: number;
  midi: number;
  cents?: number;
  velocity?: number;
  origin?: Origin;
}): Note {
  return {
    id: newNoteId(),
    startTick: opts.startTick,
    lengthTick: opts.lengthTick ?? PPQ,
    pitch: pitch(opts.midi, opts.cents ?? 0),
    velocity: opts.velocity ?? 0.8,
    pitchCurve: null,
    expression: null,
    origin: opts.origin ?? 'user',
  };
}

export function createClip(opts: {
  startTick: number;
  lengthTick: number;
  label?: string;
  origin?: Origin;
  notes?: Note[];
}): Clip {
  return {
    id: newClipId(),
    startTick: opts.startTick,
    lengthTick: opts.lengthTick,
    label: opts.label ?? '',
    origin: opts.origin ?? 'user',
    locked: false,
    notes: opts.notes ?? [],
  };
}

export function createTrack(opts: {
  name: string;
  instrumentId: string;
  toneId?: string;
  color?: string;
}): Track {
  return {
    id: newTrackId(),
    name: opts.name,
    instrumentId: opts.instrumentId,
    toneId: opts.toneId ?? 'default',
    toneParams: null,
    gain: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    color: opts.color ?? 'j1',
    effects: [],
    clips: [],
  };
}

/**
 * 빈 프로젝트. 트랙이 0개인 상태로 시작한다 —
 * 무엇을 만들지 모르는 채로 트랙을 미리 꽂아 두면 지우는 일부터 시켜야 한다.
 */
export function createEmptyProject(name: string): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newProjectId(),
    name,
    tempo: { ...DEFAULT_TEMPO },
    timeSignature: { ...DEFAULT_TIME_SIGNATURE },
    key: null,
    tuning: { ...DEFAULT_TUNING },
    loop: null,
    lengthBars: 16,
    tracks: [],
    master: { gain: 1, effects: [] },
  };
}

/** 프로젝트 전체 길이(틱) */
export function projectLengthTicks(project: Project): number {
  return project.lengthBars * ticksPerBar(project.timeSignature);
}

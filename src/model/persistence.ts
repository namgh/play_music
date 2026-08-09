/**
 * 프로젝트 저장·불러오기.
 *
 * 프로젝트 데이터가 순수 직렬화 가능한 값만 담는다는 규칙(`plan.md` 5-4)의 두 번째
 * 배당금이다 — `JSON.stringify` 가 그냥 된다.
 *
 * **불러오기는 방어적으로 한다.** 남이 만든 파일, 예전 버전, 손으로 고친 파일이
 * 들어온다. 반쯤 깨진 프로젝트를 조용히 만들면 사용자는 원인을 찾을 수 없다.
 *
 * 스키마 버전은 `sound.md` 9-8: 필드 추가는 자유, 제거·개명은 마이그레이션 함수를
 * 반드시 동반한다. Phase 3 에서 AI 가 이 스키마로 파라미터를 생성하므로 요구가 더 높다.
 */

import { SCHEMA_VERSION } from './project.ts';
import type {
  Clip, ClipId, EffectSpec, LoopRegion, MusicalKey, Note, NoteId, Origin, PitchCurve, Project,
  ProjectId, Track, TrackId,
} from './project.ts';
import { DEFAULT_TEMPO, DEFAULT_TIME_SIGNATURE, PPQ } from './time.ts';
import { DEFAULT_TUNING, normalizePitch } from './pitch.ts';

export class ProjectLoadError extends Error {}

/** 마이그레이션: `from` 버전 데이터를 `from+1` 버전으로 올린다 */
type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * 버전별 마이그레이션. 키는 **올라가기 전** 버전이다.
 *
 * 지금은 v1 이 최신이라 비어 있다. 스키마를 바꿀 때 여기에 함수를 추가하지 않으면
 * `deserializeProject` 가 명시적으로 실패한다 — 조용히 깨진 프로젝트를 만들지 않는다.
 */
const MIGRATIONS: Record<number, Migration> = {};

// ---------------------------------------------------------------------------
// 직렬화
// ---------------------------------------------------------------------------

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

// ---------------------------------------------------------------------------
// 검증 도우미 — 값이 없거나 이상하면 기본값으로 채우되, 구조가 틀리면 실패한다
// ---------------------------------------------------------------------------

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectLoadError(`${what} 가 객체가 아니다`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new ProjectLoadError(`${what} 가 배열이 아니다`);
  return value;
}

function num(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function origin(value: unknown): Origin {
  return value === 'ai' ? 'ai' : 'user';
}

/** id 가 없거나 형식이 틀리면 새로 발급한다 — id 없이는 편집·언두가 대상을 잃는다 */
function id<T extends string>(value: unknown, prefix: string, seen: Set<string>): T {
  let candidate = typeof value === 'string' && value.startsWith(`${prefix}_`) ? value : '';
  if (candidate === '' || seen.has(candidate)) {
    candidate = `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
  }
  seen.add(candidate);
  return candidate as T;
}

/** MIDI 범위로 자른다. 센트 미세조정은 유지한다 */
function clampMidi(pitch: { midi: number; cents: number }): { midi: number; cents: number } {
  return { midi: Math.min(127, Math.max(0, pitch.midi)), cents: pitch.cents };
}

function parsePitchCurve(value: unknown): PitchCurve | null {
  if (value === null || value === undefined) return null;
  const raw = asRecord(value, '음정 곡선');

  const glideRaw = raw.glide;
  const glide = glideRaw == null
    ? null
    : {
        cents: num(asRecord(glideRaw, '글라이드').cents, 0, -1200, 1200),
        ms: num(asRecord(glideRaw, '글라이드').ms, 80, 0, 10000),
      };

  const vibratoRaw = raw.vibrato;
  const vibrato = vibratoRaw == null
    ? null
    : {
        cents: num(asRecord(vibratoRaw, '비브라토').cents, 0, 0, 1200),
        hz: num(asRecord(vibratoRaw, '비브라토').hz, 5, 0, 40),
        delayMs: num(asRecord(vibratoRaw, '비브라토').delayMs, 0, 0, 10000),
      };

  const pointsRaw = raw.points;
  const points = pointsRaw == null
    ? null
    : asArray(pointsRaw, '곡선 점').map((point) => {
        const p = asRecord(point, '곡선 점');
        return { tNorm: num(p.tNorm, 0, 0, 1), cents: num(p.cents, 0, -1200, 1200) };
      });

  if (glide === null && vibrato === null && points === null) return null;
  return { glide, vibrato, points };
}

function parseEffects(value: unknown): EffectSpec[] {
  if (value == null) return [];
  return asArray(value, '이펙트').map((entry) => {
    const raw = asRecord(entry, '이펙트');
    const params: Record<string, number | string | boolean> = {};
    for (const [key, param] of Object.entries(asRecord(raw.params ?? {}, '이펙트 파라미터'))) {
      if (typeof param === 'number' || typeof param === 'string' || typeof param === 'boolean') {
        params[key] = param;
      }
    }
    return {
      type: str(raw.type, 'unknown'),
      bypass: bool(raw.bypass, false),
      params,
    };
  });
}

function parseNote(value: unknown, seen: Set<string>): Note {
  const raw = asRecord(value, '음');
  const pitchRaw = asRecord(raw.pitch ?? {}, '음정');
  return {
    id: id<NoteId>(raw.id, 'not', seen),
    startTick: num(raw.startTick, 0, 0),
    lengthTick: num(raw.lengthTick, PPQ, 1),
    // **정규화를 먼저, 자르는 것을 나중에.** 센트를 정규화하면 반음 경계를 넘어
    // midi 가 올라가므로, 자른 뒤에 정규화하면 다시 범위를 벗어난다
    pitch: clampMidi(normalizePitch({
      midi: Math.round(num(pitchRaw.midi, 60, -200, 400)),
      cents: num(pitchRaw.cents, 0, -4800, 4800),
    })),
    velocity: num(raw.velocity, 0.8, 0, 1),
    pitchCurve: parsePitchCurve(raw.pitchCurve),
    expression: raw.expression == null ? null : (raw.expression as Note['expression']),
    origin: origin(raw.origin),
  };
}

function parseClip(value: unknown, seen: Set<string>): Clip {
  const raw = asRecord(value, '클립');
  return {
    id: id<ClipId>(raw.id, 'clp', seen),
    startTick: num(raw.startTick, 0, 0),
    lengthTick: num(raw.lengthTick, 4 * PPQ, 1),
    label: str(raw.label, ''),
    origin: origin(raw.origin),
    locked: bool(raw.locked, false),
    notes: asArray(raw.notes ?? [], '음 목록').map((note) => parseNote(note, seen)),
  };
}

function parseTrack(value: unknown, seen: Set<string>): Track {
  const raw = asRecord(value, '트랙');
  const toneParamsRaw = raw.toneParams;
  let toneParams: Track['toneParams'] = null;
  if (toneParamsRaw != null) {
    toneParams = {};
    for (const [key, param] of Object.entries(asRecord(toneParamsRaw, '음색 파라미터'))) {
      if (typeof param === 'number' || typeof param === 'string') toneParams[key] = param;
    }
  }

  return {
    id: id<TrackId>(raw.id, 'trk', seen),
    name: str(raw.name, '트랙'),
    instrumentId: str(raw.instrumentId, 'acoustic-guitar'),
    toneId: str(raw.toneId, 'default'),
    toneParams,
    gain: num(raw.gain, 0.8, 0, 1),
    pan: num(raw.pan, 0, -1, 1),
    mute: bool(raw.mute, false),
    solo: bool(raw.solo, false),
    color: str(raw.color, 'j1'),
    effects: parseEffects(raw.effects),
    clips: asArray(raw.clips ?? [], '클립 목록').map((clip) => parseClip(clip, seen)),
  };
}

function parseKey(value: unknown): MusicalKey | null {
  if (value == null) return null;
  const raw = asRecord(value, '조성');
  return {
    tonic: str(raw.tonic, 'C'),
    mode: raw.mode === 'minor' ? 'minor' : 'major',
  };
}

/**
 * 루프 구간. **필드 추가라 마이그레이션이 필요 없다** (`sound.md` 9-8) —
 * 예전 파일에는 이 키가 없고 그러면 `null` 이 된다.
 *
 * `end <= start` 인 구간은 버린다. 그대로 두면 스케줄러가 길이 0 구간을 무한 반복해
 * **재생이 멈춘 것처럼 보인다.**
 */
function parseLoop(value: unknown): LoopRegion | null {
  if (value == null) return null;
  const raw = asRecord(value, '루프 구간');
  const startTick = num(raw.startTick, 0, 0);
  const endTick = num(raw.endTick, 0, 0);
  if (!(endTick > startTick)) return null;
  return { startTick, endTick, enabled: bool(raw.enabled, false) };
}

// ---------------------------------------------------------------------------
// 불러오기
// ---------------------------------------------------------------------------

/** 마이그레이션을 적용해 최신 스키마로 올린다 */
export function migrate(data: Record<string, unknown>): Record<string, unknown> {
  let current = data;
  let version = Math.round(num(current.schemaVersion, 0));

  if (version > SCHEMA_VERSION) {
    throw new ProjectLoadError(
      `더 새로운 버전의 프로젝트다 (파일 v${version}, 이 앱 v${SCHEMA_VERSION}) — 앱을 업데이트하세요`,
    );
  }

  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new ProjectLoadError(
        `v${version} → v${version + 1} 마이그레이션이 없다 — 스키마를 바꿀 때 함께 추가해야 한다 (sound.md 9-8)`,
      );
    }
    current = step(current);
    version += 1;
    current.schemaVersion = version;
  }

  return current;
}

export function deserializeProject(text: string): Project {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProjectLoadError(`JSON 이 아니다: ${err instanceof Error ? err.message : String(err)}`);
  }

  const raw = migrate(asRecord(parsed, '프로젝트'));
  const seen = new Set<string>();

  const tsRaw = asRecord(raw.timeSignature ?? {}, '박자');
  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: id<ProjectId>(raw.id, 'prj', seen),
    name: str(raw.name, '이름 없는 프로젝트'),
    tempo: { bpm: num(asRecord(raw.tempo ?? {}, '템포').bpm, DEFAULT_TEMPO.bpm, 20, 300) },
    timeSignature: {
      num: Math.round(num(tsRaw.num, DEFAULT_TIME_SIGNATURE.num, 1, 32)),
      den: Math.round(num(tsRaw.den, DEFAULT_TIME_SIGNATURE.den, 1, 32)),
    },
    key: parseKey(raw.key),
    tuning: { a4Hz: num(asRecord(raw.tuning ?? {}, '조율').a4Hz, DEFAULT_TUNING.a4Hz, 380, 500) },
    loop: parseLoop(raw.loop),
    lengthBars: Math.round(num(raw.lengthBars, 16, 1, 2000)),
    tracks: asArray(raw.tracks ?? [], '트랙 목록').map((track) => parseTrack(track, seen)),
    master: {
      gain: num(asRecord(raw.master ?? {}, '마스터').gain, 1, 0, 2),
      effects: parseEffects(asRecord(raw.master ?? {}, '마스터').effects),
    },
  };

  return project;
}

/** 저장·불러오기 왕복이 손실 없는지 확인하는 용도 (테스트·디버깅) */
export function roundTrip(project: Project): Project {
  return deserializeProject(serializeProject(project));
}

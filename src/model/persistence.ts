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

import { CHORD_QUALITIES, SCHEMA_VERSION } from './project.ts';
import type {
  AutomationLane, AutomationMode, AutomationPoint, AutomationTarget, ChordId, ChordQuality, Clip, ClipId, EffectSpec, LoopRegion,
  MarkerId, MusicalKey, Note, NoteId, Origin, PitchCurve, Project, ProjectId, SectionId, StackId, Track, TrackId, BusId, VcaId, GroupId, MidiEffect,
} from './project.ts';
import { normalizeSignatureChanges } from './meter.ts';
import { DEFAULT_TEMPO, DEFAULT_TIME_SIGNATURE, PPQ } from './time.ts';
import type { TimeSignature } from './time.ts';
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
      ...(typeof raw.sidechain === 'string' && raw.sidechain.startsWith('trk_') ? { sidechain: raw.sidechain as TrackId } : {}),
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
    ...(raw.muted == null ? {} : { muted: bool(raw.muted, false) }),
    ...(typeof raw.aliasOf === 'string' && raw.aliasOf.startsWith('clp_') ? { aliasOf: raw.aliasOf as ClipId } : {}),
    ...(raw.color == null ? {} : { color: str(raw.color, 'j1') }),
    notes: asArray(raw.notes ?? [], '음 목록').map((note) => parseNote(note, seen)),
    ...(raw.audio == null ? {} : (() => {
      const a = asRecord(raw.audio, '오디오 리전');
      return {
        audio: {
          assetId: str(a.assetId, ''), name: str(a.name, '오디오'), assetSec: num(a.assetSec, 0, 0),
          offsetSec: num(a.offsetSec, 0, 0), gainDb: num(a.gainDb, 0, -60, 24),
          fadeInSec: num(a.fadeInSec, 0, 0), fadeOutSec: num(a.fadeOutSec, 0, 0), reverse: bool(a.reverse, false),
        },
      };
    })()),
    ...(raw.takes == null ? {} : {
      takes: asArray(raw.takes, '테이크').map((entry) => {
        const t = asRecord(entry, '테이크');
        // 테이크 안의 음은 클립 음과 id 가 겹칠 수 있다(자리를 바꾸므로) — 따로 센다
        const own = new Set<string>();
        return { id: str(t.id, 'tk'), name: str(t.name, '테이크'), notes: asArray(t.notes ?? [], '테이크 음').map((n) => parseNote(n, own)) };
      }),
    }),
  };
}

function parseAutomationPoint(value: unknown): AutomationPoint {
  const raw = asRecord(value, '오토메이션 점');
  return {
    tick: num(raw.tick, 0, 0),
    value: num(raw.value, 1, 0, 1),
  };
}

function parseAutomation(value: unknown): AutomationLane[] {
  if (value == null) return [];
  return asArray(value, '오토메이션').flatMap((entry) => {
    const raw = asRecord(entry, '오토메이션 레인');
    // 모르는 대상은 **버린다** — 예전에는 volume 으로 떨어뜨렸는데, 팬 곡선이
    // 볼륨으로 읽히면 소리가 끊기는 엉뚱한 곡이 된다
    const target = raw.target ?? 'volume';
    if (typeof target !== 'string' || !isAutomationTarget(target)) return [];
    return [{
      target,
      points: asArray(raw.points ?? [], '오토메이션 점 목록')
        .map((point) => parseAutomationPoint(point))
        .sort((a, b) => a.tick - b.tick),
    }];
  });
}

export function isAutomationTarget(value: string): value is AutomationTarget {
  return value === 'volume' || value === 'pan' || /^fx:\d+:[A-Za-z0-9]+$/.test(value) || /^inst:[A-Za-z0-9]+$/.test(value);
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
    automation: parseAutomation(raw.automation),
    clips: asArray(raw.clips ?? [], '클립 목록').map((clip) => parseClip(clip, seen)),
    ...(['read', 'touch', 'latch', 'write', 'trim'].includes(String(raw.automationMode))
      ? { automationMode: raw.automationMode as AutomationMode } : {}),
    ...(raw.kind === 'audio' ? { kind: 'audio' as const } : {}),
    ...(raw.hidden == null ? {} : { hidden: bool(raw.hidden, false) }),
    ...(raw.locked == null ? {} : { locked: bool(raw.locked, false) }),
    ...(typeof raw.stackId === 'string' && raw.stackId.startsWith('stk_') ? { stackId: raw.stackId as StackId } : {}),
    ...(typeof raw.freezeOf === 'string' && raw.freezeOf.startsWith('trk_') ? { freezeOf: raw.freezeOf as TrackId } : {}),
    ...(raw.frozen && typeof raw.frozen === 'object' && typeof (raw.frozen as { audioTrackId?: unknown }).audioTrackId === 'string' ? {
      frozen: {
        audioTrackId: (raw.frozen as { audioTrackId: string }).audioTrackId as TrackId,
        wasMuted: (raw.frozen as { wasMuted?: unknown }).wasMuted === true,
        wasLocked: (raw.frozen as { wasLocked?: unknown }).wasLocked === true,
      },
    } : {}),
    ...(typeof raw.output === 'string' && raw.output.startsWith('bus_') ? { output: raw.output as BusId } : {}),
    ...(raw.sends == null ? {} : {
      sends: asArray(raw.sends, '센드').flatMap((entry) => {
        const send = asRecord(entry, '센드');
        return typeof send.busId === 'string' && send.busId.startsWith('bus_')
          ? [{ busId: send.busId as BusId, level: num(send.level, 0.5, 0, 1), ...(send.pre === true ? { pre: true as const } : {}) }] : [];
      }),
    }),
    ...(typeof raw.vcaId === 'string' && raw.vcaId.startsWith('vca_') ? { vcaId: raw.vcaId as VcaId } : {}),
    ...(typeof raw.groupId === 'string' && raw.groupId.startsWith('grp_') ? { groupId: raw.groupId as GroupId } : {}),
    // MIDI 이펙트는 모양만 확인하고 그대로 싣는다 — 종류를 모르면 버린다
    ...(Array.isArray(raw.midiEffects) ? {
      midiEffects: (raw.midiEffects as unknown[]).filter((fx): fx is MidiEffect => !!fx && typeof fx === 'object'
        && ['arpeggiator', 'chordTrigger', 'transposer', 'velocity', 'noteRepeater', 'scaleQuantizer', 'randomizer'].includes(String((fx as { type?: unknown }).type))),
    } : {}),
    ...(Array.isArray(raw.smartControls) ? { smartControls: (raw.smartControls as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
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

/**
 * 템포와 템포 변화.
 *
 * **예전에는 `bpm` 만 읽어서 템포 변화가 저장·새로고침에서 사라졌다** (스윙도 같았다
 * — 2026-11-17 발견). 변화는 틱 오름차순, 같은 틱은 마지막 것.
 */
function parseTempo(value: unknown): Project['tempo'] {
  const raw = asRecord(value ?? {}, '템포');
  const tempo: Project['tempo'] = { bpm: num(raw.bpm, DEFAULT_TEMPO.bpm, 20, 300) };
  if (raw.changes != null) {
    const byTick = new Map<number, number>();
    for (const entry of asArray(raw.changes, '템포 변화')) {
      const change = asRecord(entry, '템포 변화');
      byTick.set(num(change.tick, 0, 0), num(change.bpm, tempo.bpm, 20, 300));
    }
    tempo.changes = [...byTick.entries()].sort((a, b) => a[0] - b[0]).map(([tick, bpm]) => ({ tick, bpm }));
  }
  return tempo;
}

function parseTimeSignature(value: unknown, what: string): TimeSignature {
  const raw = asRecord(value ?? {}, what);
  return {
    num: Math.round(num(raw.num, DEFAULT_TIME_SIGNATURE.num, 1, 32)),
    den: Math.round(num(raw.den, DEFAULT_TIME_SIGNATURE.den, 1, 32)),
  };
}

/** 글로벌 트랙 필드 — 있을 때만 싣는다. 없는 키를 `[]` 로 만들면 옛 파일과 왕복이 안 맞는다 */
function optionalGlobals(raw: Record<string, unknown>, seen: Set<string>): Partial<Project> {
  const out: Partial<Project> = {};
  if (raw.markers != null) {
    out.markers = asArray(raw.markers, '마커').map((entry) => {
      const m = asRecord(entry, '마커');
      return { id: id<MarkerId>(m.id, 'mrk', seen), tick: num(m.tick, 0, 0), name: str(m.name, '마커') };
    }).sort((a, b) => a.tick - b.tick);
  }
  if (raw.sections != null) {
    out.sections = asArray(raw.sections, '편곡 마커').map((entry) => {
      const m = asRecord(entry, '편곡 마커');
      return {
        id: id<SectionId>(m.id, 'sec', seen),
        startTick: num(m.startTick, 0, 0),
        lengthTick: num(m.lengthTick, 4 * PPQ, 1),
        name: str(m.name, '구간'),
      };
    }).sort((a, b) => a.startTick - b.startTick);
  }
  if (raw.chords != null) {
    out.chords = asArray(raw.chords, '코드').map((entry) => {
      const c = asRecord(entry, '코드');
      return {
        id: id<ChordId>(c.id, 'chd', seen),
        tick: num(c.tick, 0, 0),
        root: str(c.root, 'C'),
        quality: (CHORD_QUALITIES as readonly string[]).includes(String(c.quality))
          ? c.quality as ChordQuality
          : 'maj',
        bass: c.bass == null ? null : str(c.bass, 'C'),
      };
    }).sort((a, b) => a.tick - b.tick);
  }
  if (raw.signatureChanges != null) {
    out.signatureChanges = normalizeSignatureChanges(asArray(raw.signatureChanges, '박자 변화').map((entry) => {
      const c = asRecord(entry, '박자 변화');
      return { bar: Math.round(num(c.bar, 1, 1)), timeSignature: parseTimeSignature(c.timeSignature, '박자') };
    }));
  }
  if (raw.video != null) {
    const v = asRecord(raw.video, '영상');
    if (typeof v.assetId === 'string' && v.assetId) {
      out.video = { assetId: v.assetId, name: str(v.name, '영상'), durationSec: num(v.durationSec, 0, 0), offsetSec: num(v.offsetSec, 0, -3600, 3600) };
    }
  }
  if (raw.liveScenes != null) {
    out.liveScenes = asArray(raw.liveScenes, '라이브 루프').map((entry) => {
      const sc = asRecord(entry, '장면');
      return {
        id: str(sc.id, 'scn'),
        name: str(sc.name, '장면'),
        cells: asArray(sc.cells ?? [], '칸').flatMap((c) => {
          const cell = asRecord(c, '칸');
          if (typeof cell.trackId !== 'string' || !cell.trackId.startsWith('trk_')) return [];
          // 칸의 음은 클립 음과 id 가 따로다 — 따로 센다
          const own = new Set<string>();
          return [{ trackId: cell.trackId as TrackId, lengthTick: num(cell.lengthTick, 4 * PPQ, 1), notes: asArray(cell.notes ?? [], '칸 음').map((n) => parseNote(n, own)) }];
        }),
      };
    });
  }
  if (raw.buses != null) {
    out.buses = asArray(raw.buses, '버스').map((entry) => {
      const b = asRecord(entry, '버스');
      return {
        id: id<BusId>(b.id, 'bus', seen), name: str(b.name, '버스'), gain: num(b.gain, 1, 0, 1.5),
        pan: num(b.pan, 0, -1, 1), mute: bool(b.mute, false), effects: parseEffects(b.effects),
      };
    });
  }
  if (raw.vcas != null) {
    out.vcas = asArray(raw.vcas, 'VCA').map((entry) => {
      const v = asRecord(entry, 'VCA');
      return { id: id<VcaId>(v.id, 'vca', seen), name: str(v.name, 'VCA'), gain: num(v.gain, 1, 0, 1.5), mute: bool(v.mute, false) };
    });
  }
  if (raw.groups != null) {
    out.groups = asArray(raw.groups, '그룹').map((entry) => {
      const g = asRecord(entry, '그룹');
      return { id: id<GroupId>(g.id, 'grp', seen), name: str(g.name, '그룹') };
    });
  }
  if (raw.stacks != null) {
    out.stacks = asArray(raw.stacks, '트랙 스택').map((entry) => {
      const st = asRecord(entry, '트랙 스택');
      return { id: id<StackId>(st.id, 'stk', seen), name: str(st.name, '스택'), collapsed: bool(st.collapsed, false) };
    });
  }
  if (raw.keyChanges != null) {
    out.keyChanges = asArray(raw.keyChanges, '조성 변화').flatMap((entry) => {
      const c = asRecord(entry, '조성 변화');
      const key = parseKey(c.key);
      return key ? [{ tick: num(c.tick, 0, 0), key }] : [];
    }).sort((a, b) => a.tick - b.tick);
  }
  return out;
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

  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: id<ProjectId>(raw.id, 'prj', seen),
    name: str(raw.name, '이름 없는 프로젝트'),
    tempo: parseTempo(raw.tempo),
    timeSignature: parseTimeSignature(raw.timeSignature, '박자'),
    key: parseKey(raw.key),
    tuning: { a4Hz: num(asRecord(raw.tuning ?? {}, '조율').a4Hz, DEFAULT_TUNING.a4Hz, 380, 500) },
    loop: parseLoop(raw.loop),
    lengthBars: Math.round(num(raw.lengthBars, 16, 1, 2000)),
    ...optionalGlobals(raw, seen),
    tracks: asArray(raw.tracks ?? [], '트랙 목록').map((track) => parseTrack(track, seen)),
    master: {
      gain: num(asRecord(raw.master ?? {}, '마스터').gain, 1, 0, 2),
      effects: parseEffects(asRecord(raw.master ?? {}, '마스터').effects),
    },
  };
  if (raw.swing != null) project.swing = num(raw.swing, 0, 0, 0.75);

  return project;
}

/** 저장·불러오기 왕복이 손실 없는지 확인하는 용도 (테스트·디버깅) */
export function roundTrip(project: Project): Project {
  return deserializeProject(serializeProject(project));
}

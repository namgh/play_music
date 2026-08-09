/**
 * 프로젝트 데이터 — `plan.md` 5-4 의 TypeScript 구현.
 *
 * **절대 규칙: 이 파일에는 오디오 타입이 들어오지 않는다.**
 * `AudioBuffer`, `AudioNode`, 함수, 클래스 인스턴스 금지. 순수 직렬화 가능한 값만.
 * 이 데이터만 있으면 렌더러가 소리를 재현할 수 있어야 한다
 * (미리듣기 = 내보내기 = 공유본이 100% 일치해야 하므로).
 *
 * 렌더러 교체 가능성이 여기 걸려 있다 — 앱 곳곳에 `audioContext.createGain()` 같은
 * 호출이 흩어지면 렌더러 교체가 영원히 불가능해진다 (`plan.md` 5-2).
 */

import type { Tempo, Ticks, TimeSignature } from './time.ts';
import type { MusicalKey, Pitch, Tuning } from './pitch.ts';

// 조성은 음악 이론 개념이라 `pitch.ts` 가 소유한다 (스케일 판정이 거기 있다).
// 프로젝트 스키마의 일부이므로 여기서 재수출해 기존 import 를 그대로 둔다
export type { MusicalKey };

// ---------------------------------------------------------------------------
// ID — 안정적이어야 한다. 언두와 "이 음을 A→B로"가 여기 걸린다.
// ---------------------------------------------------------------------------

export type ProjectId = `prj_${string}`;
export type TrackId = `trk_${string}`;
export type ClipId = `clp_${string}`;
export type NoteId = `not_${string}`;

/** 스키마 버전. 필드 추가는 자유, 제거·개명은 마이그레이션 함수 동반 (`sound.md` 9-8) */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 출처 — Phase 1부터 넣는다
//
// AI가 아직 없어도 필요하다. 차별점 ②(사용자 음소재 보존)가 이 필드 없이는
// 성립하지 않고, Phase 3에 추가하면 저장된 프로젝트 전부를 마이그레이션해야 한다.
// ---------------------------------------------------------------------------

export type Origin = 'user' | 'ai';

// ---------------------------------------------------------------------------
// 음정 곡선 — 목업의 "시작 글라이드 / 흔들림 / 곡선 다듬기"
// ---------------------------------------------------------------------------

export interface Glide {
  /** 시작 음정의 오프셋 (센트). 음수면 아래에서 올라온다 */
  cents: number;
  /** 목표 음정에 도달하는 시간 */
  ms: number;
}

export interface Vibrato {
  /** 진폭 (센트) */
  cents: number;
  hz: number;
  /** 노트 시작 후 비브라토가 걸리기까지의 지연 */
  delayMs: number;
}

export interface CurvePoint {
  /** 노트 길이 안의 상대 위치, 0~1 */
  tNorm: number;
  cents: number;
}

/**
 * 기본값은 악기별 연주 규칙으로 자동 생성하고, 사용자가 직접 그리면 `points` 가
 * 우선한다 (`sound.md` 4절). 사람이 매번 곡선을 그리게 만들면 안 된다.
 */
export interface PitchCurve {
  glide: Glide | null;
  vibrato: Vibrato | null;
  /** 사용자가 그린 곡선. 있으면 위 두 개를 무시한다 */
  points: CurvePoint[] | null;
}

/**
 * 표현 곡선 — Tier 5(현악·관악) 확장 자리 (`sound.md` 4절).
 * 활압·숨세기는 연속 제어라 MIDI 음표만으로는 구동이 안 된다.
 * Phase 1에서는 쓰지 않지만 스키마 자리를 비워 둔다.
 */
export interface Expression {
  bowPressure?: CurvePoint[];
  breath?: CurvePoint[];
}

// ---------------------------------------------------------------------------
// 음 — 편집의 최소 단위
// ---------------------------------------------------------------------------

export interface Note {
  id: NoteId;
  /** 클립 시작 기준 */
  startTick: Ticks;
  lengthTick: Ticks;
  pitch: Pitch;
  /** 0~1 */
  velocity: number;
  pitchCurve: PitchCurve | null;
  expression: Expression | null;
  origin: Origin;
}

// ---------------------------------------------------------------------------
// 클립 · 트랙
// ---------------------------------------------------------------------------

export interface Clip {
  id: ClipId;
  /** 곡 시작 기준 */
  startTick: Ticks;
  lengthTick: Ticks;
  label: string;
  origin: Origin;
  /** true = AI가 이 안의 음을 건드리지 못한다 — 차별점 ② */
  locked: boolean;
  notes: Note[];
}

/**
 * 이펙트 — `plan.md` 5-2 의 "빌려 쓰는 층".
 * 파라미터만 데이터로 남기고 실현은 렌더러(Web Audio 내장 노드)에 맡긴다.
 */
export interface EffectSpec {
  type: string;
  bypass: boolean;
  params: Record<string, number | string | boolean>;
}

export interface Track {
  id: TrackId;
  name: string;
  /** 악기 정의 파일 참조 (`sound.md` 9-2) */
  instrumentId: string;
  /** 기본 제공 음색 프리셋 */
  toneId: string;
  /**
   * 있으면 프리셋을 덮어쓴다 = "내 음색" (`sound.md` 8절).
   * 용량 0이라 링크로 공유되고, Phase 3에서 AI가 이 JSON을 생성한다.
   */
  toneParams: Record<string, number | string> | null;
  /** 0~1 */
  gain: number;
  /** -1(좌) ~ +1(우) */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** 표시용 토큰. 색값을 직접 넣지 않는다 — 테마가 바뀌면 저장된 프로젝트가 깨진다 */
  color: string;
  effects: EffectSpec[];
  clips: Clip[];
}

// ---------------------------------------------------------------------------
// 프로젝트
// ---------------------------------------------------------------------------

/**
 * 반복 재생 구간 (`WORKPLAN.md` 2-5).
 *
 * 전송(transport) 상태가 아니라 **프로젝트에 저장한다** — 실제 작업에서 "이 8마디를
 * 돌린다"는 곡의 일부이고, 파일을 다시 열었을 때 남아 있어야 한다.
 *
 * `enabled` 를 따로 두는 이유: 구간을 지우지 않고 껐다 켜야 한다. 껐다고 구간을
 * 버리면 다시 잡아야 하고, 그게 가장 자주 하는 조작이다.
 */
export interface LoopRegion {
  startTick: Ticks;
  /** 미포함 상한. `startTick` 보다 커야 한다 */
  endTick: Ticks;
  enabled: boolean;
}

export interface Project {
  schemaVersion: number;
  id: ProjectId;
  name: string;
  tempo: Tempo;
  /**
   * 스윙 (0~0.75). 짝수 번째 격자를 이 비율만큼 뒤로 민다 (`ROADMAP.md` P2).
   *
   * **곡의 성격이라 프로젝트에 저장한다.** 보기 설정이 아니다 — 파일을 다시 열었을 때
   * 그루브가 사라지면 다른 곡이 된다. 필드 추가라 마이그레이션은 필요 없다
   */
  swing?: number;
  timeSignature: TimeSignature;
  /** 표시·AI 힌트용. 렌더에는 영향이 없다 */
  key: MusicalKey | null;
  tuning: Tuning;
  /** 반복 재생 구간. `null` 이면 처음부터 끝까지 한 번 */
  loop: LoopRegion | null;
  lengthBars: number;
  tracks: Track[];
  master: {
    gain: number;
    effects: EffectSpec[];
  };
}

// ---------------------------------------------------------------------------
// 파생값 — 저장하지 않는다
//
// 목업의 "수정한 음 0" 카운터가 이것. 저장하면 실제 상태와 어긋난다.
// ---------------------------------------------------------------------------

/** 사용자가 음정을 손댄 음인가 */
export function isPitchEdited(note: Note): boolean {
  return note.pitch.cents !== 0 || note.pitchCurve !== null;
}

export function countEditedNotes(clip: Clip): number {
  return clip.notes.filter(isPitchEdited).length;
}

export function clipEndTick(clip: Clip): Ticks {
  return clip.startTick + clip.lengthTick;
}

/** 솔로가 하나라도 켜져 있으면 솔로가 아닌 트랙은 들리지 않는다 */
export function audibleTracks(project: Project): Track[] {
  const soloed = project.tracks.filter((t) => t.solo);
  const pool = soloed.length > 0 ? soloed : project.tracks;
  return pool.filter((t) => !t.mute);
}

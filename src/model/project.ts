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
export type MarkerId = `mrk_${string}`;
export type SectionId = `sec_${string}`;
export type ChordId = `chd_${string}`;

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
  /**
   * 팜뮤트 등 뮤트 주법의 세기. 0(안 뮤트)~1(완전 뮤트). 이 자리를 쓰는 첫
   * 필드다 — 위 둘과 달리 곡선이 아니라 음 하나에 붙는 스칼라다.
   * `waveguide-string` 계열에서만 뜻이 있다 (`src/audio/articulation.ts`)
   */
  mute?: number;
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
  /**
   * 클립 뮤트 (Logic 리전 뮤트). 지우지 않고 잠깐 빼 들을 때 쓴다.
   * 필드 추가라 마이그레이션이 필요 없다 — 옛 파일은 `undefined` = 들린다
   */
  muted?: boolean;
  /** 클립만 다른 색으로. 없으면 트랙 색 — 색값이 아니라 토큰(`j1`…)이다 */
  color?: string | null;
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

/**
 * 오토메이션 점 하나. **곡 시작 기준 틱** — 클립이 아니라 트랙에 붙는다
 * (`ROADMAP.md` P4: "다음에 손대면 좋을 순서" 2번, `SONGCRAFT.md` 1번).
 *
 * 페이드인·아웃, 프리코러스 상승감, 사이드체인 덕킹이 전부 이 하나의 표현으로
 * 풀린다 — 덕킹도 결국 "킥이 칠 때마다 짧게 눌렸다 돌아오는" 값-시간 곡선이다.
 * 실시간 사이드체인 컴프레서(오디오를 분석해 반응)를 새로 만들지 않고, **미리
 * 계산해 둔 곡선**으로 대신한다 — 그래야 미리듣기와 내보내기가 항상 일치한다
 * (`plan.md` 5-2).
 */
export interface AutomationPoint {
  tick: Ticks;
  /** 0~1. `target` 에 따라 다르게 읽힌다 — `volume` 은 트랙 게인에 곱해지는 배율 */
  value: number;
}

export interface AutomationLane {
  target: 'volume';
  /** 틱 오름차순. 점 사이는 직선 보간, 양 끝 밖은 마지막 값을 유지한다 */
  points: AutomationPoint[];
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
  /** 비어 있으면 예전과 같은 소리 — 자동으로 켜지는 트랙이 없다 */
  automation: AutomationLane[];
  clips: Clip[];
}

// ---------------------------------------------------------------------------
// 글로벌 트랙 — 마커 · 편곡 마커 · 코드 · 박자/조성 변화 (LOGIC_PARITY 1-11)
//
// 전부 **선택 필드**다. 옛 파일은 `undefined` 로 읽히고 그러면 예전과 똑같이 돈다
// (`sound.md` 9-8: 필드 추가는 자유, 제거·개명은 마이그레이션 동반).
// ---------------------------------------------------------------------------

/** 마커 — 곡 안의 한 지점에 붙인 이름. 이동·찾기용이고 소리에는 영향이 없다 */
export interface Marker {
  id: MarkerId;
  tick: Ticks;
  name: string;
}

/**
 * 편곡 마커 (Logic Arrangement marker) — **길이가 있는 구간**(인트로·벌스·코러스).
 * 구간을 옮기거나 복제하면 그 안의 클립·마커·코드·오토메이션이 함께 간다.
 * 서로 겹치지 않는다 (편집 함수가 지킨다).
 */
export interface Section {
  id: SectionId;
  startTick: Ticks;
  lengthTick: Ticks;
  name: string;
}

export const CHORD_QUALITIES = [
  'maj', 'min', 'dim', 'aug', 'sus2', 'sus4', '7', 'maj7', 'min7', 'm7b5', 'dim7', '6', 'min6', 'add9',
] as const;
export type ChordQuality = typeof CHORD_QUALITIES[number];

/**
 * 코드 기호 하나. 다음 코드가 나올 때까지 유지된다 (Logic 코드 트랙과 같다).
 * 소리는 내지 않는다 — 표시, 그리고 앞으로 AI·세션 연주자가 따라갈 진행이다.
 */
export interface ChordSymbol {
  id: ChordId;
  tick: Ticks;
  /** 'C', 'F#' … — `NOTE_NAMES` 표기 */
  root: string;
  quality: ChordQuality;
  /** 슬래시 코드의 베이스음. 없으면 근음 */
  bass: string | null;
}

/**
 * 박자 변화. **마디 번호(0부터)로 건다** — 틱으로 걸면 앞 박자를 바꿀 때
 * 변화 지점이 마디 중간으로 밀려 들어간다. 마디 단위면 항상 마디 경계다.
 */
export interface SignatureChange {
  bar: number;
  timeSignature: TimeSignature;
}

/** 조성 변화. 표시·스케일 판정용이고 소리에는 영향이 없다 (`key` 와 같다) */
export interface KeyChange {
  tick: Ticks;
  key: MusicalKey;
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
  /** 마커 — 틱 오름차순 */
  markers?: Marker[];
  /** 편곡 마커 — 시작 오름차순, 겹치지 않는다 */
  sections?: Section[];
  /** 코드 트랙 — 틱 오름차순 */
  chords?: ChordSymbol[];
  /** 박자 변화 — 마디 오름차순. 0번 마디는 `timeSignature` 가 맡는다 */
  signatureChanges?: SignatureChange[];
  /** 조성 변화 — 틱 오름차순. 곡 시작은 `key` 가 맡는다 */
  keyChanges?: KeyChange[];
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

/** 소리가 나는 클립인가 — 클립 뮤트를 한 곳에서 판정한다 */
export function isClipAudible(clip: Clip): boolean {
  return clip.muted !== true;
}

/** 솔로가 하나라도 켜져 있으면 솔로가 아닌 트랙은 들리지 않는다 */
export function audibleTracks(project: Project): Track[] {
  const soloed = project.tracks.filter((t) => t.solo);
  const pool = soloed.length > 0 ? soloed : project.tracks;
  return pool.filter((t) => !t.mute);
}

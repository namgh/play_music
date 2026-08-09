/**
 * 음정. **`midi + cents` 로 저장하고 Hz 는 파생값이다** (`plan.md` 5-4).
 *
 * 이렇게 나눠야 반음 이동(정수 증감)과 센트 미세조정이 서로 간섭하지 않는다.
 * 목업의 Hz 직접 입력은 `hzToPitch` 로 이 형태로 환산해 저장한다.
 *
 * 이 파일이 제품 주장("음정이 정밀하다")의 데이터 쪽 절반이다.
 * 나머지 절반은 합성 엔진의 분수 딜레이 (`sound.md` 6-2).
 */

export interface Pitch {
  /** MIDI 노트 번호. 69 = A4 */
  midi: number;
  /** 반음 안의 미세조정. -50 ~ +50 범위로 정규화해 둔다 */
  cents: number;
}

export interface Tuning {
  /** 모든 음정 계산의 기준점 */
  a4Hz: number;
}

/**
 * 조성. `project.ts` 가 재수출한다.
 *
 * 여기 두는 이유: 스케일 판정(`isInScale`)이 이 파일에 있고, `project.ts` 에 두면
 * `pitch.ts` → `project.ts` → `pitch.ts` 로 순환 import 가 된다.
 */
export interface MusicalKey {
  tonic: string;
  mode: 'major' | 'minor';
}

export const DEFAULT_TUNING: Tuning = { a4Hz: 440 };

export const A4_MIDI = 69;
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function pitch(midi: number, cents = 0): Pitch {
  return normalizePitch({ midi, cents });
}

/**
 * 센트를 -50 ~ +50 으로 접고 넘친 만큼 midi 로 올린다.
 * 이걸 안 하면 "+70센트"와 "한 반음 위 -30센트"가 다른 값으로 저장돼
 * 같은 음정인데 비교가 안 된다.
 */
export function normalizePitch(p: Pitch): Pitch {
  const total = p.midi * 100 + p.cents;
  const midi = Math.round(total / 100);
  return { midi, cents: total - midi * 100 };
}

export function pitchToHz(p: Pitch, tuning: Tuning = DEFAULT_TUNING): number {
  const semitones = p.midi - A4_MIDI + p.cents / 100;
  return tuning.a4Hz * Math.pow(2, semitones / 12);
}

/** Hz 직접 입력 → 저장 형태. 목업의 주파수 입력창이 이 경로를 쓴다. */
export function hzToPitch(hz: number, tuning: Tuning = DEFAULT_TUNING): Pitch {
  const semitones = 12 * Math.log2(hz / tuning.a4Hz);
  return normalizePitch({ midi: A4_MIDI, cents: semitones * 100 });
}

/** 두 주파수 사이의 센트 차 — 음정 정확도 검증에 쓰는 단위 */
export function centsBetween(fromHz: number, toHz: number): number {
  return 1200 * Math.log2(toHz / fromHz);
}

/** 반음 이동. 센트 미세조정은 그대로 보존된다 — 이게 두 값을 나눠 둔 이유. */
export function transpose(p: Pitch, semitones: number): Pitch {
  return { midi: p.midi + semitones, cents: p.cents };
}

/** 센트 미세조정만 변경 */
export function detune(p: Pitch, cents: number): Pitch {
  return normalizePitch({ midi: p.midi, cents: p.cents + cents });
}

// ---------------------------------------------------------------------------
// 스케일 — 피아노롤의 조성 표시용 (Cubase Scale Assistant · FL Studio 의 기본기)
//
// **렌더에는 영향이 없다.** 조성에 속한 음을 밝게 보여 주는 표시 기능이고,
// 벗어난 음을 막지 않는다 — 막으면 블루스·재즈를 못 찍는다.
// ---------------------------------------------------------------------------

/** 으뜸음 기준 반음 오프셋 */
const SCALE_STEPS: Record<'major' | 'minor', readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  // 자연 단음계. 화성단·가락단은 곡 안에서 갈리므로 표시 기준으로는 자연단을 쓴다
  minor: [0, 2, 3, 5, 7, 8, 10],
};

/** 음이름 → 반음 번호. 플랫 표기도 받는다 (사용자가 `Bb` 로 쓸 수 있다) */
const TONIC_SEMITONE: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6,
  G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

export function tonicSemitone(tonic: string): number | null {
  const key = tonic.trim();
  const direct = TONIC_SEMITONE[key];
  if (direct !== undefined) return direct;
  // 대소문자만 다른 경우를 받아 준다 ("bb" → "Bb")
  const normalized = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  return TONIC_SEMITONE[normalized] ?? null;
}

/**
 * 이 MIDI 음이 조성에 속하는가. 조성을 모르면 `true` (전부 밝게 = 표시 없음).
 *
 * 센트 미세조정은 보지 않는다 — 조성 표시는 건반 줄 단위이고, 미세조정은 그 줄 안의
 * 값이다. 둘을 섞으면 -30센트 맞춰 둔 음이 갑자기 스케일 밖으로 표시된다.
 */
export function isInScale(midi: number, key: MusicalKey | null): boolean {
  if (key === null) return true;
  const root = tonicSemitone(key.tonic);
  if (root === null) return true;
  const degree = (((midi - root) % 12) + 12) % 12;
  return SCALE_STEPS[key.mode].includes(degree);
}

/** 이 MIDI 음이 으뜸음인가 (옥타브 무시). 피아노롤에서 더 진하게 표시한다 */
export function isTonic(midi: number, key: MusicalKey | null): boolean {
  if (key === null) return false;
  const root = tonicSemitone(key.tonic);
  if (root === null) return false;
  return (((midi - root) % 12) + 12) % 12 === 0;
}

export function pitchName(p: Pitch): string {
  const octave = Math.floor(p.midi / 12) - 1;
  return `${NOTE_NAMES[((p.midi % 12) + 12) % 12]}${octave}`;
}

/** 사용자에게 보여줄 표기 — 목업의 "A4 · 440.00 Hz" */
export function formatPitch(p: Pitch, tuning: Tuning = DEFAULT_TUNING): string {
  const cents = p.cents === 0 ? '' : ` ${p.cents > 0 ? '+' : ''}${p.cents.toFixed(1)}¢`;
  return `${pitchName(p)}${cents} · ${pitchToHz(p, tuning).toFixed(2)} Hz`;
}

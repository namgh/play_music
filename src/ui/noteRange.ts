/**
 * 피아노롤에 보일 음역 계산.
 *
 * **줄은 반음 단위로 유지한다.** 더 잘게 쪼개지 않는 이유: 한 줄이 한 반음이어야
 * 화음과 음계가 눈에 보이는 간격으로 남는다. 줄이 10센트가 되면 도-미-솔이 아무
 * 의미 없는 위치로 흩어져 패턴을 읽을 수 없다.
 *
 * 미세 음정은 **다른 축**이 담당한다 — 줄은 "어느 음인가", 센트는 "그 음의 정확히
 * 어디인가"(인스펙터 다이얼 · 곡선 레인). 이 분리가 `plan.md` 차별점 ①의 구조다.
 *
 * 여기 있는 것은 전부 순수 함수다. 좌표 계산이 컴포넌트 안에 흩어지면 조용히 틀린다.
 */

import type { MusicalKey } from '../model/pitch.ts';
import { isInScale } from '../model/pitch.ts';

export interface NoteRange {
  low: number;
  high: number;
}

/** MIDI 유효 범위 */
export const MIDI_MIN = 0;
export const MIDI_MAX = 127;

/**
 * 최소 표시 줄 수. 너무 좁으면 음을 옮길 자리가 없어 편집이 안 된다.
 * 한 옥타브면 화음 하나가 들어간다
 */
export const MIN_SPAN = 12;

/**
 * 음역을 유효하게 만든다.
 *
 * 뒤집힌 입력(사용자가 위아래를 거꾸로 고른 경우)을 정렬하고, 너무 좁으면
 * **바꾼 쪽을 존중하며** 반대쪽을 민다 — 사용자가 방금 만진 값이 튕겨 나가면
 * 조작이 먹히지 않는 것처럼 느껴진다.
 */
export function clampRange(
  range: NoteRange,
  moved: 'low' | 'high' | 'both' = 'both',
): NoteRange {
  let low = Math.round(Math.min(range.low, range.high));
  let high = Math.round(Math.max(range.low, range.high));

  low = Math.max(MIDI_MIN, Math.min(MIDI_MAX, low));
  high = Math.max(MIDI_MIN, Math.min(MIDI_MAX, high));

  if (high - low < MIN_SPAN) {
    if (moved === 'low') {
      high = low + MIN_SPAN;
      // 위쪽이 천장을 넘으면 그때는 아래를 내린다
      if (high > MIDI_MAX) { high = MIDI_MAX; low = high - MIN_SPAN; }
    } else if (moved === 'high') {
      low = high - MIN_SPAN;
      if (low < MIDI_MIN) { low = MIDI_MIN; high = low + MIN_SPAN; }
    } else {
      high = Math.min(MIDI_MAX, low + MIN_SPAN);
      low = Math.max(MIDI_MIN, high - MIN_SPAN);
    }
  }

  return { low, high };
}

/**
 * 음들이 다 보이는 음역. "음에 맞추기" 버튼이 쓴다.
 *
 * 위아래로 `pad` 만큼 여유를 준다 — 음이 화면 맨 끝 줄에 붙어 있으면 위로 옮길
 * 자리가 없다. 음이 없으면 `fallback` 을 그대로 돌려준다.
 */
export function rangeOfNotes(
  midis: readonly number[],
  fallback: NoteRange,
  pad = 2,
): NoteRange {
  if (midis.length === 0) return clampRange(fallback);
  return clampRange({
    low: Math.min(...midis) - pad,
    high: Math.max(...midis) + pad,
  });
}

/** 지금 음역 밖이라 화면에 안 보이는 음의 수. 0 이 아니면 사용자에게 알려야 한다 */
export function hiddenNoteCount(midis: readonly number[], range: NoteRange): number {
  return midis.filter((midi) => midi < range.low || midi > range.high).length;
}

/** 이 음이 악기가 실제로 낼 수 있는 범위 안인가 (표시 음역과는 다른 개념) */
export function isPlayable(midi: number, instrumentRange: NoteRange): boolean {
  return midi >= instrumentRange.low && midi <= instrumentRange.high;
}

// ---------------------------------------------------------------------------
// 접기 (Ableton "Fold" · Logic "Collapse Mode")
//
// 조사 결과 **숫자로 음역을 지정하는 DAW 는 없다.** 전부 "안 쓰는 줄을 치우는"
// 방식으로 같은 문제를 푼다. Ableton 은 여기에 "Fold to Scale" 까지 있다.
//
// 이 함수가 도입하는 변화가 크다: 줄이 **연속 범위에서 임의 목록**이 된다.
// 그래서 `midi → 화면 위치` 를 뺄셈으로 계산할 수 없고, 세로 드래그도 "반음"이
// 아니라 "보이는 줄"단위가 된다. 그 계산이 전부 여기 모여 있어야 한다.
// ---------------------------------------------------------------------------

/** `off` 전부 · `notes` 음이 있는 줄만 · `scale` 조성에 속한 줄 + 음이 있는 줄 */
export type FoldMode = 'off' | 'notes' | 'scale';

/**
 * 화면에 보일 줄 목록. **높은 음부터 내려온다** (피아노롤 표시 순서).
 *
 * `occupied` 는 음이 있는 줄이다 — 편집 중인 클립뿐 아니라 **보이는 고스트 트랙의
 * 음도 포함**해야 한다. 안 그러면 고스트가 접힌 줄에 숨어 안 보인다.
 *
 * **비어 있으면 전체 범위로 되돌린다.** 빈 클립에서 접으면 줄이 하나도 없어
 * 음을 추가할 곳이 사라진다 — 그러면 편집기가 잠긴다.
 */
export function visibleRows(
  range: NoteRange,
  mode: FoldMode,
  occupied: readonly number[],
  key: MusicalKey | null,
): number[] {
  const all: number[] = [];
  for (let midi = range.high; midi >= range.low; midi--) all.push(midi);

  if (mode === 'off') return all;

  const has = new Set(occupied);

  if (mode === 'notes') {
    const rows = all.filter((midi) => has.has(midi));
    return rows.length > 0 ? rows : all;
  }

  // scale: 조성이 없으면 접을 기준이 없다
  if (key === null) return all;
  // 조성에 속한 줄 + 조성 밖이지만 음이 있는 줄 (Ableton 과 같은 규칙 —
  // 스케일 밖 음을 감추면 그 음을 고칠 방법이 없어진다)
  const rows = all.filter((midi) => isInScale(midi, key) || has.has(midi));
  return rows.length > 0 ? rows : all;
}

/** 이 음이 몇 번째 줄인가. 안 보이면 -1 */
export function rowIndexOf(rows: readonly number[], midi: number): number {
  return rows.indexOf(midi);
}

/**
 * `fromMidi` 에서 **보이는 줄** 기준으로 `rowDelta` 만큼 옮긴 음.
 *
 * 접힌 상태에서는 한 줄 아래가 한 반음 아래가 아니다. 반음으로 계산하면
 * 안 보이는 줄로 음이 사라진다.
 */
export function midiAfterRowShift(
  rows: readonly number[],
  fromMidi: number,
  rowDelta: number,
): number {
  if (rows.length === 0) return fromMidi;
  const from = rows.indexOf(fromMidi);
  // 안 보이는 음을 끌고 있으면 (다른 줄에서 옮겨 온 경우) 반음으로 처리한다
  if (from < 0) return fromMidi - rowDelta;
  const to = Math.max(0, Math.min(rows.length - 1, from + rowDelta));
  return rows[to]!;
}

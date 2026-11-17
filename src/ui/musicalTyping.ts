/**
 * 컴퓨터 건반으로 연주 (Logic Musical Typing, `LOGIC_PARITY.md` 1-6).
 *
 * 자판 가운데 줄이 흰 건반, 윗줄이 검은 건반 — Logic·GarageBand 와 같은 배치라 손이
 * 이미 안다. `event.code`(자판 위치)로 읽는다 — `event.key` 는 한글 입력 상태면
 * 'ㅁ' 이 와서 연주가 끊긴다.
 */

/** 자판 위치 → 옥타브 기준 반음 */
export const TYPING_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};

export type TypingAction =
  | { kind: 'note'; midi: number }
  | { kind: 'octave'; delta: -1 | 1 }
  | { kind: 'velocity'; delta: -1 | 1 }
  | null;

/** 키 하나가 무엇을 하나. Z/X 옥타브, C/V 세기 (Logic 과 같다) */
export function typingAction(code: string, octave: number): TypingAction {
  if (code === 'KeyZ') return { kind: 'octave', delta: -1 };
  if (code === 'KeyX') return { kind: 'octave', delta: 1 };
  if (code === 'KeyC') return { kind: 'velocity', delta: -1 };
  if (code === 'KeyV') return { kind: 'velocity', delta: 1 };
  const semis = TYPING_KEYS[code];
  if (semis === undefined) return null;
  const midi = (octave + 1) * 12 + semis;
  return midi >= 0 && midi <= 127 ? { kind: 'note', midi } : null;
}

/** 세기 단계 — C/V 로 오르내린다 */
export const VELOCITY_STEPS = [0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1];

/** 이 midi 를 치는 자판 글자 (건반 위에 적어 준다) */
export function keyLabelFor(midi: number, octave: number): string | null {
  const base = (octave + 1) * 12;
  const entry = Object.entries(TYPING_KEYS).find(([, s]) => base + s === midi);
  if (!entry) return null;
  const code = entry[0];
  return code === 'Semicolon' ? ';' : code === 'Quote' ? "'" : code.replace('Key', '');
}

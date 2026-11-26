/**
 * 스크린셋 (Logic Screensets, `PARITY_ROUND2.md` 16) — 화면 배치를 번호 칸(1~9)에 저장하고 숫자 키로 불러온다.
 * 배치 = 어느 화면 · 편집기 보기(피아노 롤/스텝/목록/악보) · 옆 칸 탭 · 연주 칸 열림.
 * 이 브라우저에 저장한다 (곡이 아니라 작업 습관이다).
 */

export type ScreenView = 'editor' | 'mixer' | 'live' | 'assistant' | 'tuning';
export interface Screenset {
  view: ScreenView;
  editorView: 'roll' | 'steps' | 'list' | 'score';
  sideTab: 'inspect' | 'controls' | 'browse' | 'ai';
  playOpen: boolean;
}

const KEY = 'screensets-v1';
const VIEWS: ScreenView[] = ['editor', 'mixer', 'live', 'assistant', 'tuning'];
const EDITOR_VIEWS = ['roll', 'steps', 'list', 'score'] as const;
const SIDE_TABS = ['inspect', 'controls', 'browse', 'ai'] as const;

export function parseScreensets(raw: unknown): Record<number, Screenset> {
  const out: Record<number, Screenset> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(k);
    if (!(n >= 1 && n <= 9) || !v || typeof v !== 'object') continue;
    const s = v as Record<string, unknown>;
    if (!VIEWS.includes(s.view as ScreenView)) continue;
    out[n] = {
      view: s.view as ScreenView,
      editorView: EDITOR_VIEWS.includes(s.editorView as never) ? s.editorView as Screenset['editorView'] : 'roll',
      sideTab: SIDE_TABS.includes(s.sideTab as never) ? s.sideTab as Screenset['sideTab'] : 'inspect',
      playOpen: s.playOpen === true,
    };
  }
  return out;
}

export function loadScreensets(): Record<number, Screenset> {
  try { return parseScreensets(JSON.parse(localStorage.getItem(KEY) ?? '{}')); } catch { return {}; }
}

export function saveScreenset(slot: number, set: Screenset): Record<number, Screenset> {
  const all = { ...loadScreensets(), [slot]: set };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* 저장소 막힘 */ }
  return all;
}

/** 숫자 키 → 칸 번호 (Digit1~9, 자판 배열과 상관없이 위치로) */
export function screensetSlot(code: string): number | null {
  const m = /^Digit([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}

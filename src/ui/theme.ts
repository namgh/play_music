/**
 * 색 묶음과 사용자 색 덮어쓰기.
 *
 * 묶음 값 자체는 `index.css` 에 있다 (`:root[data-theme=…]`). 여기서는 어느 묶음을
 * 쓸지와, 사용자가 색 편집기에서 바꾼 토큰만 기억해 html 요소에 인라인으로 얹는다.
 * **곡이 아니라 보기 설정**이라 프로젝트에 저장하지 않는다 (`plan.md` 5-4).
 */

export const THEMES = [
  { key: 'volt', name: 'A · 전기 노랑', swatch: ['#F1F1EE', '#111113', '#FFD400', '#3DDC97', '#FF6B4A', '#4C9DFF'] },
  { key: 'acid', name: 'B · 애시드 라임', swatch: ['#1B1B1E', '#0D0D0F', '#D8FF3C', '#3DDC97', '#FF8A3D', '#4C9DFF'] },
  { key: 'cobalt', name: 'C · 코발트', swatch: ['#F4F4F1', '#0F1120', '#3358FF', '#FFE03D', '#FF8A3D', '#46B8FF'] },
  { key: 'signal', name: 'D · 신호 주황', swatch: ['#EEEDEA', '#141312', '#FF5A1F', '#3DCB8C', '#FFB23F', '#4C9DFF'] },
  { key: 'oak', name: '크림 · 오크', swatch: ['#F3F1E6', '#18181A', '#C8782E', '#DCEF7C', '#8DB59A', '#D9A066'] },
] as const;
export type ThemeKey = (typeof THEMES)[number]['key'];

/** 사용자가 고칠 수 있는 토큰. 나머지(섞어 만든 색)는 이것들에서 따라온다 */
export const EDITABLE_TOKENS: readonly { group: string; items: readonly [string, string][] }[] = [
  { group: '포인트', items: [['acc', '포인트 (재생 위치·선택)'], ['acc-2', '포인트 — 검은 화면 위'], ['acc-ink', '포인트 위 글자'],
    ['cta', '내보내기 버튼'], ['cta-ink', '내보내기 글자']] },
  { group: '몸체', items: [['body', '바탕'], ['panel', '패널'], ['panel-2', '패널 진하게'], ['rule', '선']] },
  { group: '글자', items: [['ink', '글자 · 선택 카드'], ['ink-2', '보조 글자'], ['ink-3', '흐린 글자']] },
  { group: '검은 화면', items: [['screen', '화면'], ['screen-2', '화면 칸'], ['grid', '격자'], ['grid-2', '격자 진하게'],
    ['sink', '화면 글자'], ['sink-2', '화면 보조 글자'], ['sink-3', '화면 흐린 글자']] },
  { group: '트랙 색', items: [['t1', '트랙 1'], ['t2', '트랙 2'], ['t3', '트랙 3'], ['t4', '트랙 4'], ['t5', '트랙 5'], ['t6', '트랙 6']] },
  { group: '상태', items: [['ok', '정상 · 미터'], ['rec', '녹음 · 경고']] },
];
const ALL_TOKENS = EDITABLE_TOKENS.flatMap((g) => g.items.map(([k]) => k));

export interface ThemeState {
  key: ThemeKey;
  /** 토큰 → #rrggbb. 묶음 기본값과 다른 것만 */
  overrides: Record<string, string>;
}

const STORAGE_KEY = 'studio.theme.v1';
const DEFAULT_STATE: ThemeState = { key: 'volt', overrides: {} };

export function loadThemeState(): ThemeState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ThemeState | null;
    if (raw && THEMES.some((t) => t.key === raw.key)) return { key: raw.key, overrides: raw.overrides ?? {} };
  } catch {
    // 저장소가 막혀 있거나 깨졌으면 기본값 — 색 때문에 앱이 안 뜨면 안 된다
  }
  return DEFAULT_STATE;
}

export function saveThemeState(state: ThemeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 기억 못 해도 지금 화면에는 적용돼 있다
  }
}

export function applyTheme(state: ThemeState, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = state.key;
  for (const token of ALL_TOKENS) root.style.removeProperty(`--color-${token}`);
  for (const [token, value] of Object.entries(state.overrides)) root.style.setProperty(`--color-${token}`, value);
}

/** 지금 묶음의 **기본값** (덮어쓰기 전). 색 편집기 입력란의 기준이 된다 */
export function baseColor(token: string, key: ThemeKey): string {
  // :root[data-theme] 규칙은 html 에만 걸리므로, html 의 인라인 값을 잠깐 걷고 읽는다
  const root = document.documentElement;
  const inline = root.style.getPropertyValue(`--color-${token}`);
  const prevKey = root.dataset.theme;
  root.style.removeProperty(`--color-${token}`);
  root.dataset.theme = key;
  const value = getComputedStyle(root).getPropertyValue(`--color-${token}`).trim();
  root.dataset.theme = prevKey;
  if (inline) root.style.setProperty(`--color-${token}`, inline);
  return value;
}

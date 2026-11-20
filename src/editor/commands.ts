/**
 * 동작 한 줄 — 우클릭 메뉴·메뉴 단추·명령 찾기(⌘K)가 **같은 목록**을 쓴다 (`UX_REDESIGN.md` 3).
 * 그래서 어떤 동작이든 세 길 중 어디서나 닿고, 한 곳만 고치면 셋이 같이 바뀐다.
 */
export interface MenuAction {
  id: string;
  label: string;
  /** 단추 title — 무엇을 하는지 한 문장 (브라우저 점검이 이걸로 찾는다) */
  title?: string;
  /** 오른쪽 회색 글 — 단축키 */
  hint?: string;
  disabled?: boolean;
  /** 켜고 끄는 항목이면 지금 상태 */
  checked?: boolean;
  run?: () => void;
  /** 고르는 항목(색·스택) — 한 줄에 작은 칸으로 */
  options?: { label: string; checked?: boolean; run: () => void }[];
  /** 이 항목 위에 줄 */
  separator?: boolean;
}

export interface Command { id: string; section: string; label: string; hint?: string; disabled?: boolean; run: () => void }

/** 메뉴 동작을 명령 찾기용으로 편다 (고르는 항목은 하나씩) */
export function toCommands(section: string, actions: MenuAction[]): Command[] {
  return actions.flatMap((a): Command[] => (a.options
    ? a.options.map((o) => ({ id: `${a.id}:${o.label}`, section, label: `${a.label}: ${o.label}`, disabled: a.disabled === true, run: o.run }))
    : a.run ? [{ id: a.id, section, label: a.label, ...(a.hint ? { hint: a.hint } : {}), disabled: a.disabled === true, run: a.run }] : []));
}

/** 이름으로 찾기 — 글자가 순서대로 들어 있으면 맞는다 (띄어쓰기 무시) */
export function matchCommand(query: string, label: string): boolean {
  const q = query.replace(/\s+/g, '').toLowerCase();
  const l = label.replace(/\s+/g, '').toLowerCase();
  if (q === '') return true;
  if (l.includes(q)) return true;
  let i = 0;
  for (const ch of l) { if (ch === q[i]) i += 1; if (i === q.length) return true; }
  return false;
}

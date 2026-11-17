/**
 * 단축키 — 명령 목록과 사용자 지정 (Logic Key Commands, `LOGIC_PARITY.md` 1-16).
 *
 * **`event.code`(자판 위치)로 맞춘다.** 예전에는 `event.key` 를 봐서 한글 입력 상태에서
 * ⌘S 가 'ㄴ' 으로 와 단축키가 안 먹었다. 위치로 보면 입력기와 상관없다.
 * 순수 함수 — 브라우저 없이 테스트된다.
 */

export interface Binding {
  /** `KeyS`, `Space`, `ArrowUp`, `Delete` … */
  code: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type CommandId =
  | 'play' | 'undo' | 'redo' | 'copy' | 'paste' | 'duplicate' | 'selectAll' | 'loop' | 'save' | 'projects'
  | 'deselect' | 'delete' | 'up' | 'down' | 'octaveUp' | 'octaveDown' | 'left' | 'right'
  | 'prevMarker' | 'nextMarker' | 'metronome' | 'countIn' | 'keyboard' | 'mixer' | 'editor' | 'settings';

export interface CommandSpec {
  id: CommandId;
  label: string;
  group: '재생' | '편집' | '음' | '보기' | '파일';
  defaults: Binding[];
}

export const COMMANDS: CommandSpec[] = [
  { id: 'play', label: '재생 / 정지', group: '재생', defaults: [{ code: 'Space' }] },
  { id: 'prevMarker', label: '이전 마커로', group: '재생', defaults: [{ code: 'Comma', alt: true }] },
  { id: 'nextMarker', label: '다음 마커로', group: '재생', defaults: [{ code: 'Period', alt: true }] },
  { id: 'metronome', label: '메트로놈 켜기/끄기', group: '재생', defaults: [{ code: 'KeyK', alt: true }] },
  { id: 'countIn', label: '카운트인 켜기/끄기', group: '재생', defaults: [{ code: 'KeyC', alt: true }] },
  { id: 'undo', label: '되돌리기', group: '편집', defaults: [{ code: 'KeyZ', meta: true }] },
  { id: 'redo', label: '다시 실행', group: '편집', defaults: [{ code: 'KeyZ', meta: true, shift: true }] },
  { id: 'copy', label: '복사', group: '편집', defaults: [{ code: 'KeyC', meta: true }] },
  { id: 'paste', label: '커서에 붙여넣기', group: '편집', defaults: [{ code: 'KeyV', meta: true }] },
  { id: 'duplicate', label: '고른 음 복제', group: '편집', defaults: [{ code: 'KeyD', meta: true }] },
  { id: 'selectAll', label: '클립의 음 전부 고르기', group: '편집', defaults: [{ code: 'KeyA', meta: true }] },
  { id: 'loop', label: '고른 구간 반복', group: '편집', defaults: [{ code: 'KeyL', meta: true }] },
  { id: 'deselect', label: '고르기 풀기', group: '편집', defaults: [{ code: 'Escape' }] },
  { id: 'delete', label: '고른 음 지우기', group: '음', defaults: [{ code: 'Backspace' }, { code: 'Delete' }] },
  { id: 'up', label: '반음 위로', group: '음', defaults: [{ code: 'ArrowUp' }] },
  { id: 'down', label: '반음 아래로', group: '음', defaults: [{ code: 'ArrowDown' }] },
  { id: 'octaveUp', label: '옥타브 위로', group: '음', defaults: [{ code: 'ArrowUp', shift: true }] },
  { id: 'octaveDown', label: '옥타브 아래로', group: '음', defaults: [{ code: 'ArrowDown', shift: true }] },
  { id: 'left', label: '격자 한 칸 앞으로', group: '음', defaults: [{ code: 'ArrowLeft' }] },
  { id: 'right', label: '격자 한 칸 뒤로', group: '음', defaults: [{ code: 'ArrowRight' }] },
  { id: 'editor', label: '편집기 화면', group: '보기', defaults: [{ code: 'Digit1', alt: true }] },
  { id: 'mixer', label: '믹서 화면', group: '보기', defaults: [{ code: 'KeyX', alt: true }] },
  { id: 'keyboard', label: '건반 칸 열기/닫기', group: '보기', defaults: [{ code: 'KeyB', alt: true }] },
  { id: 'settings', label: '설정', group: '보기', defaults: [{ code: 'Comma', meta: true }] },
  { id: 'save', label: '파일로 저장', group: '파일', defaults: [{ code: 'KeyS', meta: true }] },
  { id: 'projects', label: '새 곡 · 최근 곡 · 버전', group: '파일', defaults: [{ code: 'KeyO', meta: true }] },
];

export type Bindings = Record<CommandId, Binding[]>;

export function defaultBindings(): Bindings {
  return Object.fromEntries(COMMANDS.map((c) => [c.id, c.defaults.map((b) => ({ ...b }))])) as Bindings;
}

/** 수정 키만 눌린 것은 단축키가 아니다 */
const MODIFIER_CODES = new Set(['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight']);

export function bindingFromEvent(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): Binding | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  return { code: e.code, ...(e.metaKey || e.ctrlKey ? { meta: true } : {}), ...(e.shiftKey ? { shift: true } : {}), ...(e.altKey ? { alt: true } : {}) };
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return a.code === b.code && !!a.meta === !!b.meta && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

/** 이 키 눌림이 어느 명령인가 */
export function resolveCommand(bindings: Bindings, e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): CommandId | null {
  const pressed = bindingFromEvent(e);
  if (!pressed) return null;
  for (const spec of COMMANDS) {
    if ((bindings[spec.id] ?? []).some((b) => sameBinding(b, pressed))) return spec.id;
  }
  return null;
}

/** ⌘⇧Z 처럼 */
export function formatBinding(b: Binding): string {
  const names: Record<string, string> = {
    Space: 'Space', Escape: 'Esc', Backspace: '⌫', Delete: 'Del', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Enter: '↩', Tab: '⇥',
  };
  const key = names[b.code] ?? b.code.replace(/^Key/, '').replace(/^Digit/, '');
  return `${b.meta ? '⌘' : ''}${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${key}`;
}

/** 한 키에 두 명령이 물려 있으면 — 설정 화면이 경고한다 */
export function findConflicts(bindings: Bindings): { binding: Binding; commands: CommandId[] }[] {
  const seen = new Map<string, CommandId[]>();
  for (const spec of COMMANDS) {
    for (const b of bindings[spec.id] ?? []) {
      const k = formatBinding(b);
      seen.set(k, [...(seen.get(k) ?? []), spec.id]);
    }
  }
  return [...seen.entries()].filter(([, ids]) => ids.length > 1).map(([k, commands]) => ({
    binding: bindings[commands[0]!]!.find((b) => formatBinding(b) === k)!, commands,
  }));
}

/** 하나를 바꾼다 — 같은 키를 쓰던 다른 명령에서는 빼 준다 (Logic 도 그렇게 묻는다) */
export function rebind(bindings: Bindings, id: CommandId, binding: Binding): Bindings {
  const next = Object.fromEntries(Object.entries(bindings).map(([k, list]) => [k, list.filter((b) => !sameBinding(b, binding))])) as Bindings;
  next[id] = [binding];
  return next;
}

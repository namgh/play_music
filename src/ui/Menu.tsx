import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { matchCommand, type Command, type MenuAction } from '../editor/commands.ts';

export { toCommands, type Command, type MenuAction } from '../editor/commands.ts';

interface MenuProps {
  actions: MenuAction[];
  /** 화면 좌표 — 여기서 연다 (넘치면 안으로 당긴다) */
  x: number;
  y: number;
  label: string;
  onClose: () => void;
}

/** 떠 있는 메뉴. 바깥·Esc 로 닫고, 고르면 실행하고 닫는다 */
export function Menu({ actions, x, y, label, onClose }: MenuProps) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, actions.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-[70]" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} aria-hidden="true" />
      <div
        ref={box}
        role="menu"
        aria-label={label}
        data-menu={label}
        style={{ left: pos.x, top: pos.y }}
        className="scope-body fixed z-[71] max-h-[80vh] w-60 overflow-y-auto rounded-xl border border-rule bg-body p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.18)]"
      >
        {actions.map((a) => (
          <div key={a.id}>
            {a.separator && <div className="my-1 h-px bg-rule" />}
            {a.options ? (
              <div className="flex flex-wrap items-center gap-1 px-2.5 py-1">
                <span className="mr-auto text-[13px] text-ink-2">{a.label}</span>
                {a.options.map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={o.checked === true}
                    disabled={a.disabled}
                    title={`${a.label}: ${o.label}`}
                    onClick={() => { o.run(); onClose(); }}
                    className={`h-6 min-w-6 whitespace-nowrap rounded border px-1.5 text-[11px] disabled:opacity-40 ${o.checked ? 'border-ink bg-ink text-body' : 'border-rule bg-panel text-ink-2 hover:border-ink-3'}`}
                  >{o.label}</button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                disabled={a.disabled}
                title={a.title}
                aria-pressed={a.checked}
                onClick={() => { a.run?.(); onClose(); }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-ink hover:bg-panel disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="w-3 shrink-0 text-[11px]">{a.checked ? '✓' : ''}</span>
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                {a.hint && <span className="shrink-0 text-[11px] text-ink-3">{a.hint}</span>}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** 메뉴를 여는 단추 — 우클릭을 모르거나 터치인 사람도 같은 목록에 닿게 */
export function MenuButton({ label, actions, className, title }: { label: string; actions: MenuAction[]; className?: string; title?: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={`${label} 메뉴`}
        title={title}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.left, y: r.bottom + 4 });
        }}
        className={className ?? 'h-7 shrink-0 whitespace-nowrap rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3'}
      >{label} ▾</button>
      {at && <Menu actions={actions} x={at.x} y={at.y} label={label} onClose={() => setAt(null)} />}
    </>
  );
}

/** 명령 찾기 (⌘K) — 메뉴에 있는 모든 동작을 이름으로 */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const found = useMemo(() => {
    const hits = commands.filter((c) => matchCommand(query, `${c.section} ${c.label}`) || matchCommand(query, c.label));
    // 통째로 들어 있는 것을 먼저
    const q = query.replace(/\s+/g, '').toLowerCase();
    return hits.sort((a, b) => Number(!a.label.replace(/\s+/g, '').toLowerCase().includes(q)) - Number(!b.label.replace(/\s+/g, '').toLowerCase().includes(q))).slice(0, 60);
  }, [commands, query]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const run = (c: Command | undefined) => { if (!c || c.disabled) return; onClose(); c.run(); };
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/30 pt-[14vh]" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-label="명령 찾기"
        onPointerDown={(e) => e.stopPropagation()}
        className="scope-body w-[560px] max-w-[92vw] overflow-hidden rounded-2xl border border-rule bg-body shadow-[0_24px_80px_rgba(0,0,0,0.3)]"
      >
        <input
          autoFocus
          aria-label="명령 이름"
          placeholder="무엇을 할까요 — 나누기, 프리즈, 퀀타이즈…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(found.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); run(found[index]); }
          }}
          className="h-12 w-full border-b border-rule bg-transparent px-4 text-[15px] text-ink outline-none placeholder:text-ink-3"
        />
        <div ref={list} className="max-h-[46vh] overflow-y-auto p-1.5">
          {found.length === 0 && <p className="px-3 py-4 text-sm text-ink-3">맞는 명령이 없습니다</p>}
          {found.map((c, i) => (
            <button
              key={c.id}
              type="button"
              data-active={i === index}
              disabled={c.disabled}
              onPointerMove={() => setIndex(i)}
              onClick={() => run(c)}
              className={`flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm disabled:opacity-40 ${i === index ? 'bg-acc/25 text-ink' : 'text-ink'}`}
            >
              <span className="w-14 shrink-0 text-[11px] text-ink-3">{c.section}</span>
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {c.hint && <span className="shrink-0 text-[11px] text-ink-3">{c.hint}</span>}
            </button>
          ))}
        </div>
        <p className="border-t border-rule px-4 py-2 text-[11px] text-ink-3">↑↓ 고르기 · Enter 실행 · Esc 닫기 — 흐린 것은 지금 고른 것으로는 할 수 없는 동작</p>
      </div>
    </div>
  );
}

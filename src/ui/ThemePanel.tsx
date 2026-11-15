import { useCallback, useState } from 'react';

import {
  EDITABLE_TOKENS, THEMES, applyTheme, baseColor, loadThemeState, saveThemeState,
} from './theme.ts';
import type { ThemeKey, ThemeState } from './theme.ts';

/** 색 상태. 바꾸면 즉시 html 에 적용하고 저장한다 */
export function useThemeState() {
  const [state, setState] = useState<ThemeState>(loadThemeState);
  const update = useCallback((next: ThemeState) => {
    applyTheme(next);
    saveThemeState(next);
    setState(next);
  }, []);
  return {
    state,
    setKey: (key: ThemeKey) => update({ key, overrides: {} }),
    setColor: (token: string, value: string) => {
      const overrides = { ...state.overrides };
      if (value.toLowerCase() === baseColor(token, state.key).toLowerCase()) delete overrides[token];
      else overrides[token] = value;
      update({ ...state, overrides });
    },
    reset: () => update({ ...state, overrides: {} }),
  };
}

export type ThemeControls = ReturnType<typeof useThemeState>;

/**
 * 색 편집기 — 묶음 고르기 + 토큰 하나하나 고치기.
 *
 * 상단 바의 "색" 버튼으로 연다. 고친 값은 이 브라우저에만 기억된다.
 */
export function ThemePanel({ theme, onClose }: { theme: ThemeControls; onClose: () => void }) {
  const { state } = theme;
  const changed = Object.keys(state.overrides).length;
  return (
    <div
      role="dialog"
      aria-label="색 편집기"
      className="absolute right-4 top-[68px] z-50 max-h-[calc(100dvh-84px)] w-[340px] overflow-y-auto rounded-2xl border border-rule bg-body p-4 text-ink shadow-[0_12px_40px_rgba(0,0,0,0.18)]"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-disp text-xl">색</h2>
        <button type="button" onClick={onClose} className="text-xs text-ink-3 hover:text-ink">닫기</button>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        묶음을 고르고, 필요하면 아래에서 한 가지씩 바꿉니다. 이 브라우저에 기억됩니다.
      </p>

      <div className="mt-3 grid gap-1.5">
        {THEMES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => theme.setKey(t.key)}
            aria-pressed={state.key === t.key}
            className={`flex h-11 items-center gap-3 rounded-xl border px-3 text-left text-sm ${
              state.key === t.key ? 'border-ink bg-panel' : 'border-rule hover:border-ink-3'
            }`}
          >
            <span className="flex overflow-hidden rounded">
              {t.swatch.map((c) => <i key={c} className="block h-6 w-3" style={{ background: c }} />)}
            </span>
            {t.name}
          </button>
        ))}
      </div>

      {EDITABLE_TOKENS.map((g) => (
        <div key={g.group} className="mt-4">
          <div className="text-[11px] text-ink-3">{g.group}</div>
          {g.items.map(([token, label]) => {
            const value = (state.overrides[token] ?? baseColor(token, state.key)).toLowerCase();
            return (
              <label key={token} className="flex h-8 items-center gap-2 border-b border-rule text-sm">
                <span className={`flex-1 ${state.overrides[token] ? 'font-semibold' : ''}`}>{label}</span>
                <code className="font-mono text-[11px] text-ink-3">{value.toUpperCase()}</code>
                <input
                  type="color"
                  value={value}
                  onChange={(e) => theme.setColor(token, e.target.value)}
                  className="h-6 w-8 cursor-pointer rounded border border-rule bg-transparent p-0"
                />
              </label>
            );
          })}
        </div>
      ))}

      <button
        type="button"
        disabled={changed === 0}
        onClick={theme.reset}
        className="mt-4 h-8 rounded-lg border border-rule px-3 text-xs disabled:opacity-40"
      >
        바꾼 색 {changed}개 되돌리기
      </button>
    </div>
  );
}

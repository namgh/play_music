import { RangeControl } from './RangeControl.tsx';
import type { FoldMode, NoteRange } from './noteRange.ts';
import type { GhostMode, GhostTrack } from './ghostNotes.ts';

/**
 * 피아노롤 보기 도구 — 줄 접기 · 표시 음역 · 다른 트랙 겹쳐 보기.
 *
 * **하나의 줄로 묶는다.** 전에는 헤더 정보 · 음역 · 보기가 각각 떠 있어서 무게가
 * 똑같았고, 그러면 위계가 없어 아무것도 눈에 안 들어온다. 도구는 도구끼리 모으고
 * 구분선으로 역할을 나눈다 (Operate 모드에서는 표현보다 스캔 가능성이 먼저다).
 *
 * 크기·대비 기준: 라벨은 `text-xs`(12px) `neutral-400`, 값은 `neutral-300`.
 * 이전 11px `neutral-600` 은 대비가 2.6:1 로 **접근성 기준(4.5:1) 미달**이었다.
 */

export interface EditorToolbarProps {
  fold: FoldMode;
  onFold: (mode: FoldMode) => void;
  /** 조성이 없으면 "스케일로 접기"를 쓸 수 없다 */
  hasKey: boolean;

  range: NoteRange;
  instrumentRange: NoteRange;
  noteMidis: readonly number[];
  onRange: (range: NoteRange) => void;

  ghosts: readonly GhostTrack[];
  onGhostMode: (trackId: string, mode: GhostMode) => void;
}

const FOLD_OPTIONS: { mode: FoldMode; label: string; title: string }[] = [
  { mode: 'off', label: '전체', title: '음역 안의 모든 줄을 보여 줍니다' },
  { mode: 'notes', label: '쓴 줄만', title: '음이 있는 줄만 남깁니다' },
  { mode: 'scale', label: '스케일', title: '조성에 속한 줄 + 음이 있는 줄만 남깁니다' },
];

/** 숨김 → 표시 → 편집 → 숨김 */
const nextMode = (mode: GhostMode): GhostMode => (
  mode === 'hidden' ? 'show' : mode === 'show' ? 'edit' : 'hidden'
);

const GHOST_LABEL: Record<GhostMode, string> = { hidden: '숨김', show: '표시', edit: '편집' };

const GHOST_CLASS: Record<GhostMode, string> = {
  // 숨김도 읽을 수 있어야 한다 — 트랙 이름이 정보다
  hidden: 'border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200',
  show: 'border-neutral-500 bg-neutral-800 text-neutral-100',
  edit: 'border-violet-400 bg-violet-900/60 text-violet-100',
};

function Divider() {
  return <span aria-hidden className="h-5 w-px shrink-0 bg-neutral-800" />;
}

export function EditorToolbar({
  fold, onFold, hasKey, range, instrumentRange, noteMidis, onRange, ghosts, onGhostMode,
}: EditorToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2">
      {/* 줄 접기 — 분절 컨트롤 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-400">줄</span>
        <div className="flex overflow-hidden rounded-md border border-neutral-700" role="group" aria-label="줄 접기">
          {FOLD_OPTIONS.map((option) => {
            const disabled = option.mode === 'scale' && !hasKey;
            const active = fold === option.mode;
            return (
              <button
                key={option.mode}
                type="button"
                disabled={disabled}
                onClick={() => onFold(option.mode)}
                aria-pressed={active}
                title={disabled ? '조성을 먼저 정하면 쓸 수 있습니다' : option.title}
                className={`border-r border-neutral-800 px-2.5 py-1 text-xs last:border-r-0 transition-colors ${
                  active
                    ? 'bg-teal-300 font-semibold text-teal-950'
                    : 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
                } disabled:bg-neutral-950 disabled:text-neutral-600 disabled:hover:bg-neutral-950`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      <Divider />

      <RangeControl
        value={range}
        instrumentRange={instrumentRange}
        noteMidis={noteMidis}
        onChange={onRange}
      />

      {ghosts.length > 0 && (
        <>
          <Divider />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-400">다른 트랙</span>
            <div className="flex flex-wrap gap-1">
              {ghosts.map((ghost) => (
                <button
                  key={ghost.trackId}
                  type="button"
                  onClick={() => onGhostMode(ghost.trackId, nextMode(ghost.mode))}
                  title={`${ghost.name} — 눌러서 숨김 → 표시 → 편집 순으로 바꿉니다`}
                  className={`rounded border px-2.5 py-1 text-xs transition-colors ${GHOST_CLASS[ghost.mode]}`}
                >
                  {ghost.name}
                  <span className="ml-1.5 opacity-75">{GHOST_LABEL[ghost.mode]}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

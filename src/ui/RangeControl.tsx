import { useRef, useState } from 'react';

import { pitchName } from '../model/pitch.ts';
import { clampRange, hiddenNoteCount, MIDI_MAX, rangeOfNotes } from './noteRange.ts';
import type { NoteRange } from './noteRange.ts';

/**
 * 표시 음역 선택 — **옥타브 막대**.
 *
 * 처음에는 128개 옵션짜리 셀렉트 두 개였다. 그건 작업 실패였다:
 *  - C2 를 고르려면 128개를 스크롤해야 한다
 *  - 아래와 위의 **관계**가 안 보인다. 음역은 본래 "구간"인데 값 두 개로 흩어졌다
 *  - "C#2 부터 A#3 까지" 로 생각하는 사람은 없다. 사람은 **옥타브**로 생각한다
 *
 * 그래서 옥타브 칸 10개를 늘어놓고 끌어서 구간을 잡는다. 왼쪽이 낮고 오른쪽이 높아
 * 화면의 위아래와 방향이 다르지만, 가로 막대가 "구간"을 훨씬 잘 보여 준다.
 *
 * 반음 단위 정확도가 필요하면 "음에 맞추기" 가 정확히 맞춰 준다 —
 * **손으로는 옥타브, 자동으로는 정확히.** 이 분담이 맞다.
 */

/** MIDI 0~127 은 옥타브 -1 ~ 9. -1 은 8Hz 대라 악기가 없어 뺀다 */
const FIRST_OCTAVE = 0;
const LAST_OCTAVE = 9;
const OCTAVES = Array.from(
  { length: LAST_OCTAVE - FIRST_OCTAVE + 1 },
  (_, i) => FIRST_OCTAVE + i,
);

const octaveOf = (midi: number) => Math.floor(midi / 12) - 1;
const octaveLow = (octave: number) => Math.max(0, (octave + 1) * 12);
const octaveHigh = (octave: number) => Math.min(MIDI_MAX, (octave + 1) * 12 + 11);

export interface RangeControlProps {
  value: NoteRange;
  /** 악기가 실제로 낼 수 있는 범위. 밖의 옥타브는 흐리게 표시한다 */
  instrumentRange: NoteRange;
  /** 지금 클립의 음들. "음에 맞추기" 와 안 보이는 음 경고에 쓴다 */
  noteMidis: readonly number[];
  onChange: (range: NoteRange) => void;
}

export function RangeControl({
  value, instrumentRange, noteMidis, onChange,
}: RangeControlProps) {
  /** 끌기 시작한 옥타브. null 이면 끌고 있지 않다 */
  const dragFrom = useRef<number | null>(null);
  const [hovering, setHovering] = useState<number | null>(null);

  const hidden = hiddenNoteCount(noteMidis, value);
  const from = octaveOf(value.low);
  const to = octaveOf(value.high);

  /** 끌고 있는 동안은 미리보기 구간을 보여 준다 */
  const previewFrom = dragFrom.current !== null && hovering !== null
    ? Math.min(dragFrom.current, hovering) : from;
  const previewTo = dragFrom.current !== null && hovering !== null
    ? Math.max(dragFrom.current, hovering) : to;

  /** 옥타브가 음이 있는 곳인가 — 칸에 점으로 표시한다 */
  const hasNotes = (octave: number) =>
    noteMidis.some((midi) => octaveOf(midi) === octave);

  const apply = (a: number, b: number) => {
    onChange(clampRange({ low: octaveLow(Math.min(a, b)), high: octaveHigh(Math.max(a, b)) }));
  };

  const commitDrag = () => {
    if (dragFrom.current === null) return;
    apply(dragFrom.current, hovering ?? dragFrom.current);
    dragFrom.current = null;
    setHovering(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-xs text-neutral-400">음역</span>

      <div
        // 좁은 열(오른쪽 패널)에서는 옥타브가 다 안 들어간다. 잘라 버리면
        // 높은 옥타브가 **있는 줄도 모르게** 되므로, 가로로 밀어 볼 수 있게 한다
        className="flex overflow-x-auto overflow-y-hidden rounded-md border border-neutral-700"
        onPointerLeave={() => { if (dragFrom.current === null) setHovering(null); }}
        onPointerUp={commitDrag}
        role="group"
        aria-label="표시할 옥타브 구간"
      >
        {OCTAVES.map((octave) => {
          const inSpan = octave >= previewFrom && octave <= previewTo;
          // 악기 음역 밖이어도 **누를 수 있다** (표시 음역과 다른 개념).
          // 흐리게 하되 읽히는 선(4.6:1)까지만 — 못 읽으면 왜 흐린지도 모른다
          const playable = octaveHigh(octave) >= instrumentRange.low
            && octaveLow(octave) <= instrumentRange.high;
          return (
            <button
              key={octave}
              type="button"
              aria-pressed={inSpan}
              title={`${pitchName({ midi: octaveLow(octave), cents: 0 })}–${pitchName({ midi: octaveHigh(octave), cents: 0 })}${
                playable ? '' : ' · 이 악기의 음역 밖'
              }`}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                dragFrom.current = octave;
                setHovering(octave);
              }}
              onPointerEnter={() => { if (dragFrom.current !== null) setHovering(octave); }}
              onPointerUp={commitDrag}
              className={`relative w-8 border-r border-neutral-800 py-1 text-xs tabular-nums last:border-r-0 transition-colors ${
                inSpan
                  ? 'bg-teal-300 font-semibold text-teal-950'
                  : playable
                    ? 'bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                    : 'bg-neutral-950 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300'
              }`}
            >
              {octave}
              {/* 음이 있는 옥타브를 점으로 — 어디를 봐야 할지 바로 보인다 */}
              {hasNotes(octave) && (
                <span
                  aria-hidden
                  className={`absolute inset-x-0 bottom-0.5 mx-auto h-1 w-1 rounded-full ${
                    inSpan ? 'bg-teal-900' : 'bg-teal-400'
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>

      <span className="font-mono text-xs tabular-nums text-neutral-300">
        {pitchName({ midi: value.low, cents: 0 })}–{pitchName({ midi: value.high, cents: 0 })}
      </span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(rangeOfNotes(noteMidis, value))}
          disabled={noteMidis.length === 0}
          title="찍어 둔 음이 다 보이게 반음 단위로 정확히 맞춥니다"
          className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-white disabled:opacity-40 disabled:hover:border-neutral-700"
        >
          음에 맞추기
        </button>
        <button
          type="button"
          onClick={() => onChange(clampRange(instrumentRange))}
          title={`악기 음역 (${pitchName({ midi: instrumentRange.low, cents: 0 })}–${pitchName({ midi: instrumentRange.high, cents: 0 })})`}
          className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-white"
        >
          악기 음역
        </button>
      </div>

      {/* 좁혀서 음이 가려지면 알려 준다 — 조용히 사라지면 원인을 못 찾는다 */}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => onChange(rangeOfNotes(noteMidis, value))}
          className="rounded border border-amber-700/70 bg-amber-950/50 px-2.5 py-1 text-xs text-amber-200 hover:border-amber-500"
          title="눌러서 다 보이게 넓힙니다"
        >
          {hidden}개가 화면 밖
        </button>
      )}
    </div>
  );
}

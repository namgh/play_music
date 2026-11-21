import { useCallback, useMemo, useRef, useState } from 'react';

import type { Clip, MusicalKey, NoteId, Project } from '../model/project.ts';
import { isPitchEdited } from '../model/project.ts';
import { PPQ, ticksPerBar, quantize } from '../model/time.ts';
import { NOTE_NAMES, isInScale, isTonic, pitchName } from '../model/pitch.ts';
import { addNote, moveNotes, resizeNotes } from '../editor/edits.ts';
import { isPlayable, midiAfterRowShift, visibleRows } from './noteRange.ts';
import type { FoldMode } from './noteRange.ts';
import { editableGhosts, ghostMidis } from './ghostNotes.ts';
import type { GhostTrack } from './ghostNotes.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';

/**
 * 피아노롤. 시안은 `mockup/studio-v2.html` 의 "음 편집기".
 *
 * 좌표 변환을 한 곳에 모아 둔다 — 픽셀↔틱 계산이 이벤트 핸들러마다 흩어지면
 * 줌을 넣는 순간 전부 어긋난다.
 *
 * ## 빈 곳을 누를 때: 클릭이면 추가, 끌면 범위 선택
 *
 * 예전에는 `pointerdown` 에서 곧바로 음을 추가했다. 그러면 범위 선택(러버밴드)을
 * 넣을 자리가 없다 — 누르는 순간 이미 음이 생겨 있기 때문이다.
 * 지금은 누른 위치를 기억해 두고, 문턱을 넘어 움직이면 범위 선택으로,
 * 안 움직이고 떼면 음 추가로 간다.
 */

/**
 * 줌 배율 1.0 일 때의 크기. 여기에 배율을 곱해 쓴다.
 *
 * 줌이 없으면 8마디만 돼도 가로가 1792px 라 화면 밖으로 나가고, 반대로 미세한
 * 타이밍을 볼 방법도 없다. 좌표 계산은 이미 한 곳에 모여 있어서 배율만 곱하면 된다
 * (`ROADMAP.md` P1).
 */
const BASE_ROW_HEIGHT = 15;
const BASE_PX_PER_BEAT = 56;
const MIN_NOTE_TICKS = PPQ / 16;
/** 이만큼 움직이면 "끈 것"으로 본다. 손떨림으로 범위 선택이 시작되지 않게 */
const DRAG_THRESHOLD_PX = 4;

/** 음 색 — 음정 손댄 음을 구분 / 세기 진하기 / 음이름(피치 클래스)별 */
export type NoteColorMode = 'edit' | 'velocity' | 'pitch';

/** 음이름 12개를 트랙 색 6개에 — 반음 이웃끼리 다른 색이 되게 5도 순서로 */
const PITCH_TOKENS = ['t1', 't4', 't2', 't5', 't3', 't6'];

export interface PianoRollProps {
  colorMode?: NoteColorMode;
  editor: ProjectEditor;
  clip: Clip;
  /**
   * 바깥 레이아웃이 정하는 크기. **앱 프레임이 남은 높이를 여기로 넘긴다** —
   * 안 주면 내용만큼 자라서 화면 밖으로 나간다
   */
  className?: string;
  /** **표시할** 음역. 사용자가 조절한다 (`RangeControl`) */
  range: { low: number; high: number };
  /**
   * 악기가 실제로 낼 수 있는 음역. 표시 음역과 **다른 개념**이다.
   *
   * 밖의 줄도 보여 주고 찍을 수도 있게 두되 어둡게 표시한다 — 막으면 나중에 악기를
   * 바꿀 때 못 쓰고, 아무 표시도 안 하면 왜 이상하게 들리는지 알 수 없다.
   */
  instrumentRange: { low: number; high: number };
  /** 가로 줌 배율. 1 이면 기본 크기 */
  zoomX: number;
  /** 세로 줌 배율 */
  zoomY: number;
  /** 새로 찍는 음의 세기 */
  velocity: number;
  gridTicks: number;
  /**
   * 새로 찍는 음의 길이. **격자와 분리한다** — 16분 격자로 정확히 찍으면서
   * 4분음표를 넣고 싶은 건 흔한 요구인데, 묶여 있으면 매번 늘려야 했다
   */
  noteLengthTicks: number;
  /** 재생 위치 (틱). null 이면 표시하지 않는다 */
  playheadTick: number | null;
  /** 편집 커서 (클립 기준 틱). 재생·붙여넣기의 기준점 */
  cursorTick: number;
  onMoveCursor: (tick: number) => void;
  /** 조성. 스케일에 속한 줄을 밝게 표시한다. null 이면 표시하지 않는다 */
  musicalKey: MusicalKey | null;
  /** 안 쓰는 줄 접기 (Ableton "Fold" · Logic "Collapse Mode") */
  fold: FoldMode;
  /**
   * 다른 트랙의 음. 이미 **이 클립의 좌표계로 옮겨져** 있다 (`collectGhosts`).
   * `editable` 인 것은 여기서 선택·이동·삭제할 수 있다 (FL Studio "Editable Ghosts")
   */
  ghosts: readonly GhostTrack[];
  onAudition: (midi: number, cents: number) => void;
}

type DragMode = 'move' | 'resize';

interface DragState {
  mode: DragMode;
  ids: readonly NoteId[];
  startX: number;
  startY: number;
  /** 드래그 시작 시점의 프로젝트 — 누적 오차를 막기 위해 항상 여기서 계산한다 */
  origin: Project;
  /**
   * 실제로 잡은 음의 높이. 접힌 상태에서 "몇 줄 움직였나"를 반음으로 환산할 기준점이다.
   * 여러 음을 함께 옮길 때도 **이 음이 움직인 반음 수**를 전체에 적용한다
   */
  anchorMidi: number;
}

/** 빈 격자를 누른 상태. 끌면 범위 선택, 안 끌고 떼면 음 추가 */
interface MarqueeState {
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** 문턱을 넘었는가 */
  active: boolean;
  /** 기존 선택에 더할지 (Shift) */
  additive: boolean;
  baseSelection: readonly NoteId[];
}

const isBlackKey = (midi: number) => NOTE_NAMES[((midi % 12) + 12) % 12]!.includes('#');

/**
 * 격자에 맞출지 정한다. **Alt 를 누르고 있으면 맞추지 않는다.**
 *
 * 음정은 0.1센트까지 조절되는데 타이밍만 격자에 못 박혀 있는 것은 비대칭이다.
 * 그루브를 만들려면 "이 음만 살짝 앞으로"가 돼야 한다. Alt 는 대부분의 DAW 가
 * 같은 뜻으로 쓰는 키다.
 */
const snap = (ticks: number, gridTicks: number, free: boolean): number =>
  (free ? Math.max(0, Math.round(ticks)) : quantize(ticks, gridTicks));

export function PianoRoll({
  colorMode = 'edit', editor, clip, range, instrumentRange, zoomX, zoomY, velocity, gridTicks, noteLengthTicks,
  playheadTick, cursorTick, onMoveCursor, musicalKey, fold, ghosts, onAudition,
  className = '',
}: PianoRollProps) {
  // 배율을 곱한 실제 크기. 아래 계산은 전부 이 두 값만 본다
  const ROW_HEIGHT = Math.max(6, Math.round(BASE_ROW_HEIGHT * zoomY));
  const PX_PER_BEAT = Math.max(8, BASE_PX_PER_BEAT * zoomX);
  const { project, selection } = editor;
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);

  /**
   * 보이는 줄. **접으면 연속 범위가 아니라 임의 목록이 된다** — 그래서 화면 위치를
   * 뺄셈으로 구할 수 없고 인덱스를 찾아야 한다.
   *
   * 고스트 음도 `occupied` 에 넣는다. 안 넣으면 접었을 때 고스트가 숨어 안 보인다.
   */
  const liveRows = useMemo(() => {
    const occupied = [
      ...clip.notes.map((n) => n.pitch.midi),
      ...ghostMidis(ghosts),
    ];
    return visibleRows(range, fold, occupied, musicalKey);
  }, [clip.notes, fold, ghosts, musicalKey, range]);

  /**
   * 드래그 중에는 줄 목록을 **고정한다.**
   *
   * 왜: 접힌 상태에서 음을 옮기면 `preview` 가 프로젝트를 바꾸고, 그러면 "음이 있는
   * 줄"이 달라져 줄 목록이 **커서 밑에서 움직인다.** 그러면 조금 끌었는데 음이
   * 훌쩍 뛰거나 되돌아온다. 시작 시점의 목록으로 끝까지 계산해야 한다.
   */
  const frozenRows = useRef<number[] | null>(null);
  const rows = drag !== null && frozenRows.current !== null ? frozenRows.current : liveRows;

  /** midi → 줄 인덱스. 매 노트마다 `indexOf` 를 돌리면 O(n²) 가 된다 */
  const rowIndex = useMemo(() => {
    const map = new Map<number, number>();
    rows.forEach((midi, i) => map.set(midi, i));
    return map;
  }, [rows]);

  const pxPerTick = PX_PER_BEAT / PPQ;
  const width = clip.lengthTick * pxPerTick;
  const height = rows.length * ROW_HEIGHT;

  /** 안 보이는 음은 `null` — 호출자가 건너뛴다 */
  const midiToTop = (midi: number): number | null => {
    const index = rowIndex.get(midi);
    return index === undefined ? null : index * ROW_HEIGHT;
  };
  const tickToLeft = (tick: number) => tick * pxPerTick;

  /** 격자 위 클릭 좌표 → 틱·음 */
  const pointToCell = useCallback(
    (clientX: number, clientY: number, free = false) => {
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const index = Math.max(0, Math.min(rows.length - 1, Math.floor(y / ROW_HEIGHT)));
      return {
        tick: Math.max(0, snap(x / pxPerTick, gridTicks, free)),
        midi: rows[index] ?? range.low,
      };
    },
    [gridTicks, pxPerTick, range.low, rows],
  );

  // --- 빈 격자: 누르기 → (끌면 범위 선택 / 떼면 음 추가) ---------------------

  const onGridPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== gridRef.current) return; // 노트를 눌렀으면 노트 핸들러가 처리한다
    if (event.button !== 0) return; // 우클릭은 메뉴 — 음을 찍지 않는다
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);

    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setMarquee({
      startX: x, startY: y, x, y,
      active: false,
      additive: event.shiftKey,
      baseSelection: selection,
    });
  };

  const onGridPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee) return;
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const moved = Math.abs(x - marquee.startX) > DRAG_THRESHOLD_PX
      || Math.abs(y - marquee.startY) > DRAG_THRESHOLD_PX;
    const next = { ...marquee, x, y, active: marquee.active || moved };
    setMarquee(next);
    if (!next.active) return;

    // 사각형에 걸치는 음을 고른다. **겹치기 판정**이다 — 완전히 감싸야만 잡히면
    // 긴 음을 고를 때 화면 밖까지 끌어야 한다
    const left = Math.min(next.startX, x) / pxPerTick;
    const right = Math.max(next.startX, x) / pxPerTick;
    // **줄 인덱스로 판정한다.** 접히면 한 줄이 한 반음이 아니라 midi 뺄셈이 틀린다
    const topRow = Math.floor(Math.min(next.startY, y) / ROW_HEIGHT);
    const bottomRow = Math.floor(Math.max(next.startY, y) / ROW_HEIGHT);

    const inBox = (midi: number, startTick: number, lengthTick: number): boolean => {
      const index = rowIndex.get(midi);
      if (index === undefined) return false;
      // 사각형에 **걸치기만** 하면 잡는다 — 완전히 감싸야 하면 긴 음을 고를 때
      // 화면 밖까지 끌어야 한다
      return index >= topRow && index <= bottomRow
        && startTick < right && left < startTick + lengthTick;
    };

    const hit = [
      ...clip.notes
        .filter((note) => inBox(note.pitch.midi, note.startTick, note.lengthTick))
        .map((note) => note.id),
      // 편집 가능한 고스트도 범위 선택에 들어간다
      ...editableGhosts(ghosts)
        .filter((g) => inBox(g.note.pitch.midi, g.startTick, g.lengthTick))
        .map((g) => g.note.id),
    ];

    editor.select(next.additive ? [...new Set([...next.baseSelection, ...hit])] : hit);
  };

  const onGridPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee) return;
    const wasDrag = marquee.active;
    setMarquee(null);
    if (wasDrag) return;

    // 끌지 않았다 → 음 추가. 커서도 그 자리로 옮긴다
    const cell = pointToCell(event.clientX, event.clientY, event.altKey);
    if (!cell) return;
    const { project: next, noteId } = addNote(project, {
      clipId: clip.id,
      startTick: cell.tick,
      // 격자가 아니라 **지정한 음 길이**로 찍는다
      lengthTick: noteLengthTicks,
      midi: cell.midi,
      // 찍을 때 세기를 정한다. 예전에는 전부 기본값으로 들어가서 나중에
      // 벨로시티 레인에서 일일이 고쳐야 했다
      velocity,
    });
    editor.commit(next);
    editor.select([noteId]);
    onMoveCursor(cell.tick);
    onAudition(cell.midi, 0);
  };

  // --- 노트 끌기 -------------------------------------------------------------

  const beginDrag = (
    event: React.PointerEvent<HTMLElement>,
    noteId: NoteId,
    mode: DragMode,
    anchorMidi: number,
  ) => {
    event.stopPropagation();
    // 우클릭은 끌기가 아니다 — 누른 음을 고르기만 하고, 메뉴는 바깥(`App`)이 연다
    if (event.button !== 0) {
      if (!selection.includes(noteId)) editor.select([noteId]);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);

    // Shift 는 선택에 더한다 (빼기도 같은 키로 — 토글)
    if (event.shiftKey) {
      editor.toggleSelect(noteId);
      return;
    }

    const ids = selection.includes(noteId) ? selection : [noteId];
    if (!selection.includes(noteId)) editor.select(ids);
    frozenRows.current = liveRows;
    setDrag({
      mode, ids, startX: event.clientX, startY: event.clientY, origin: project,
      anchorMidi,
    });
  };

  const onDragMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.mode === 'move') {
      const dTicks = event.altKey
        ? Math.round(dx / pxPerTick)
        : quantize(dx / pxPerTick, gridTicks);
      // **줄 단위로 옮긴 뒤 반음 차로 환산한다.** 접히면 한 줄이 한 반음이 아니라
      // 반음으로 바로 계산하면 안 보이는 줄로 음이 사라진다
      const rowDelta = Math.round(dy / ROW_HEIGHT);
      const dSemis = midiAfterRowShift(rows, drag.anchorMidi, rowDelta) - drag.anchorMidi;
      if (dTicks === 0 && dSemis === 0) {
        editor.preview(drag.origin);
        return;
      }
      editor.preview(moveNotes(drag.origin, drag.ids, { ticks: dTicks, semitones: dSemis }));
    } else {
      const dTicks = event.altKey
        ? Math.round(dx / pxPerTick)
        : quantize(dx / pxPerTick, gridTicks);
      editor.preview(resizeNotes(drag.origin, drag.ids, dTicks, MIN_NOTE_TICKS));
    }
  };

  const endDrag = () => {
    if (!drag) return;
    setDrag(null);
    frozenRows.current = null;
    // 드래그 전체를 언두 한 단계로 만든다
    editor.commitCurrent();
  };

  const barTicks = ticksPerBar(project.timeSignature);
  const barCount = Math.ceil(clip.lengthTick / barTicks);
  const gridLines: number[] = [];
  for (let t = 0; t <= clip.lengthTick; t += gridTicks) gridLines.push(t);

  /** 눈금을 클릭해 커서를 옮긴다 (여기부터 재생 · 여기에 붙여넣기) */
  const onRulerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const tick = snap((event.clientX - rect.left) / pxPerTick, gridTicks, event.altKey);
    onMoveCursor(tick);
  };

  const marqueeBox = marquee?.active
    ? {
        left: Math.min(marquee.startX, marquee.x),
        top: Math.min(marquee.startY, marquee.y),
        width: Math.abs(marquee.x - marquee.startX),
        height: Math.abs(marquee.y - marquee.startY),
      }
    : null;

  return (
    <div className={`flex overflow-auto rounded-xl border border-neutral-800 bg-neutral-950 ${className}`}>
      {/* 건반 */}
      <div className="sticky left-0 z-20 shrink-0 border-r border-neutral-800 bg-neutral-950">
        <div className="h-6 border-b border-neutral-800" />
        {rows.map((midi) => {
          const inScale = isInScale(midi, musicalKey);
          const tonic = isTonic(midi, musicalKey);
          const playable = isPlayable(midi, instrumentRange);
          const title = playable
            ? (tonic ? `${pitchName({ midi, cents: 0 })} (으뜸음)` : pitchName({ midi, cents: 0 }))
            : `${pitchName({ midi, cents: 0 })} — 이 악기의 음역 밖`;
          return (
            <button
              key={midi}
              type="button"
              onClick={() => onAudition(midi, 0)}
              style={{ height: ROW_HEIGHT }}
              title={title}
              className={`flex w-16 items-center justify-end border-b px-2 text-[9px] font-mono ${
                isBlackKey(midi)
                  ? 'border-screen bg-keyb text-sink-3'
                  : 'border-grid bg-keyw text-ink-3'
              } ${inScale ? '' : 'opacity-40'} ${playable ? '' : 'opacity-25'}`}
            >
              {tonic ? (
                <span className="font-semibold text-ink">{pitchName({ midi, cents: 0 })}</span>
              ) : (
                midi % 12 === 0 ? `C${Math.floor(midi / 12) - 1}` : ''
              )}
            </button>
          );
        })}
      </div>

      <div>
        {/* 마디 눈금 — 클릭하면 커서가 옮겨진다 */}
        <div
          onPointerDown={onRulerPointerDown}
          className="sticky top-0 z-10 flex h-6 cursor-text border-b border-neutral-800 bg-neutral-950"
          style={{ width }}
          title="클릭해 재생 위치를 옮깁니다"
        >
          {Array.from({ length: barCount }, (_, i) => (
            <div
              key={i}
              style={{ width: barTicks * pxPerTick }}
              className="pointer-events-none shrink-0 border-l border-neutral-800 pl-1.5 pt-0.5 font-num text-[13px] text-neutral-400"
            >
              {i + 1}
            </div>
          ))}
        </div>

        {/* 격자 */}
        <div
          ref={gridRef}
          onPointerDown={onGridPointerDown}
          onPointerMove={onGridPointerMove}
          onPointerUp={onGridPointerUp}
          onPointerCancel={() => setMarquee(null)}
          style={{ width, height }}
          className="relative cursor-crosshair"
        >
          {rows.map((midi) => {
            const inScale = isInScale(midi, musicalKey);
            const tonic = isTonic(midi, musicalKey);
            // 스케일 밖은 어둡게. **막지는 않는다** — 막으면 블루스·재즈를 못 찍는다
            const shade = !isPlayable(midi, instrumentRange)
              ? 'bg-black/70'
              : tonic
                ? 'bg-teal-500/10'
                : !inScale
                  ? 'bg-black/40'
                  : isBlackKey(midi)
                    ? 'bg-neutral-900/40'
                    : '';
            const top = midiToTop(midi);
            if (top === null) return null;
            return (
              <div
                key={midi}
                style={{ top, height: ROW_HEIGHT }}
                className={`pointer-events-none absolute inset-x-0 border-b border-neutral-900 ${shade}`}
              />
            );
          })}
          {gridLines.map((tick) => (
            <div
              key={tick}
              style={{ left: tickToLeft(tick) }}
              className={`pointer-events-none absolute inset-y-0 w-px ${
                tick % barTicks === 0 ? 'bg-neutral-700' : 'bg-neutral-900'
              }`}
            />
          ))}

          {/* 편집 커서 — 재생 시작 위치이자 붙여넣기 위치 */}
          <div
            style={{ left: tickToLeft(cursorTick) }}
            className="pointer-events-none absolute inset-y-0 z-10 w-px bg-sink/50"
          />

          {playheadTick !== null && playheadTick >= clip.startTick && (
            <div
              style={{ left: tickToLeft(playheadTick - clip.startTick) }}
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-teal-300"
            />
          )}

          {/*
            고스트 노트를 **실제 노트보다 먼저** 그린다 — 뒤에 깔려야 한다.
            표시 전용 고스트는 `pointer-events-none` 이라 클릭이 통과해 그 자리에
            음을 찍을 수 있다. 편집 가능한 고스트는 실제 노트와 같은 핸들러를 쓴다
          */}
          {ghosts.map((ghostTrack) => ghostTrack.notes.map((ghost) => {
            const top = midiToTop(ghost.note.pitch.midi);
            if (top === null) return null;
            const selected = selection.includes(ghost.note.id);
            const common = {
              top: top + 1,
              left: tickToLeft(ghost.startTick),
              width: Math.max(4, ghost.lengthTick * pxPerTick - 1),
              height: ROW_HEIGHT - 2,
            };
            const title = `${ghostTrack.name} · ${pitchName(ghost.note.pitch)}`;

            if (!ghost.editable) {
              return (
                <div
                  key={ghost.note.id}
                  title={title}
                  style={common}
                  className="pointer-events-none absolute rounded-[3px] border border-neutral-500/40 bg-neutral-400/15"
                />
              );
            }
            return (
              <div
                key={ghost.note.id}
                role="button"
                tabIndex={-1}
                title={`${title} (편집 가능)`}
                onPointerDown={(e) => beginDrag(e, ghost.note.id, 'move', ghost.note.pitch.midi)}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                style={common}
                className={`absolute flex items-center rounded-[3px] border border-dashed text-[9px] ${
                  selected
                    ? 'border-violet-200 bg-violet-300/80'
                    : 'border-violet-400/70 bg-violet-500/30'
                }`}
              >
                <span
                  onPointerDown={(e) => beginDrag(e, ghost.note.id, 'resize', ghost.note.pitch.midi)}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize rounded-r-[3px] bg-black/25"
                />
              </div>
            );
          }))}

          {clip.notes.map((note) => {
            const top = midiToTop(note.pitch.midi);
            // 접혔거나 음역 밖이면 줄이 없다
            if (top === null) return null;
            const selected = selection.includes(note.id);
            const edited = isPitchEdited(note);
            return (
              <div
                key={note.id}
                role="button"
                tabIndex={-1}
                title={`${pitchName(note.pitch)}${note.pitch.cents ? ` ${note.pitch.cents.toFixed(1)}¢` : ''}`}
                onPointerDown={(e) => beginDrag(e, note.id, 'move', note.pitch.midi)}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                style={{
                  top: top + 1,
                  left: tickToLeft(note.startTick),
                  width: Math.max(4, note.lengthTick * pxPerTick - 1),
                  height: ROW_HEIGHT - 2,
                  ...(!selected && colorMode !== 'edit' ? noteFill(note, colorMode) : {}),
                }}
                className={`absolute flex items-center rounded-[3px] border text-[9px] ${
                  selected
                    ? 'border-acc-2 bg-acc text-acc-ink'
                    : colorMode !== 'edit'
                      ? 'text-screen'
                      : edited
                      // 음정을 손본 음 — 트랙 색 2(따뜻한 색)로 구분한다
                      ? 'border-t2 bg-t2/85 text-screen'
                      : 'border-t3 bg-t3/70 text-sink'
                }`}
              >
                <span
                  onPointerDown={(e) => beginDrag(e, note.id, 'resize', note.pitch.midi)}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize rounded-r-[3px] bg-black/25"
                />
              </div>
            );
          })}

          {/* 범위 선택 사각형 */}
          {marqueeBox && (
            <div
              style={marqueeBox}
              className="pointer-events-none absolute z-20 border border-teal-300/80 bg-teal-300/10"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 세기·음이름 색칠 — 색은 테마 토큰에서만 가져온다 (색값을 직접 쓰면 테마를 바꿀 때 어긋난다) */
function noteFill(note: { velocity: number; pitch: { midi: number } }, mode: NoteColorMode): React.CSSProperties {
  if (mode === 'velocity') {
    const pct = Math.round(25 + note.velocity * 75);
    return { backgroundColor: `color-mix(in srgb, var(--color-acc) ${pct}%, var(--color-screen))`, borderColor: 'var(--color-acc-2)' };
  }
  const pc = ((note.pitch.midi % 12) + 12) % 12;
  const token = PITCH_TOKENS[(pc * 7) % 12 % 6]!;
  return { backgroundColor: `color-mix(in srgb, var(--color-${token}) 85%, transparent)`, borderColor: `var(--color-${token})` };
}

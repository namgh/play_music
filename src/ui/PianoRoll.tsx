import { useCallback, useRef, useState } from 'react';

import type { Clip, NoteId, Project } from '../model/project.ts';
import { isPitchEdited } from '../model/project.ts';
import { PPQ, ticksPerBar, quantize } from '../model/time.ts';
import { NOTE_NAMES, pitchName } from '../model/pitch.ts';
import { addNote, moveNotes, resizeNotes } from '../editor/edits.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';

/**
 * 피아노롤. 시안은 `mockup/studio-v2.html` 의 "음 편집기".
 *
 * 좌표 변환을 한 곳에 모아 둔다 — 픽셀↔틱 계산이 이벤트 핸들러마다 흩어지면
 * 줌을 넣는 순간 전부 어긋난다.
 */

const ROW_HEIGHT = 15;
const PX_PER_BEAT = 56;
const MIN_NOTE_TICKS = PPQ / 16;

export interface PianoRollProps {
  editor: ProjectEditor;
  clip: Clip;
  /** 표시할 음역 */
  range: { low: number; high: number };
  gridTicks: number;
  /** 재생 위치 (틱). null 이면 표시하지 않는다 */
  playheadTick: number | null;
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
}

const isBlackKey = (midi: number) => NOTE_NAMES[((midi % 12) + 12) % 12]!.includes('#');

export function PianoRoll({
  editor, clip, range, gridTicks, playheadTick, onAudition,
}: PianoRollProps) {
  const { project, selection } = editor;
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const rows: number[] = [];
  for (let midi = range.high; midi >= range.low; midi--) rows.push(midi);

  const pxPerTick = PX_PER_BEAT / PPQ;
  const width = clip.lengthTick * pxPerTick;
  const height = rows.length * ROW_HEIGHT;

  const midiToTop = (midi: number) => (range.high - midi) * ROW_HEIGHT;
  const tickToLeft = (tick: number) => tick * pxPerTick;

  /** 격자 위 클릭 좌표 → 틱·음 */
  const pointToCell = useCallback(
    (clientX: number, clientY: number) => {
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      return {
        tick: Math.max(0, quantize(x / pxPerTick, gridTicks)),
        midi: Math.max(range.low, Math.min(range.high, range.high - Math.floor(y / ROW_HEIGHT))),
      };
    },
    [gridTicks, pxPerTick, range.high, range.low],
  );

  const onGridPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== gridRef.current) return; // 노트를 눌렀으면 노트 핸들러가 처리한다
    const cell = pointToCell(event.clientX, event.clientY);
    if (!cell) return;

    const { project: next, noteId } = addNote(project, {
      clipId: clip.id,
      startTick: cell.tick,
      lengthTick: gridTicks,
      midi: cell.midi,
    });
    editor.commit(next);
    editor.select([noteId]);
    onAudition(cell.midi, 0);
  };

  const beginDrag = (
    event: React.PointerEvent<HTMLElement>,
    noteId: NoteId,
    mode: DragMode,
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    const ids = selection.includes(noteId) ? selection : [noteId];
    if (!selection.includes(noteId)) editor.select(ids);
    setDrag({ mode, ids, startX: event.clientX, startY: event.clientY, origin: project });
  };

  const onDragMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.mode === 'move') {
      const dTicks = quantize(dx / pxPerTick, gridTicks);
      const dSemis = -Math.round(dy / ROW_HEIGHT);
      if (dTicks === 0 && dSemis === 0) {
        editor.preview(drag.origin);
        return;
      }
      editor.preview(moveNotes(drag.origin, drag.ids, { ticks: dTicks, semitones: dSemis }));
    } else {
      const dTicks = quantize(dx / pxPerTick, gridTicks);
      editor.preview(resizeNotes(drag.origin, drag.ids, dTicks, MIN_NOTE_TICKS));
    }
  };

  const endDrag = () => {
    if (!drag) return;
    setDrag(null);
    // 드래그 전체를 언두 한 단계로 만든다
    editor.commitCurrent();
  };

  const barTicks = ticksPerBar(project.timeSignature);
  const barCount = Math.ceil(clip.lengthTick / barTicks);
  const gridLines: number[] = [];
  for (let t = 0; t <= clip.lengthTick; t += gridTicks) gridLines.push(t);

  return (
    <div className="flex overflow-auto rounded-lg border border-neutral-800 bg-neutral-950">
      {/* 건반 */}
      <div className="sticky left-0 z-20 shrink-0 border-r border-neutral-800 bg-neutral-950">
        <div className="h-6 border-b border-neutral-800" />
        {rows.map((midi) => (
          <button
            key={midi}
            type="button"
            onClick={() => onAudition(midi, 0)}
            style={{ height: ROW_HEIGHT }}
            className={`flex w-16 items-center justify-end border-b px-2 text-[9px] font-mono ${
              isBlackKey(midi)
                ? 'border-neutral-900 bg-neutral-900 text-neutral-500'
                : 'border-neutral-800 bg-neutral-200 text-neutral-700'
            }`}
          >
            {midi % 12 === 0 ? `C${Math.floor(midi / 12) - 1}` : ''}
          </button>
        ))}
      </div>

      <div>
        {/* 마디 눈금 */}
        <div className="sticky top-0 z-10 flex h-6 border-b border-neutral-800 bg-neutral-950" style={{ width }}>
          {Array.from({ length: barCount }, (_, i) => (
            <div
              key={i}
              style={{ width: barTicks * pxPerTick }}
              className="shrink-0 border-l border-neutral-800 pl-1 font-mono text-[10px] text-neutral-500"
            >
              {i + 1}
            </div>
          ))}
        </div>

        {/* 격자 */}
        <div
          ref={gridRef}
          onPointerDown={onGridPointerDown}
          style={{ width, height }}
          className="relative cursor-crosshair"
        >
          {rows.map((midi) => (
            <div
              key={midi}
              style={{ top: midiToTop(midi), height: ROW_HEIGHT }}
              className={`pointer-events-none absolute inset-x-0 border-b border-neutral-900 ${
                isBlackKey(midi) ? 'bg-neutral-900/40' : ''
              }`}
            />
          ))}
          {gridLines.map((tick) => (
            <div
              key={tick}
              style={{ left: tickToLeft(tick) }}
              className={`pointer-events-none absolute inset-y-0 w-px ${
                tick % barTicks === 0 ? 'bg-neutral-700' : 'bg-neutral-900'
              }`}
            />
          ))}

          {playheadTick !== null && playheadTick >= clip.startTick && (
            <div
              style={{ left: tickToLeft(playheadTick - clip.startTick) }}
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-teal-300"
            />
          )}

          {clip.notes.map((note) => {
            const selected = selection.includes(note.id);
            const edited = isPitchEdited(note);
            const outOfRange = note.pitch.midi < range.low || note.pitch.midi > range.high;
            if (outOfRange) return null;
            return (
              <div
                key={note.id}
                role="button"
                tabIndex={-1}
                title={`${pitchName(note.pitch)}${note.pitch.cents ? ` ${note.pitch.cents.toFixed(1)}¢` : ''}`}
                onPointerDown={(e) => beginDrag(e, note.id, 'move')}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                style={{
                  top: midiToTop(note.pitch.midi) + 1,
                  left: tickToLeft(note.startTick),
                  width: Math.max(4, note.lengthTick * pxPerTick - 1),
                  height: ROW_HEIGHT - 2,
                }}
                className={`absolute flex items-center rounded-[3px] border text-[9px] ${
                  selected
                    ? 'border-teal-200 bg-teal-300 text-teal-950'
                    : edited
                      ? 'border-amber-300/70 bg-amber-400/80 text-amber-950'
                      : 'border-teal-700 bg-teal-600/90 text-teal-50'
                }`}
              >
                <span
                  onPointerDown={(e) => beginDrag(e, note.id, 'resize')}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize rounded-r-[3px] bg-black/25"
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

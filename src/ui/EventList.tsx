import { useState } from 'react';

import type { Clip, Note, NoteId, Project } from '../model/project.ts';
import { barStartTick, positionAt } from '../model/meter.ts';
import { ticksPerBeat } from '../model/time.ts';
import { pitchName } from '../model/pitch.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { deleteNotes } from '../editor/edits.ts';
import { setNoteFields, transformNotes } from '../editor/noteTools.ts';
import type { Transform } from '../editor/noteTools.ts';

/**
 * 이벤트 목록 — 클립의 모든 음을 숫자로 (Logic Event List, `LOGIC_PARITY.md` 1-5).
 *
 * 위치는 "마디 박 틱" 셋으로 고친다 — 한 칸에 "3.2.120" 을 치게 하면 틀린 형식을
 * 어떻게 받을지가 문제가 된다. 칸이 나뉘어 있으면 틀릴 수가 없다.
 * 위에는 MIDI 변환 줄: 고른 음(없으면 전부)에 한 번에.
 */

export interface EventListProps {
  editor: ProjectEditor;
  clip: Clip;
  onAudition: (midi: number, cents: number) => void;
}

const CELL = 'h-7 w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-right font-num text-[14px] text-sink hover:border-grid-2 focus:border-acc focus:outline-none';
const TBTN = 'h-7 shrink-0 rounded-md border border-grid-2 bg-screen-2 px-2 text-[11px] text-sink hover:border-sink-3';

export function EventList({ editor, clip, onAudition }: EventListProps) {
  const { project, selection } = editor;
  const notes = [...clip.notes].sort((a, b) => a.startTick - b.startTick || a.pitch.midi - b.pitch.midi);
  // 이 클립에서 고른 음 — 다른 클립에서 고른 것은 이 목록의 변환 대상이 아니다
  const picked = selection.filter((id) => clip.notes.some((n) => n.id === id));
  const targets: NoteId[] = picked.length > 0 ? picked : notes.map((n) => n.id);
  const [axis, setAxis] = useState(60);

  const posOf = (note: Note) => positionAt(project, clip.startTick + note.startTick);
  const commitField = (note: Note, patch: Parameters<typeof setNoteFields>[2]) => editor.commit(setNoteFields(project, note.id, patch));
  const transform = (t: Transform) => editor.commit(transformNotes(project, targets, t));

  /** 마디·박·틱 칸 하나를 바꿨을 때 새 시작 틱 (클립 기준) */
  const moveTo = (note: Note, part: 'bar' | 'beat' | 'tick', value: number): Project => {
    const p = posOf(note);
    const beat = ticksPerBeat(p.timeSignature);
    const bar = part === 'bar' ? Math.max(1, Math.round(value)) - 1 : p.bar;
    const beatIn = part === 'beat' ? Math.max(1, Math.min(p.timeSignature.num, Math.round(value))) - 1 : p.beat;
    const tickIn = part === 'tick' ? Math.max(0, Math.min(beat - 1, Math.round(value))) : p.tickInBeat;
    // 다른 마디로 가면 그 마디의 박자를 쓴다 — 박자 변화가 있으면 박 길이가 다르다
    const barTick = bar === p.bar ? p.barTick : barStartTick(project, bar);
    const songTick = barTick + beatIn * beat + tickIn;
    return setNoteFields(project, note.id, { startTick: songTick - clip.startTick });
  };

  return (
    <div className="flex min-h-[11rem] flex-1 flex-col overflow-hidden rounded-xl bg-screen" data-event-list>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-grid px-3 py-2">
        <span className="text-[11px] text-sink-2">변환 · {picked.length > 0 ? `고른 ${picked.length}개` : `전부 ${notes.length}개`}</span>
        <button type="button" className={TBTN} onClick={() => transform({ kind: 'transpose', semitones: 12 })}>+옥타브</button>
        <button type="button" className={TBTN} onClick={() => transform({ kind: 'transpose', semitones: -12 })}>−옥타브</button>
        <button type="button" className={TBTN} onClick={() => transform({ kind: 'velocity', mode: 'set', value: 0.8 })}>세기 100 으로</button>
        <button type="button" className={TBTN} onClick={() => transform({ kind: 'crescendo', from: 0.35, to: 0.95 })}>크레셴도</button>
        <button type="button" className={TBTN} onClick={() => transform({ kind: 'crescendo', from: 0.95, to: 0.35 })}>디크레셴도</button>
        <button type="button" className={TBTN} onClick={() => transform({ kind: 'length', mode: 'scale', value: 0.5 })}>길이 ½</button>
        <button type="button" className={TBTN} onClick={() => transform({ kind: 'length', mode: 'scale', value: 2 })}>길이 ×2</button>
        <button type="button" className={TBTN} onClick={() => transform({ kind: 'reverse' })}>거꾸로</button>
        <span className="flex items-center gap-1">
          <button type="button" className={TBTN} onClick={() => transform({ kind: 'invert', axis })}>음높이 뒤집기</button>
          <input aria-label="뒤집기 축" type="number" min={0} max={127} value={axis} onChange={(e) => setAxis(Number(e.target.value))}
            className="h-7 w-14 rounded border border-grid-2 bg-screen-2 px-1 text-right font-num text-[13px] text-sink" title="이 음을 축으로 뒤집는다 (60 = C4)" />
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed border-collapse text-sink">
          <thead className="sticky top-0 bg-screen text-[10px] text-sink-3">
            <tr className="border-b border-grid">
              <th className="w-10 py-1.5 font-normal">#</th>
              <th className="w-16 font-normal">마디</th>
              <th className="w-14 font-normal">박</th>
              <th className="w-16 font-normal">틱</th>
              <th className="w-16 font-normal">음</th>
              <th className="w-16 font-normal">MIDI</th>
              <th className="w-16 font-normal">센트</th>
              <th className="w-20 font-normal">길이(틱)</th>
              <th className="w-16 font-normal">세기</th>
              <th className="w-10 font-normal" />
            </tr>
          </thead>
          <tbody>
            {notes.map((note, i) => {
              const p = posOf(note);
              const selected = selection.includes(note.id);
              return (
                <tr
                  key={note.id}
                  data-note-row={i}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).tagName === 'INPUT') return;
                    if (e.shiftKey) editor.toggleSelect(note.id); else editor.select([note.id]);
                    onAudition(note.pitch.midi, note.pitch.cents);
                  }}
                  className={`border-b border-grid/60 ${selected ? 'bg-acc/20' : 'hover:bg-screen-2'}`}
                >
                  <td className="text-center font-num text-[12px] text-sink-3">{i + 1}</td>
                  <td><NumCell value={p.bar + 1} label="마디" onCommit={(v) => editor.commit(moveTo(note, 'bar', v))} /></td>
                  <td><NumCell value={p.beat + 1} label="박" onCommit={(v) => editor.commit(moveTo(note, 'beat', v))} /></td>
                  <td><NumCell value={p.tickInBeat} label="틱" onCommit={(v) => editor.commit(moveTo(note, 'tick', v))} /></td>
                  <td className="text-center font-num text-[14px]">{pitchName(note.pitch)}</td>
                  <td><NumCell value={note.pitch.midi} label="MIDI" onCommit={(v) => commitField(note, { midi: v })} /></td>
                  <td><NumCell value={Math.round(note.pitch.cents * 10) / 10} label="센트" step={0.1} onCommit={(v) => commitField(note, { cents: v })} /></td>
                  <td><NumCell value={note.lengthTick} label="길이" onCommit={(v) => commitField(note, { lengthTick: v })} /></td>
                  <td><NumCell value={Math.round(note.velocity * 127)} label="세기" onCommit={(v) => commitField(note, { velocity: v / 127 })} /></td>
                  <td className="text-center">
                    <button type="button" aria-label={`${i + 1}번 음 지우기`} onClick={() => editor.commit(deleteNotes(project, [note.id]))}
                      className="text-[11px] text-sink-3 hover:text-rec">✕</button>
                  </td>
                </tr>
              );
            })}
            {notes.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-4 text-xs text-sink-3">이 클립에 음이 없습니다 — 피아노 롤에서 찍거나 건반으로 스텝 입력하세요</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 숫자 칸 — 엔터나 칸을 떠날 때 확정한다 (치는 동안 매 글자 언두가 쌓이지 않게) */
function NumCell({ value, label, step = 1, onCommit }: { value: number; label: string; step?: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (Number.isFinite(v) && v !== value) onCommit(v);
  };
  return (
    <input
      aria-label={label}
      type="number"
      step={step}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setDraft(null); }}
      className={`${CELL} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none`}
    />
  );
}

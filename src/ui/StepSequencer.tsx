import { useState } from 'react';

import type { Clip, Project, Track } from '../model/project.ts';
import { INSTRUMENT_CATALOG } from '../instruments/definitions.ts';
import { pitchName } from '../model/pitch.ts';
import { PPQ } from '../model/time.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { setVelocity } from '../editor/edits.ts';
import { clipCovering, ensureClipFor, setRatchet, stepRow, toggleStep } from '../editor/steps.ts';

/**
 * 스텝 시퀀서 보기 (Logic Step Sequencer, `LOGIC_PARITY.md` 1-5) — `steps.ts` 의 설명대로
 * 칸 = 음이다. 드럼 트랙을 고르면 **줄 = 드럼 트랙들**(킥·스네어·하이햇이 한 판에),
 * 선율 트랙이면 **줄 = 음높이**.
 *
 * 누르기 = 켜기/끄기 · Alt+누르기 = 강세(세기 100/60) · Shift+누르기 = 래칫 1→2→3→4
 */

const RATES = [
  { label: '1/8', ticks: PPQ / 2 },
  { label: '1/16', ticks: PPQ / 4 },
  { label: '1/32', ticks: PPQ / 8 },
  { label: '1/16 셋잇단', ticks: PPQ / 6 },
];
const isDrum = (t: Track) => INSTRUMENT_CATALOG.find((e) => e.id === t.instrumentId)?.category === '드럼';

/** 드럼 트랙이 쓰는 음높이 — 이미 찍힌 음 중 가장 흔한 것, 없으면 가운데 도 */
function drumPitch(track: Track): number {
  const counts = new Map<number, number>();
  for (const c of track.clips) for (const n of c.notes) counts.set(n.pitch.midi, (counts.get(n.pitch.midi) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 60;
}

export interface StepSequencerProps {
  editor: ProjectEditor;
  track: Track;
  clip: Clip;
  /** 재생 헤드 (곡 기준 틱) */
  playheadTick: number | null;
  onAudition: (trackId: Track['id'], midi: number) => void;
}

export function StepSequencer({ editor, track, clip, playheadTick, onAudition }: StepSequencerProps) {
  const { project } = editor;
  const [rate, setRate] = useState(PPQ / 4);
  const [gate, setGate] = useState(0.5);
  const steps = Math.max(1, Math.min(64, Math.floor(clip.lengthTick / rate)));
  const drumMode = isDrum(track);

  // 줄 목록
  type Row = { key: string; label: string; track: Track; clip: Clip | null; midi: number; anyPitch: boolean };
  const rows: Row[] = drumMode
    ? project.tracks.filter(isDrum).map((t) => ({
      key: t.id, label: t.name, track: t, clip: clipCovering(t, clip.startTick, clip.lengthTick), midi: drumPitch(t), anyPitch: true,
    }))
    : (() => {
      const used = clip.notes.map((n) => n.pitch.midi);
      const center = used.length ? Math.round(used.reduce((a, b) => a + b, 0) / used.length) : 60;
      const top = Math.min(127, Math.max(used.length ? Math.max(...used) : 0, center + 6));
      return Array.from({ length: 13 }, (_, i) => top - i).filter((m) => m >= 0).map((midi) => ({
        key: String(midi), label: pitchName({ midi, cents: 0 }), track, clip, midi, anyPitch: false,
      }));
    })();

  const cursorStep = playheadTick === null ? -1 : Math.floor((playheadTick - clip.startTick) / rate);

  const press = (row: Row, step: number, e: React.MouseEvent) => {
    let p: Project = project;
    let clipId = row.clip?.id;
    if (!clipId) {
      const made = ensureClipFor(p, row.track.id, clip.startTick, clip.lengthTick);
      p = made.project;
      clipId = made.clipId;
    }
    const target = p.tracks.find((t) => t.id === row.track.id)!.clips.find((c) => c.id === clipId)!;
    const cell = stepRow(target, row.anyPitch ? null : row.midi, rate, steps)[step]!;
    if (e.shiftKey && cell.note) {
      editor.commit(setRatchet(p, clipId, step, rate, row.anyPitch ? null : row.midi, (cell.count % 4) + 1));
      return;
    }
    if (e.altKey && cell.note) {
      editor.commit(setVelocity(p, [cell.note.id], cell.note.velocity >= 0.95 ? 0.6 : 1));
      return;
    }
    const r = toggleStep(p, clipId, { midi: row.midi, step, rate, velocity: 0.8, gate, anyPitch: row.anyPitch });
    editor.commit(r.project);
    if (r.on) onAudition(row.track.id, row.midi);
  };

  return (
    <div className="flex min-h-[11rem] flex-1 flex-col overflow-hidden rounded-xl bg-screen" data-step-sequencer>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-grid px-3 py-2 text-[11px] text-sink-2">
        <span>{drumMode ? `드럼 판 — 드럼 트랙 ${rows.length}개` : `${track.name} — 음높이 줄`}</span>
        <span className="text-sink-3">· 누르기 켜기/끄기 · Alt 강세 · Shift 래칫</span>
        <span className="flex-1" />
        <label className="flex items-center gap-1">칸
          <select aria-label="스텝 단위" value={rate} onChange={(e) => setRate(Number(e.target.value))}
            className="h-7 rounded border border-grid-2 bg-screen-2 px-1 text-[11px] text-sink">
            {RATES.map((r) => <option key={r.label} value={r.ticks}>{r.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">게이트
          <input aria-label="게이트" type="range" min={0.1} max={1} step={0.05} value={gate} onChange={(e) => setGate(Number(e.target.value))} className="w-20 accent-acc" />
          <span className="w-8 font-num text-[13px] text-sink">{Math.round(gate * 100)}%</span>
        </label>
        <span className="font-num text-[13px] text-sink">{steps}칸</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="grid gap-y-1" style={{ gridTemplateColumns: `7rem repeat(${steps}, minmax(18px, 1fr))` }}>
          {rows.map((row) => {
            const cells = row.clip ? stepRow(row.clip, row.anyPitch ? null : row.midi, rate, steps) : Array.from({ length: steps }, () => ({ note: null, count: 0 }));
            return [
              <div key={`${row.key}-label`} className="flex items-center truncate pr-2 text-[12px] text-sink" data-step-row={row.label}>{row.label}</div>,
              ...cells.map((cell, i) => {
                const beatStart = i % Math.round(PPQ / rate) === 0;
                const v = cell.note?.velocity ?? 0;
                return (
                  <button
                    key={`${row.key}-${i}`}
                    type="button"
                    aria-label={`${row.label} ${i + 1}칸${cell.note ? ' 켜짐' : ''}`}
                    aria-pressed={cell.note !== null}
                    onClick={(e) => press(row, i, e)}
                    style={cell.note ? { opacity: 0.45 + v * 0.55 } : undefined}
                    className={`relative mx-px h-7 rounded-sm ${
                      cell.note ? 'bg-acc' : beatStart ? 'bg-grid-2 hover:bg-sink-3' : 'bg-grid hover:bg-sink-3'
                    } ${i === cursorStep ? 'ring-1 ring-sink' : ''}`}
                  >
                    {cell.count > 1 && <span className="absolute inset-0 flex items-center justify-center font-num text-[11px] text-acc-ink">{cell.count}</span>}
                  </button>
                );
              }),
            ];
          })}
        </div>
      </div>
    </div>
  );
}

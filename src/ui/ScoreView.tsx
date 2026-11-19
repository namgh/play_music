import { useMemo, useRef, useState } from 'react';

import type { Clip, NoteId, Project, Track } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { addNote, deleteNotes, moveNotes } from '../editor/edits.ts';
import { INSTRUMENT_CATALOG } from '../instruments/definitions.ts';
import { barStartTick, positionAt } from '../model/meter.ts';
import { chooseClef, dynamicMarks, GRID, keyFifths, midiFromDiatonic, notate, splitGrandStaff, toMusicXml, wantsGrandStaff } from '../model/notation.ts';
import { setNoteMarks } from '../editor/noteTools.ts';
import type { Measure, NEvent, Spelled, Step } from '../model/notation.ts';
import { chordLabel } from '../model/chords.ts';
import { PPQ } from '../model/time.ts';

/**
 * 악보 보기 (Logic Score Editor, `LOGIC_PARITY.md` 1-5) — `notation.ts` 의 결과를 SVG 로 그린다.
 * 한 줄에 네 마디, 코드 트랙의 코드를 마디 위에. MusicXML 로 내보내면 Logic·MuseScore 가 읽는다.
 *
 * 기호는 유니코드 음악 기호(𝄞 𝄢 𝄽 …)를 쓴다 — 악보 글꼴을 따로 싣지 않는다.
 */

const GAP = 8;          // 오선 줄 간격
const STAFF = GAP * 4;
const PER_LINE = 4;
const SYSTEM_H = 112;
const MUSIC_FONT = '"Apple Symbols", "Noto Music", "Segoe UI Symbol", serif';
const STEP_INDEX: Record<Step, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/** 오선 맨 아래 줄 음의 diatonic 번호 (높은음: E4, 낮은음: G2) */
const BOTTOM = { treble: 4 * 7 + 2, bass: 2 * 7 + 4 };
const diatonic = (p: Spelled) => p.octave * 7 + STEP_INDEX[p.step];

const SHARP_POS = { treble: [8, 5, 9, 6, 3, 7, 4], bass: [6, 3, 7, 4, 1, 5, 2] };
const FLAT_POS = { treble: [4, 7, 3, 6, 2, 5, 1], bass: [2, 5, 1, 4, 0, 3, -1] };

export interface ScoreViewProps {
  project: Project;
  track: Track;
  clip: Clip;
  /** 있으면 악보에서 고친다 (`PARITY_ROUND2.md` 13) — 없으면 보기만 */
  editor?: ProjectEditor | undefined;
  /** 악보에서 넣는 음 길이 (틱) */
  noteLength?: number | undefined;
  onAudition?: ((midi: number) => void) | undefined;
}

type Clef = 'treble' | 'bass';

export function ScoreView({ project, track, clip, editor, noteLength = PPQ, onAudition }: ScoreViewProps) {
  const category = INSTRUMENT_CATALOG.find((e) => e.id === track.instrumentId)?.category;
  // 베이스는 소리보다 한 옥타브 **높게** 적는 악기다 (기보 관례) — 안 그러면 덧줄 투성이
  const written = category === '베이스' ? 12 : 0;
  const shown = useMemo(() => (written ? clip.notes.map((n) => ({ ...n, pitch: { ...n.pitch, midi: n.pitch.midi + written } })) : clip.notes), [clip.notes, written]);
  // 큰보표 — 피아노이거나 음역이 넓으면 높은음·낮은음 두 줄, 가운데 도에서 나눈다
  const grand = !written && wantsGrandStaff(shown, category === '피아노');
  const fromBar = positionAt(project, clip.startTick).bar;
  const toBar = positionAt(project, Math.max(clip.startTick, clip.startTick + clip.lengthTick - 1)).bar;
  // 성부 — 둘째 성부(voice 2)는 따로 적어 기둥을 아래로 그린다 (`PARITY_ROUND2.md` 22)
  const staves = useMemo((): { clef: Clef; measures: Measure[]; voice2: Measure[] | null }[] => {
    const bars = toBar - fromBar + 1;
    const make = (clef: Clef, notes: typeof shown) => {
      const v1 = notes.filter((n) => n.voice !== 2);
      const v2 = notes.filter((n) => n.voice === 2);
      return {
        clef,
        measures: notate(project, v1, clip.startTick, fromBar, bars),
        voice2: v2.length > 0 ? notate(project, v2, clip.startTick, fromBar, bars) : null,
      };
    };
    if (grand) {
      const parts = splitGrandStaff(shown);
      return [make('treble', parts.treble), make('bass', parts.bass)];
    }
    return [make(chooseClef(shown), shown)];
  }, [project, shown, clip.startTick, fromBar, toBar, grand]);
  const dynamics = useMemo(() => dynamicMarks(clip.notes, clip.startTick), [clip.notes, clip.startTick]);
  const fifths = keyFifths(project.key);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const exportXml = () => {
    // 드럼을 뺀 트랙 전부 — 각 트랙 클립들을 곡 전체 마디로
    const parts = project.tracks
      .filter((t) => INSTRUMENT_CATALOG.find((e) => e.id === t.instrumentId)?.category !== '드럼')
      .map((t) => {
        const notes = t.clips.flatMap((c) => c.notes.map((n) => ({ ...n, startTick: c.startTick + n.startTick })));
        return { name: t.name, clef: chooseClef(notes), measures: notate(project, notes, 0, 0, project.lengthBars), dynamics: dynamicMarks(notes, 0) };
      });
    const blob = new Blob([toMusicXml(project, parts)], { type: 'application/vnd.recordare.musicxml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name || 'score'}.musicxml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const print = () => {
    const svg = document.querySelector('[data-score] svg')?.outerHTML;
    if (!svg) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${project.name} — ${track.name}</title><style>body{margin:24px;font-family:system-ui}h1{font-size:20px}svg{width:100%;height:auto}</style><h1>${project.name} · ${track.name}</h1>${svg}`);
    w.document.close();
    w.focus();
    w.print();
  };

  const measureCount = staves[0]!.measures.length;
  const lineCount = Math.ceil(measureCount / PER_LINE);
  const STAFF_GAP = 56; // 큰보표 두 줄 사이 (가사·셈여림 자리)
  const systemH = (grand ? SYSTEM_H + STAFF + STAFF_GAP : SYSTEM_H) + 18;
  const width = 1000;
  const head = 80;
  const mw = (width - head - 10) / PER_LINE;
  const staffTop = (line: number, staff: number) => 30 + line * systemH + staff * (STAFF + STAFF_GAP);
  const yOfClef = (clef: Clef) => (p: Spelled, top: number) => top + STAFF - (diatonic(p) - BOTTOM[clef]) * (GAP / 2);
  const measureX = (mi: number) => head + mi * mw;
  const lenOf = (m: Measure) => m.timeSignature.num * (PPQ * 4) / m.timeSignature.den;
  const xIn = (mi: number, m: Measure, offset: number) => measureX(mi) + 14 + (offset / lenOf(m)) * (mw - 24);

  // --- 편집 ---
  const svgRef = useRef<SVGSVGElement | null>(null);
  const toSvg = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM()!.inverse());
  };
  const onStaffDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!editor || (e.target as Element).closest('[data-note-head]')) return;
    const { x, y } = toSvg(e);
    const line = Math.floor((y - 10) / systemH);
    if (line < 0 || line >= lineCount) return;
    // 가까운 오선 (큰보표면 둘 중)
    const staffIndex = staves.length === 2 && y > staffTop(line, 0) + STAFF + STAFF_GAP / 2 ? 1 : 0;
    const top = staffTop(line, staffIndex);
    const clef = staves[staffIndex]!.clef;
    const mi = Math.floor((x - head) / mw);
    const m = staves[staffIndex]!.measures[line * PER_LINE + mi];
    if (mi < 0 || mi >= PER_LINE || !m) { setSelected(new Set()); return; }
    const len = lenOf(m);
    const offset = Math.max(0, Math.min(len - GRID, Math.round((((x - measureX(mi) - 14) / (mw - 24)) * len) / GRID) * GRID));
    const d = BOTTOM[clef] + Math.round((top + STAFF - y) / (GAP / 2));
    const midi = midiFromDiatonic(d, fifths) - written;
    const tick = barStartTick(project, m.index) + offset - clip.startTick;
    if (tick < 0 || tick >= clip.lengthTick || midi < 0 || midi > 127) return;
    try {
      const r = addNote(project, { clipId: clip.id, startTick: tick, lengthTick: Math.min(noteLength, clip.lengthTick - tick), midi });
      editor.commit(r.project);
      setSelected(new Set([r.noteId]));
      onAudition?.(midi);
    } catch { /* 클립 밖 */ }
  };
  const pick = (id: string, add: boolean) => setSelected((cur) => { const n = new Set(add ? cur : []); if (add && n.has(id)) n.delete(id); else n.add(id); return n; });
  const onKey = (e: React.KeyboardEvent) => {
    if (!editor || selected.size === 0) return;
    const ids = [...selected] as NoteId[];
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      editor.commit(deleteNotes(project, ids));
      setSelected(new Set());
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const semis = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      editor.commit(moveNotes(project, ids, { semitones: semis }));
      const n = clip.notes.find((x) => x.id === ids[0]);
      if (n) onAudition?.(n.pitch.midi + semis);
    } else if (e.key === 'Escape') {
      setSelected(new Set());
    }
  };

  return (
    <div className="flex min-h-[11rem] flex-1 flex-col overflow-hidden rounded-xl border border-rule bg-body" data-score>
      <div className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
        <span className="text-[11px] text-ink-3">{track.name} · {grand ? '큰보표' : staves[0]!.clef === 'bass' ? '낮은음자리표' : '높은음자리표'}{written ? ' · 한 옥타브 위로 적음(베이스 기보)' : ''} · {measureCount}마디{editor ? ' · 오선을 누르면 음 · 음을 누르고 ↑↓(Shift 옥타브)·Delete' : ''}</span>
        <span className="flex-1" />
        {editor && selected.size > 0 && (
          <div className="flex items-center gap-1" data-score-marks>
            {([['staccato', '·', '스타카토 (반 길이)'], ['accent', '>', '액센트 (세게)'], ['tenuto', '–', '테누토 (꽉 채워)'], ['marcato', '^', '마르카토 (세고 짧게)']] as const).map(([a, sym, label]) => (
              <button key={a} type="button" title={label} aria-label={label}
                onClick={() => editor.commit(setNoteMarks(project, [...selected] as NoteId[], { articulation: a }))}
                className="h-7 w-7 rounded-md border border-rule bg-panel text-sm text-ink hover:border-ink-3">{sym}</button>
            ))}
            <button type="button" title="기호 지우기" onClick={() => editor.commit(setNoteMarks(project, [...selected] as NoteId[], { articulation: null }))}
              className="h-7 rounded-md border border-rule bg-panel px-1.5 text-[11px] text-ink-2">기호 ✕</button>
            <button type="button" title="둘째 성부로 (기둥 아래) / 다시 첫째로" aria-label="성부 바꾸기"
              onClick={() => {
                const ids = [...selected] as NoteId[];
                const two = clip.notes.filter((n) => ids.includes(n.id)).every((n) => n.voice === 2);
                editor.commit(setNoteMarks(project, ids, { voice: two ? 1 : 2 }));
              }}
              className="h-7 rounded-md border border-rule bg-panel px-1.5 text-[11px] text-ink">성부 1↔2</button>
            <input aria-label="가사" placeholder="가사" defaultValue={selected.size === 1 ? clip.notes.find((n) => selected.has(n.id))?.lyric ?? '' : ''}
              key={[...selected].join()}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { editor.commit(setNoteMarks(project, [...selected] as NoteId[], { lyric: (e.target as HTMLInputElement).value })); (e.target as HTMLInputElement).blur(); } }}
              className="h-7 w-20 rounded-md border border-rule bg-panel px-1.5 text-xs text-ink" />
          </div>
        )}
        <button type="button" onClick={exportXml} className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3"
          title="드럼을 뺀 모든 트랙을 MusicXML 로 — Logic·MuseScore·Sibelius 가 읽습니다">MusicXML 내보내기</button>
        <button type="button" onClick={print} className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3">인쇄</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-white p-4 outline-none" tabIndex={0} onKeyDown={onKey}>
        <svg ref={svgRef} viewBox={`0 0 ${width} ${lineCount * systemH + 20}`} className={`w-full ${editor ? 'cursor-crosshair' : ''}`} style={{ minWidth: 720 }}
          role="img" aria-label={`${track.name} 악보`} onPointerDown={onStaffDown}>
          {Array.from({ length: lineCount }, (_, li) => {
            const lineMeasures = staves[0]!.measures.slice(li * PER_LINE, li * PER_LINE + PER_LINE);
            const lineEnd = head + lineMeasures.length * mw;
            const firstTop = staffTop(li, 0);
            const lastTop = staffTop(li, staves.length - 1);
            return (
              <g key={li}>
                {/* 큰보표: 두 줄을 왼쪽 세로줄과 묶음표로 */}
                {staves.length === 2 && (
                  <g>
                    <line x1={10} x2={10} y1={firstTop} y2={lastTop + STAFF} stroke="#0A0A0B" strokeWidth={1.4} />
                    <path d={`M 6 ${firstTop} L 2 ${firstTop} L 2 ${lastTop + STAFF} L 6 ${lastTop + STAFF}`} fill="none" stroke="#0A0A0B" strokeWidth={2.4} data-brace />
                  </g>
                )}
                {staves.map((staff, si) => {
                  const top = staffTop(li, si);
                  const clef = staff.clef;
                  const yOf = yOfClef(clef);
                  return (
                    <g key={si} data-staff={clef}>
                      {[0, 1, 2, 3, 4].map((k) => <line key={k} x1={10} x2={lineEnd} y1={top + k * GAP} y2={top + k * GAP} stroke="#0A0A0B" strokeWidth={0.8} />)}
                      <text x={12} y={clef === 'treble' ? top + STAFF + 6 : top + 22} fontSize={clef === 'treble' ? 44 : 30} fontFamily={MUSIC_FONT}>{clef === 'treble' ? '𝄞' : '𝄢'}</text>
                      {/* 조표 */}
                      {(fifths > 0 ? SHARP_POS : FLAT_POS)[clef].slice(0, Math.abs(fifths)).map((pos, k) => (
                        <text key={k} x={40 + k * 7} y={top + STAFF - pos * (GAP / 2) + 4} fontSize={14} fontFamily={MUSIC_FONT}>{fifths > 0 ? '♯' : '♭'}</text>
                      ))}
                      {staff.measures.slice(li * PER_LINE, li * PER_LINE + PER_LINE).map((m, mi) => {
                        const x0 = measureX(mi);
                        const chords = si === 0 ? (project.chords ?? []).filter((c) => positionAt(project, c.tick).bar === m.index) : [];
                        return (
                          <g key={m.index} data-measure={m.index + 1}>
                            <line x1={x0 + mw} x2={x0 + mw} y1={staves.length === 2 ? firstTop : top} y2={staves.length === 2 ? lastTop + STAFF : top + STAFF} stroke="#0A0A0B" strokeWidth={si === 0 ? 1 : 0} />
                            {si === 0 && <text x={x0 + 2} y={top - 14} fontSize={9} fill="#71717A">{m.index + 1}</text>}
                            {li === 0 && mi === 0 && (
                              <g fontFamily="Georgia, serif" fontWeight="bold" fontSize={17}>
                                <text x={x0 - 18} y={top + 15} textAnchor="middle">{m.timeSignature.num}</text>
                                <text x={x0 - 18} y={top + 31} textAnchor="middle">{m.timeSignature.den}</text>
                              </g>
                            )}
                            {chords.map((c) => {
                              const off = c.tick - positionAt(project, c.tick).barTick;
                              return <text key={c.id} x={xIn(mi, m, off)} y={top - 4} fontSize={12} fontWeight={600} fill="#0A0A0B">{chordLabel(c)}</text>;
                            })}
                            {m.events.map((e, ei) => (
                              <Glyph key={ei} e={e} x={xIn(mi, m, e.offset)} top={top} yOf={yOf}
                                next={m.events[ei + 1] ? xIn(mi, m, m.events[ei + 1]!.offset) : x0 + mw - 2}
                                selected={selected}
                                stem={staff.voice2 ? 'up' : undefined}
                                onPick={editor ? pick : undefined} />
                            ))}
                            {/* 둘째 성부 — 음만 (쉼표는 생략), 기둥 아래 */}
                            {staff.voice2?.[li * PER_LINE + mi]?.events.filter((e) => e.kind === 'note').map((e, ei) => (
                              <Glyph key={`v2-${ei}`} e={e} x={xIn(mi, m, e.offset) + 3} top={top} yOf={yOf}
                                next={x0 + mw - 2} selected={selected} stem="down" onPick={editor ? pick : undefined} />
                            ))}
                            {/* 가사 — 오선 아래 */}
                            {m.events.filter((e) => e.lyric).map((e, ei) => (
                              <text key={`ly-${ei}`} x={xIn(mi, m, e.offset)} y={top + STAFF + 26} fontSize={11} textAnchor="middle" fill="#0A0A0B" data-lyric>{e.lyric}</text>
                            ))}
                            {/* 셈여림 — 마지막 오선 아래, 세기에서 자동 */}
                            {si === staves.length - 1 && dynamics.filter((d) => d.tick >= barStartTick(project, m.index) && d.tick < barStartTick(project, m.index) + lenOf(m)).map((d) => (
                              <text key={`dy-${d.tick}`} x={xIn(mi, m, d.tick - barStartTick(project, m.index))} y={top + STAFF + 42} fontSize={13}
                                fontStyle="italic" fontWeight="bold" fontFamily="Georgia, serif" fill="#0A0A0B" data-dynamic>{d.mark}</text>
                            ))}
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** 음표·쉼표 하나 */
function Glyph({ e, x, top, yOf, next, selected, onPick, stem }: {
  e: NEvent; x: number; top: number; yOf: (p: Spelled, top: number) => number; next: number;
  selected?: Set<string>; onPick?: ((id: string, add: boolean) => void) | undefined;
  /** 성부가 둘이면 1 성부 위·2 성부 아래로 고정 */
  stem?: 'up' | 'down' | undefined;
}) {
  if (e.kind === 'rest') {
    // 쉼표는 도형으로 그린다 — 음악 기호 글꼴이 없는 환경(헤드리스·리눅스)에서 네모로 깨진다
    const m = top + 2 * GAP;
    if (e.type === 'whole') return <rect x={x - 5} y={top + GAP} width={10} height={4} fill="#0A0A0B" />;
    if (e.type === 'half') return <rect x={x - 5} y={m - 4} width={10} height={4} fill="#0A0A0B" />;
    if (e.type === 'quarter') {
      return <path d={`M ${x - 2} ${m - 11} l 5 6 l -4 4 l 5 6 q -6 -2 -4 5`} fill="none" stroke="#0A0A0B" strokeWidth={2} strokeLinejoin="round" />;
    }
    const n = e.type === 'eighth' ? 1 : 2;
    return (
      <g>
        <path d={`M ${x + 3} ${m - 6} L ${x - 1} ${m + 8 + (n - 1) * 6}`} stroke="#0A0A0B" strokeWidth={1.4} />
        {Array.from({ length: n }, (_, k) => (
          <g key={k}>
            <circle cx={x - 2} cy={m - 5 + k * 6} r={2.2} fill="#0A0A0B" />
            <path d={`M ${x - 2} ${m - 4 + k * 6} q 3 1 5 -2`} fill="none" stroke="#0A0A0B" strokeWidth={1.2} />
          </g>
        ))}
      </g>
    );
  }
  const ys = e.pitches.map((p) => yOf(p, top));
  const mid = top + 2 * GAP;
  const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
  const up = stem ? stem === 'up' : avg >= mid;
  const hollow = e.type === 'whole' || e.type === 'half';
  const stemX = up ? x + 5 : x - 5;
  const stemFrom = up ? Math.max(...ys) : Math.min(...ys);
  const stemTo = up ? Math.min(...ys) - 3.5 * GAP : Math.max(...ys) + 3.5 * GAP;
  const flags = e.type === 'eighth' ? 1 : e.type === '16th' ? 2 : 0;
  return (
    <g>
      {e.pitches.map((p, i) => {
        const y = ys[i]!;
        // 덧줄 — 오선 밖 음
        const ledgers: number[] = [];
        for (let ly = top + STAFF + GAP; ly <= y + 0.1; ly += GAP) ledgers.push(ly);
        for (let ly = top - GAP; ly >= y - 0.1; ly -= GAP) ledgers.push(ly);
        return (
          <g key={i}>
            {ledgers.map((ly) => <line key={ly} x1={x - 8} x2={x + 8} y1={ly} y2={ly} stroke="#0A0A0B" strokeWidth={0.8} />)}
            {p.accidental && <text x={x - 15} y={y + 4} fontSize={13} fontFamily={MUSIC_FONT}>{p.accidental === 'sharp' ? '♯' : p.accidental === 'flat' ? '♭' : '♮'}</text>}
            <ellipse cx={x} cy={y} rx={5.2} ry={3.8} transform={`rotate(-20 ${x} ${y})`}
              fill={selected?.has(e.ids?.[i] ?? '') ? '#F2B705' : hollow ? 'white' : '#0A0A0B'} stroke="#0A0A0B" strokeWidth={1.3}
              data-note-head={e.ids?.[i]}
              style={onPick ? { cursor: 'pointer' } : undefined}
              onPointerDown={onPick && e.ids?.[i] ? (ev) => { ev.stopPropagation(); onPick(e.ids![i]!, ev.shiftKey); } : undefined} />
            {e.dots === 1 && <circle cx={x + 9} cy={y - 1.5} r={1.4} fill="#0A0A0B" />}
            {e.tie && <path d={`M ${x + 4} ${y + (up ? 5 : -5)} Q ${(x + next) / 2} ${y + (up ? 11 : -11)} ${next - 4} ${y + (up ? 5 : -5)}`} fill="none" stroke="#0A0A0B" strokeWidth={1} />}
          </g>
        );
      })}
      {e.type !== 'whole' && <line x1={stemX} x2={stemX} y1={stemFrom} y2={stemTo} stroke="#0A0A0B" strokeWidth={1.1} />}
      {/* 아티큘레이션 — 기둥 반대쪽, 음머리 가까이 */}
      {e.articulation && (() => {
        const ay = up ? Math.max(...ys) + 10 : Math.min(...ys) - 10;
        const sym = e.articulation === 'staccato' ? null : e.articulation === 'accent' ? '>' : e.articulation === 'tenuto' ? '–' : '^';
        return sym === null
          ? <circle cx={x} cy={ay} r={1.6} fill="#0A0A0B" data-articulation="staccato" />
          : <text x={x} y={ay + 4} fontSize={13} fontWeight="bold" textAnchor="middle" fill="#0A0A0B" data-articulation={e.articulation}>{sym}</text>;
      })()}
      {Array.from({ length: flags }, (_, k) => (
        <path key={k} d={up
          ? `M ${stemX} ${stemTo + k * 6} q 7 4 6 13`
          : `M ${stemX} ${stemTo - k * 6} q 7 -4 6 -13`} fill="none" stroke="#0A0A0B" strokeWidth={1.6} />
      ))}
    </g>
  );
}

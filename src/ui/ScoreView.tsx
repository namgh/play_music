import { useMemo } from 'react';

import type { Clip, Project, Track } from '../model/project.ts';
import { INSTRUMENT_CATALOG } from '../instruments/definitions.ts';
import { positionAt } from '../model/meter.ts';
import { chooseClef, keyFifths, notate, toMusicXml } from '../model/notation.ts';
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
}

export function ScoreView({ project, track, clip }: ScoreViewProps) {
  // 베이스는 소리보다 한 옥타브 **높게** 적는 악기다 (기보 관례) — 안 그러면 덧줄 투성이
  const written = INSTRUMENT_CATALOG.find((e) => e.id === track.instrumentId)?.category === '베이스' ? 12 : 0;
  const shown = useMemo(() => (written ? clip.notes.map((n) => ({ ...n, pitch: { ...n.pitch, midi: n.pitch.midi + written } })) : clip.notes), [clip.notes, written]);
  const clef = chooseClef(shown);
  const fromBar = positionAt(project, clip.startTick).bar;
  const toBar = positionAt(project, Math.max(clip.startTick, clip.startTick + clip.lengthTick - 1)).bar;
  const measures = useMemo(
    () => notate(project, shown, clip.startTick, fromBar, toBar - fromBar + 1),
    [project, shown, clip.startTick, fromBar, toBar],
  );
  const fifths = keyFifths(project.key);

  const exportXml = () => {
    // 드럼을 뺀 트랙 전부 — 각 트랙 클립들을 곡 전체 마디로
    const parts = project.tracks
      .filter((t) => INSTRUMENT_CATALOG.find((e) => e.id === t.instrumentId)?.category !== '드럼')
      .map((t) => {
        const notes = t.clips.flatMap((c) => c.notes.map((n) => ({ ...n, startTick: c.startTick + n.startTick })));
        return { name: t.name, clef: chooseClef(notes), measures: notate(project, notes, 0, 0, project.lengthBars) };
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

  const lines: Measure[][] = [];
  for (let i = 0; i < measures.length; i += PER_LINE) lines.push(measures.slice(i, i + PER_LINE));
  const width = 1000;
  const head = 80;
  const mw = (width - head - 10) / PER_LINE;

  const yOf = (p: Spelled, top: number) => top + STAFF - (diatonic(p) - BOTTOM[clef]) * (GAP / 2);

  return (
    <div className="flex min-h-[11rem] flex-1 flex-col overflow-hidden rounded-xl border border-rule bg-body" data-score>
      <div className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
        <span className="text-[11px] text-ink-3">{track.name} · {clef === 'bass' ? '낮은음자리표' : '높은음자리표'}{written ? ' · 한 옥타브 위로 적음(베이스 기보)' : ''} · {measures.length}마디 · 16분 격자로 맞춰 그립니다</span>
        <span className="flex-1" />
        <button type="button" onClick={exportXml} className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3"
          title="드럼을 뺀 모든 트랙을 MusicXML 로 — Logic·MuseScore·Sibelius 가 읽습니다">MusicXML 내보내기</button>
        <button type="button" onClick={print} className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3">인쇄</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-white p-4">
        <svg viewBox={`0 0 ${width} ${lines.length * SYSTEM_H + 20}`} className="w-full" style={{ minWidth: 720 }} role="img" aria-label={`${track.name} 악보`}>
          {lines.map((line, li) => {
            const top = 30 + li * SYSTEM_H;
            const lineEnd = head + line.length * mw;
            return (
              <g key={li}>
                {[0, 1, 2, 3, 4].map((k) => <line key={k} x1={10} x2={lineEnd} y1={top + k * GAP} y2={top + k * GAP} stroke="#0A0A0B" strokeWidth={0.8} />)}
                <text x={12} y={clef === 'treble' ? top + STAFF + 6 : top + 22} fontSize={clef === 'treble' ? 44 : 30} fontFamily={MUSIC_FONT}>{clef === 'treble' ? '𝄞' : '𝄢'}</text>
                {/* 조표 */}
                {(fifths > 0 ? SHARP_POS : FLAT_POS)[clef].slice(0, Math.abs(fifths)).map((pos, k) => (
                  <text key={k} x={40 + k * 7} y={top + STAFF - pos * (GAP / 2) + 4} fontSize={14} fontFamily={MUSIC_FONT}>{fifths > 0 ? '♯' : '♭'}</text>
                ))}
                {line.map((m, mi) => {
                  const x0 = head + mi * mw;
                  const len = m.timeSignature.num * (PPQ * 4) / m.timeSignature.den;
                  const inner = mw - 24;
                  const xOf = (offset: number) => x0 + 14 + (offset / len) * inner;
                  const chords = (project.chords ?? []).filter((c) => positionAt(project, c.tick).bar === m.index);
                  return (
                    <g key={m.index} data-measure={m.index + 1}>
                      <line x1={x0 + mw} x2={x0 + mw} y1={top} y2={top + STAFF} stroke="#0A0A0B" strokeWidth={1} />
                      <text x={x0 + 2} y={top - 14} fontSize={9} fill="#71717A">{m.index + 1}</text>
                      {li === 0 && mi === 0 && (
                        <g fontFamily="Georgia, serif" fontWeight="bold" fontSize={17}>
                          <text x={x0 - 18} y={top + 15} textAnchor="middle">{m.timeSignature.num}</text>
                          <text x={x0 - 18} y={top + 31} textAnchor="middle">{m.timeSignature.den}</text>
                        </g>
                      )}
                      {chords.map((c) => {
                        const off = c.tick - positionAt(project, c.tick).barTick;
                        return <text key={c.id} x={xOf(off)} y={top - 4} fontSize={12} fontWeight={600} fill="#0A0A0B">{chordLabel(c)}</text>;
                      })}
                      {m.events.map((e, ei) => <Glyph key={ei} e={e} x={xOf(e.offset)} top={top} yOf={yOf} next={m.events[ei + 1] ? xOf(m.events[ei + 1]!.offset) : x0 + mw - 2} />)}
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
function Glyph({ e, x, top, yOf, next }: { e: NEvent; x: number; top: number; yOf: (p: Spelled, top: number) => number; next: number }) {
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
  const up = avg >= mid;
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
            <ellipse cx={x} cy={y} rx={5.2} ry={3.8} transform={`rotate(-20 ${x} ${y})`} fill={hollow ? 'white' : '#0A0A0B'} stroke="#0A0A0B" strokeWidth={1.3} />
            {e.dots === 1 && <circle cx={x + 9} cy={y - 1.5} r={1.4} fill="#0A0A0B" />}
            {e.tie && <path d={`M ${x + 4} ${y + (up ? 5 : -5)} Q ${(x + next) / 2} ${y + (up ? 11 : -11)} ${next - 4} ${y + (up ? 5 : -5)}`} fill="none" stroke="#0A0A0B" strokeWidth={1} />}
          </g>
        );
      })}
      {e.type !== 'whole' && <line x1={stemX} x2={stemX} y1={stemFrom} y2={stemTo} stroke="#0A0A0B" strokeWidth={1.1} />}
      {Array.from({ length: flags }, (_, k) => (
        <path key={k} d={up
          ? `M ${stemX} ${stemTo + k * 6} q 7 4 6 13`
          : `M ${stemX} ${stemTo - k * 6} q 7 -4 6 -13`} fill="none" stroke="#0A0A0B" strokeWidth={1.6} />
      ))}
    </g>
  );
}

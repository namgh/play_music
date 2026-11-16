import { useState } from 'react';

import type { ChordId, ChordQuality, MarkerId, MusicalKey, Project, SectionId } from '../model/project.ts';
import { CHORD_QUALITIES } from '../model/project.ts';
import { analyzeChords, chordLabel } from '../model/chords.ts';
import type { BarLine } from '../model/meter.ts';
import { NOTE_NAMES } from '../model/pitch.ts';
import { INSTRUMENT_CATALOG } from '../instruments/definitions.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { EditError } from '../editor/edits.ts';
import {
  addChord, addMarker, addSection, deleteChord, deleteMarker, deleteSection, duplicateSection, keyAt,
  removeSectionMarker, replaceChords, setKeyChange, setSignatureChange, swapSectionWithNeighbor, transposeChords,
  updateChord, updateMarker, updateSection,
} from '../editor/arrangement.ts';

/**
 * 글로벌 트랙 — 구간(편곡 마커) · 마커 · 코드, 그리고 눈금자에서 고른 마디의
 * 박자·조성 변화 (`LOGIC_PARITY.md` 1-4·1-11).
 *
 * 트랙 행과 **같은 2단 구조**다: 왼쪽 칸은 고른 것의 설정, 오른쪽은 곡 전체 위의
 * 표시. 고른 것이 없으면 왼쪽 칸은 그 줄의 이름과 한 줄 도움말만 보여 준다 —
 * 대화상자를 띄우지 않는다 (편집 흐름을 끊지 않는다).
 */

export type GlobalSelection =
  | { kind: 'section'; id: SectionId }
  | { kind: 'marker'; id: MarkerId }
  | { kind: 'chord'; id: ChordId }
  | { kind: 'bar'; bar: number }
  | null;

export interface GlobalTracksProps {
  editor: ProjectEditor;
  lines: readonly BarLine[];
  totalTicks: number;
  nameCol: string;
  selection: GlobalSelection;
  onSelect: (selection: GlobalSelection) => void;
  /** 이 자리로 커서를 옮긴다 (곡 기준 틱) */
  onSeek: (tick: number) => void;
  onNotice: (message: string) => void;
}

const ROW = 'flex h-7 border-b border-grid';
const LABEL = 'shrink-0 text-[11px] font-semibold text-ink-2';
const HINT = 'min-w-0 truncate text-[11px] text-ink-3';
const MINI = 'h-6 shrink-0 whitespace-nowrap rounded border border-rule bg-body px-1.5 text-[11px] text-ink hover:border-ink-3 disabled:opacity-40';
const MINI_INPUT = 'h-6 min-w-0 rounded border border-rule bg-body px-1.5 text-[11px] text-ink';

const QUALITY_NAMES: Record<ChordQuality, string> = {
  maj: '장', min: '단 (m)', dim: 'dim', aug: 'aug', sus2: 'sus2', sus4: 'sus4', '7': '7', maj7: 'maj7',
  min7: 'm7', m7b5: 'm7♭5', dim7: 'dim7', '6': '6', min6: 'm6', add9: 'add9',
};
const SIGNATURES = ['2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '3/8', '5/8', '6/8', '7/8', '9/8', '12/8'];

const isDrum = (instrumentId: string) => INSTRUMENT_CATALOG.find((e) => e.id === instrumentId)?.category === '드럼';

export function GlobalTracks({
  editor, lines, totalTicks, nameCol, selection, onSelect, onSeek, onNotice,
}: GlobalTracksProps) {
  const { project } = editor;
  const pct = (ticks: number) => `${(ticks / totalTicks) * 100}%`;
  const [stepBars, setStepBars] = useState<1 | 0.5>(1);

  /** 편집 함수가 거절하면 이유를 보여 준다 — 조용히 무시하지 않는다 */
  const run = (edit: () => Project, then?: (next: Project) => void) => {
    try {
      const next = edit();
      editor.commit(next);
      then?.(next);
    } catch (err) {
      onNotice(err instanceof EditError || err instanceof Error ? err.message : String(err));
    }
  };

  /** 레인 위 x 좌표 → 그 마디 */
  const barAt = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const tick = ((event.clientX - rect.left) / rect.width) * totalTicks;
    return lines.reduce((found, line) => (line.tick <= tick ? line : found), lines[0]!);
  };

  const sections = project.sections ?? [];
  const markers = project.markers ?? [];
  const chords = project.chords ?? [];
  const selSection = selection?.kind === 'section' ? sections.find((s) => s.id === selection.id) ?? null : null;
  const selMarker = selection?.kind === 'marker' ? markers.find((m) => m.id === selection.id) ?? null : null;
  const selChord = selection?.kind === 'chord' ? chords.find((c) => c.id === selection.id) ?? null : null;
  const selBar = selection?.kind === 'bar' ? lines[selection.bar] ?? null : null;

  // --- 구간 ---
  const onSectionLane = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-item]')) return;
    const line = barAt(event);
    // 다음 구간(또는 곡 끝)까지, 최대 4마디
    const nextStart = Math.min(totalTicks, ...sections.filter((s) => s.startTick > line.tick).map((s) => s.startTick));
    const fourBars = (lines[Math.min(lines.length, line.bar + 4)]?.tick ?? totalTicks) - line.tick;
    const length = Math.min(fourBars, nextStart - line.tick);
    let id: SectionId | null = null;
    run(() => {
      const added = addSection(project, { startTick: line.tick, lengthTick: length });
      id = added.sectionId;
      return added.project;
    }, () => { if (id) onSelect({ kind: 'section', id }); });
  };

  // --- 마커 ---
  const onMarkerLane = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-item]')) return;
    const line = barAt(event);
    let id: MarkerId | null = null;
    run(() => {
      const added = addMarker(project, line.tick);
      id = added.markerId;
      return added.project;
    }, () => { if (id) onSelect({ kind: 'marker', id }); });
  };

  // --- 코드 ---
  const onChordLane = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-item]')) return;
    const line = barAt(event);
    // 앞 코드를 이어받는다 — 대부분 근처 코드에서 조금 바꾸는 것이다
    const before = [...chords].reverse().find((c) => c.tick < line.tick);
    let id: ChordId | null = null;
    run(() => {
      const added = addChord(project, { tick: line.tick, root: before?.root ?? 'C', quality: before?.quality ?? 'maj' });
      id = added.chordId;
      return added.project;
    }, () => { if (id) onSelect({ kind: 'chord', id }); });
  };

  const analyze = () => {
    const tonal = project.tracks.filter((t) => !isDrum(t.instrumentId)).map((t) => t.id);
    const step = stepBars === 1 ? lines[0]?.lengthTick ?? 3840 : (lines[0]?.lengthTick ?? 3840) / 2;
    const found = analyzeChords(project, { stepTick: step, toTick: totalTicks, trackIds: tonal });
    if (found.length === 0) {
      onNotice('코드를 알아낼 음이 없습니다 (드럼 트랙은 빼고 봅니다)');
      return;
    }
    run(() => replaceChords(project, found, { fromTick: 0, toTick: totalTicks }));
    onNotice(`코드 ${found.length}개를 찾았습니다 — 음표에서 알아낸 것이라 틀릴 수 있습니다`);
  };

  const keyValue = (key: MusicalKey | null) => (key === null ? '' : `${key.tonic}|${key.mode}`);
  const parseKey = (raw: string): MusicalKey | null => {
    if (!raw) return null;
    const [tonic, mode] = raw.split('|');
    return { tonic: tonic!, mode: mode === 'minor' ? 'minor' : 'major' };
  };

  return (
    <>
      {/* 고른 마디 — 박자·조성 변화. 눈금자에서 마디 번호를 누르면 여기가 열린다 */}
      {selBar && (
        <div className={ROW} data-global="bar">
          <div className={`flex ${nameCol} shrink-0 items-center gap-1.5 border-r border-rule bg-panel px-2`}>
            <span className={LABEL}>{selBar.bar + 1}마디부터</span>
            <select
              aria-label="박자 변화"
              value={`${selBar.timeSignature.num}/${selBar.timeSignature.den}`}
              onChange={(e) => {
                const [num, den] = e.target.value.split('/').map(Number);
                run(() => setSignatureChange(project, selBar.bar, { num: num!, den: den! }));
              }}
              className={MINI_INPUT}
            >
              {SIGNATURES.map((sig) => <option key={sig} value={sig}>{sig}</option>)}
            </select>
            {selBar.bar > 0 && selBar.changed && (
              <button type="button" className={MINI} onClick={() => run(() => setSignatureChange(project, selBar.bar, null))}>
                박자 변화 지우기
              </button>
            )}
            <select
              aria-label="조성 변화"
              value={keyValue(keyAt(project, selBar.tick))}
              onChange={(e) => run(() => setKeyChange(project, selBar.tick, parseKey(e.target.value)))}
              className={MINI_INPUT}
            >
              <option value="">조성 없음</option>
              {NOTE_NAMES.map((t) => <option key={`${t}M`} value={`${t}|major`}>{t} 장조</option>)}
              {NOTE_NAMES.map((t) => <option key={`${t}m`} value={`${t}|minor`}>{t} 단조</option>)}
            </select>
            <button type="button" className={MINI} onClick={() => onSelect(null)} aria-label="마디 설정 닫기">닫기</button>
          </div>
          <div className="relative flex-1 bg-screen">
            <span style={{ left: pct(selBar.tick), width: pct(selBar.lengthTick) }} className="absolute inset-y-0 bg-acc/25" />
          </div>
        </div>
      )}

      {/* 구간 */}
      <div className={ROW} data-global="sections">
        <div className={`flex ${nameCol} shrink-0 items-center gap-1.5 border-r border-rule px-2 ${selSection ? 'bg-panel' : 'bg-body'}`}>
          <span className={LABEL}>구간</span>
          {selSection ? (
            <>
              <input
                aria-label="구간 이름"
                value={selSection.name}
                onChange={(e) => editor.preview(updateSection(project, selSection.id, { name: e.target.value || ' ' }))}
                onBlur={() => editor.commitCurrent()}
                className={`${MINI_INPUT} w-24`}
              />
              <button type="button" className={MINI} title="앞 구간과 자리를 바꿉니다 (안의 음악째)"
                onClick={() => run(() => swapSectionWithNeighbor(project, selSection.id, -1))}>◀</button>
              <button type="button" className={MINI} title="뒤 구간과 자리를 바꿉니다 (안의 음악째)"
                onClick={() => run(() => swapSectionWithNeighbor(project, selSection.id, 1))}>▶</button>
              <button type="button" className={MINI} title="안의 음악째 복제해 바로 뒤에 끼웁니다"
                onClick={() => {
                  let id: SectionId | null = null;
                  run(() => { const r = duplicateSection(project, selSection.id); id = r.sectionId; return r.project; },
                    () => { if (id) onSelect({ kind: 'section', id }); });
                }}>복제</button>
              <button type="button" className={MINI} title="안의 음악째 지우고 뒤를 당깁니다"
                onClick={() => run(() => deleteSection(project, selSection.id), () => onSelect(null))}>삭제</button>
              <button type="button" className={MINI} title="표시만 지웁니다 — 음악은 그대로"
                onClick={() => run(() => removeSectionMarker(project, selSection.id), () => onSelect(null))}>표시만 지우기</button>
            </>
          ) : (
            <span className={HINT}>빈 곳을 눌러 구간 추가 · 구간째 옮기고 복제합니다</span>
          )}
        </div>
        <div className="relative flex-1 cursor-copy bg-screen" onClick={onSectionLane}>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              data-item
              onClick={() => { onSelect({ kind: 'section', id: s.id }); onSeek(s.startTick); }}
              style={{ left: pct(s.startTick), width: pct(s.lengthTick) }}
              className={`absolute inset-y-0.5 truncate rounded-sm border-l-2 border-acc-2 bg-sink-3/40 px-1.5 text-left text-[11px] font-semibold text-sink ${
                selSection?.id === s.id ? 'ring-[1.5px] ring-acc' : ''}`}
            >{s.name}</button>
          ))}
        </div>
      </div>

      {/* 마커 */}
      <div className={ROW} data-global="markers">
        <div className={`flex ${nameCol} shrink-0 items-center gap-1.5 border-r border-rule px-2 ${selMarker ? 'bg-panel' : 'bg-body'}`}>
          <span className={LABEL}>마커</span>
          {selMarker ? (
            <>
              <input
                aria-label="마커 이름"
                value={selMarker.name}
                onChange={(e) => editor.preview(updateMarker(project, selMarker.id, { name: e.target.value || ' ' }))}
                onBlur={() => editor.commitCurrent()}
                className={`${MINI_INPUT} w-32`}
              />
              <button type="button" className={MINI}
                onClick={() => run(() => deleteMarker(project, selMarker.id), () => onSelect(null))}>삭제</button>
            </>
          ) : (
            <span className={HINT}>빈 곳을 눌러 마커 추가 · 누르면 그 자리로 갑니다</span>
          )}
        </div>
        <div className="relative flex-1 cursor-copy bg-screen" onClick={onMarkerLane}>
          {markers.map((m) => (
            <button
              key={m.id}
              type="button"
              data-item
              onClick={() => { onSelect({ kind: 'marker', id: m.id }); onSeek(m.tick); }}
              style={{ left: pct(m.tick) }}
              className={`absolute inset-y-0.5 max-w-40 truncate border-l-2 border-acc pl-1 pr-1.5 text-left text-[11px] text-sink ${
                selMarker?.id === m.id ? 'bg-acc/30' : 'hover:bg-sink-3/30'}`}
            >{m.name}</button>
          ))}
        </div>
      </div>

      {/* 코드 */}
      <div className={ROW} data-global="chords">
        <div className={`flex ${nameCol} shrink-0 items-center gap-1.5 border-r border-rule px-2 ${selChord ? 'bg-panel' : 'bg-body'}`}>
          <span className={LABEL}>코드</span>
          {selChord ? (
            <>
              <select aria-label="코드 근음" value={selChord.root} className={MINI_INPUT}
                onChange={(e) => run(() => updateChord(project, selChord.id, { root: e.target.value }))}>
                {NOTE_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <select aria-label="코드 종류" value={selChord.quality} className={MINI_INPUT}
                onChange={(e) => run(() => updateChord(project, selChord.id, { quality: e.target.value as ChordQuality }))}>
                {CHORD_QUALITIES.map((q) => <option key={q} value={q}>{QUALITY_NAMES[q]}</option>)}
              </select>
              <select aria-label="베이스음" value={selChord.bass ?? ''} className={MINI_INPUT}
                onChange={(e) => run(() => updateChord(project, selChord.id, { bass: e.target.value || null }))}>
                <option value="">/ 근음</option>
                {NOTE_NAMES.map((n) => <option key={n} value={n}>/ {n}</option>)}
              </select>
              <button type="button" className={MINI}
                onClick={() => run(() => deleteChord(project, selChord.id), () => onSelect(null))}>삭제</button>
            </>
          ) : (
            <>
              <button type="button" className={MINI} onClick={analyze}
                title="드럼을 뺀 트랙의 음표에서 코드 진행을 알아냅니다 (기존 코드는 바뀝니다)">음에서 찾기</button>
              <select aria-label="코드 찾는 간격" value={stepBars} className={MINI_INPUT}
                onChange={(e) => setStepBars(Number(e.target.value) === 1 ? 1 : 0.5)}>
                <option value={1}>마디마다</option>
                <option value={0.5}>반 마디마다</option>
              </select>
              <button type="button" className={MINI} disabled={chords.length === 0} title="코드 기호를 반음 내립니다"
                onClick={() => run(() => transposeChords(project, -1))}>♭</button>
              <button type="button" className={MINI} disabled={chords.length === 0} title="코드 기호를 반음 올립니다"
                onClick={() => run(() => transposeChords(project, 1))}>♯</button>
            </>
          )}
        </div>
        <div className="relative flex-1 cursor-copy bg-screen" onClick={onChordLane}>
          {chords.map((c) => (
            <button
              key={c.id}
              type="button"
              data-item
              onClick={() => onSelect({ kind: 'chord', id: c.id })}
              style={{ left: pct(c.tick) }}
              className={`absolute inset-y-0.5 whitespace-nowrap px-1 text-left font-num text-[13px] font-semibold text-sink ${
                selChord?.id === c.id ? 'rounded-sm bg-acc/30' : 'hover:bg-sink-3/30'}`}
            >{chordLabel(c)}</button>
          ))}
        </div>
      </div>
    </>
  );
}

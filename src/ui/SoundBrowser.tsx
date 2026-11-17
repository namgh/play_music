import { useMemo, useState } from 'react';

import type { Project, Track } from '../model/project.ts';
import { INSTRUMENT_CATALOG } from '../instruments/definitions.ts';
import type { InstrumentCategory } from '../instruments/types.ts';
import { addPatch, FAMILY_LABEL, loadPatches, removePatch, savePatches, searchInstruments } from '../instruments/browse.ts';
import type { UserPatch } from '../instruments/browse.ts';
import { addClip, addTrack, updateTrack } from '../editor/edits.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { projectLengthTicks } from '../model/factory.ts';

/**
 * 브라우저 — 악기 찾기 · 미리 듣기 · 고른 트랙에 넣기 · 새 트랙으로 · 내 음색(패치)
 * (Logic 통합 브라우저, `LOGIC_PARITY.md` 1-6). 오른쪽 칸에 "음 편집" 과 탭으로 나란히.
 */

const CATEGORIES: InstrumentCategory[] = ['기타', '베이스', '피아노', '건반·신스', '말렛·벨', '줄', '드럼'];
const CHIP = 'h-6 rounded-full border px-2 text-[11px]';
const ROW_BTN = 'h-6 shrink-0 rounded border border-rule bg-body px-1.5 text-[11px] text-ink-2 hover:border-ink-3';

export interface SoundBrowserProps {
  editor: ProjectEditor;
  track: Track | null;
  /** 이 악기로 한 음 들려준다 (가운데 도 근처) */
  onPreview: (instrumentId: string) => void;
  onSelectTrack: (trackId: Track['id']) => void;
  onNotice: (message: string) => void;
}

export function SoundBrowser({ editor, track, onPreview, onSelectTrack, onNotice }: SoundBrowserProps) {
  const { project } = editor;
  const [text, setText] = useState('');
  const [category, setCategory] = useState<InstrumentCategory | null>(null);
  const [patches, setPatches] = useState<UserPatch[]>(() => loadPatches());
  const [patchName, setPatchName] = useState('');

  const found = useMemo(() => searchInstruments(INSTRUMENT_CATALOG, { text, category }), [text, category]);

  const setPatchList = (next: UserPatch[]) => {
    setPatches(next);
    if (!savePatches(next)) onNotice('이 브라우저에 패치를 저장하지 못했습니다 (저장소가 막혀 있음)');
  };

  const useOnTrack = (instrumentId: string, tone?: Pick<UserPatch, 'toneId' | 'toneParams'>) => {
    if (!track) return;
    const name = INSTRUMENT_CATALOG.find((e) => e.id === instrumentId)?.name ?? instrumentId;
    editor.commit(updateTrack(project, track.id, {
      instrumentId, name, toneId: tone?.toneId ?? 'default', toneParams: tone?.toneParams ?? null,
    }));
  };
  const asNewTrack = (instrumentId: string) => {
    const name = INSTRUMENT_CATALOG.find((e) => e.id === instrumentId)?.name ?? instrumentId;
    const added = addTrack(project, { name, instrumentId });
    let next: Project = added.project;
    try {
      next = addClip(next, { trackId: added.trackId, startTick: 0, lengthTick: projectLengthTicks(project), label: name }).project;
    } catch { /* 길이 0 곡 — 클립 없이 */ }
    editor.commit(next);
    onSelectTrack(added.trackId);
  };

  return (
    <div className="flex min-h-0 flex-col gap-3" data-browser>
      <input
        type="search"
        aria-label="악기 검색"
        placeholder="악기 검색 — 이름·분류·합성 방식 (예: 베이스 신스)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="h-8 w-full rounded-md border border-rule bg-body px-2.5 text-xs text-ink placeholder:text-ink-3"
      />
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="분류">
        {[null, ...CATEGORIES].map((c) => (
          <button key={c ?? 'all'} type="button" role="radio" aria-checked={category === c}
            onClick={() => setCategory(c)}
            className={`${CHIP} ${category === c ? 'border-ink bg-ink text-body' : 'border-rule bg-panel text-ink-2'}`}
          >{c ?? '전체'}</button>
        ))}
      </div>

      <div className="text-[11px] text-ink-3">
        {found.length}개 · {track ? <>고른 트랙 <b className="text-ink">{track.name}</b></> : '트랙을 고르면 바로 바꿀 수 있습니다'}
      </div>
      <ul className="flex flex-col divide-y divide-rule rounded-lg border border-rule">
        {found.map((entry) => {
          const current = track?.instrumentId === entry.id;
          return (
            <li key={entry.id} data-instrument={entry.id} className={`flex items-center gap-1.5 px-2 py-1.5 ${current ? 'bg-panel' : ''}`}>
              <button type="button" onClick={() => onPreview(entry.id)} title="미리 듣기" aria-label={`${entry.name} 미리 듣기`}
                className="h-6 w-6 shrink-0 rounded-full border border-rule text-[10px] text-ink-2 hover:border-ink">▶</button>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-ink">{entry.name}{current ? ' ✓' : ''}</span>
                <span className="block truncate text-[10px] text-ink-3">{entry.category} · {FAMILY_LABEL[entry.family] ?? entry.family}</span>
              </span>
              <button type="button" disabled={!track || current} onClick={() => useOnTrack(entry.id)} className={`${ROW_BTN} disabled:opacity-40`}>이 트랙에</button>
              <button type="button" onClick={() => asNewTrack(entry.id)} className={ROW_BTN}>새 트랙</button>
            </li>
          );
        })}
        {found.length === 0 && <li className="px-2 py-3 text-xs text-ink-3">맞는 악기가 없습니다</li>}
      </ul>

      <div className="space-y-1.5 rounded-lg border border-rule bg-panel p-2.5">
        <div className="text-[11px] font-semibold text-ink-2">내 음색 (패치) — 모든 곡에서 꺼내 씁니다</div>
        <div className="flex gap-1.5">
          <input aria-label="패치 이름" value={patchName} onChange={(e) => setPatchName(e.target.value)}
            placeholder={track ? `${track.name} 음색` : '트랙을 고르세요'} disabled={!track}
            className="h-7 min-w-0 flex-1 rounded border border-rule bg-body px-2 text-xs text-ink" />
          <button type="button" disabled={!track}
            onClick={() => {
              if (!track) return;
              setPatchList(addPatch(patches, {
                name: patchName || `${track.name} 음색`, instrumentId: track.instrumentId, toneId: track.toneId, toneParams: track.toneParams,
              }, Date.now()));
              setPatchName('');
              onNotice('패치를 저장했습니다');
            }}
            className="h-7 rounded border border-ink bg-ink px-2 text-xs text-body disabled:opacity-40">저장</button>
        </div>
        {patches.map((p) => (
          <div key={p.id} className="flex items-center gap-1.5" data-patch={p.name}>
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{p.name}
              <span className="ml-1 text-[10px] text-ink-3">{INSTRUMENT_CATALOG.find((e) => e.id === p.instrumentId)?.name}</span>
            </span>
            <button type="button" disabled={!track} onClick={() => useOnTrack(p.instrumentId, p)} className={`${ROW_BTN} disabled:opacity-40`}>불러오기</button>
            <button type="button" onClick={() => setPatchList(removePatch(patches, p.id))} aria-label={`${p.name} 지우기`} className={ROW_BTN}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

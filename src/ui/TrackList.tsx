import type { TrackId } from '../model/project.ts';
import { addClip, addTrack, deleteTrack, updateTrack } from '../editor/edits.ts';
import { ticksPerBar } from '../model/time.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { createRegistry, playableInstrumentIds } from '../instruments/definitions.ts';
import { resolveInstrument } from '../instruments/resolve.ts';

const registry = createRegistry();
const INSTRUMENT_IDS = playableInstrumentIds();
const instrumentName = (id: string) => resolveInstrument(id, registry).name;

// 켜짐/꺼짐 스타일을 문자열 하나에 섞지 않는다. 색 배경일 때는 어두운 같은 계열 글자,
// 투명 배경일 때만 회색 글자를 쓴다
const TOGGLE_BASE = 'h-7 w-7 rounded border text-xs font-semibold';
const TOGGLE_OFF = 'border-neutral-700 text-neutral-400';
const MUTE_ON = 'border-amber-400 bg-amber-400 text-amber-950';
const SOLO_ON = 'border-teal-300 bg-teal-300 text-teal-950';

export interface TrackListProps {
  editor: ProjectEditor;
  selectedTrackId: TrackId | null;
  onSelectTrack: (id: TrackId) => void;
}

/**
 * 트랙 목록 — 추가·삭제, 악기 선택, 음소거·솔로, 레벨 (`plan.md` 5-1 기본기).
 *
 * 트랙을 추가하면 클립을 하나 같이 만든다. 클립이 없으면 피아노롤에 찍을 곳이 없어
 * "트랙을 만들었는데 아무것도 못 한다"가 된다.
 */
export function TrackList({ editor, selectedTrackId, onSelectTrack }: TrackListProps) {
  const { project } = editor;

  const onAdd = () => {
    const instrumentId = INSTRUMENT_IDS[project.tracks.length % INSTRUMENT_IDS.length]!;
    const added = addTrack(project, { name: instrumentName(instrumentId), instrumentId });
    const withClip = addClip(added.project, {
      trackId: added.trackId,
      startTick: 0,
      lengthTick: project.lengthBars * ticksPerBar(project.timeSignature),
      label: instrumentName(instrumentId),
    });
    editor.commit(withClip.project);
    onSelectTrack(added.trackId);
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          트랙 {project.tracks.length}
        </h2>
        <button
          type="button"
          onClick={onAdd}
          className="rounded border border-neutral-700 px-2 py-1 text-xs hover:border-neutral-500"
        >
          ＋ 트랙 추가
        </button>
      </div>

      <ul className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {project.tracks.map((track) => {
          const selected = track.id === selectedTrackId;
          return (
            <li
              key={track.id}
              className={`flex flex-wrap items-center gap-2 p-2.5 ${selected ? 'bg-neutral-900' : ''}`}
            >
              <button
                type="button"
                onClick={() => onSelectTrack(track.id)}
                className={`w-2 self-stretch rounded-sm ${selected ? 'bg-teal-300' : 'bg-neutral-700'}`}
                aria-label={`${track.name} 선택`}
              />
              <select
                value={track.instrumentId}
                onChange={(e) => {
                  editor.commit(updateTrack(project, track.id, {
                    instrumentId: e.target.value,
                    name: instrumentName(e.target.value),
                    toneId: 'default',
                    toneParams: null,
                  }));
                }}
                className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
              >
                {INSTRUMENT_IDS.map((id) => (
                  <option key={id} value={id}>{instrumentName(id)}</option>
                ))}
              </select>

              <select
                value={track.toneId}
                onChange={(e) => editor.commit(updateTrack(project, track.id, { toneId: e.target.value }))}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
              >
                {Object.keys(resolveInstrument(track.instrumentId, registry).tones).map((tone) => (
                  <option key={tone} value={tone}>{tone === 'default' ? '기본' : tone}</option>
                ))}
              </select>

              <button
                type="button"
                aria-pressed={track.mute}
                onClick={() => editor.commit(updateTrack(project, track.id, { mute: !track.mute }))}
                className={`${TOGGLE_BASE} ${track.mute ? MUTE_ON : TOGGLE_OFF}`}
              >M</button>
              <button
                type="button"
                aria-pressed={track.solo}
                onClick={() => editor.commit(updateTrack(project, track.id, { solo: !track.solo }))}
                className={`${TOGGLE_BASE} ${track.solo ? SOLO_ON : TOGGLE_OFF}`}
              >S</button>

              <input
                type="range"
                min={0} max={1} step={0.01}
                value={track.gain}
                aria-label={`${track.name} 레벨`}
                onChange={(e) => editor.preview(updateTrack(project, track.id, { gain: Number(e.target.value) }))}
                onPointerUp={() => editor.commitCurrent()}
                className="w-20 accent-teal-300"
              />

              <button
                type="button"
                onClick={() => editor.commit(deleteTrack(project, track.id))}
                aria-label={`${track.name} 삭제`}
                className="h-7 w-7 rounded border border-neutral-800 text-xs text-neutral-500 hover:border-red-800 hover:text-red-400"
              >✕</button>
            </li>
          );
        })}
      </ul>

      {project.tracks.length === 0 && (
        <p className="rounded-lg border border-dashed border-neutral-800 p-4 text-sm text-neutral-500">
          트랙이 없습니다. 위의 <b>＋ 트랙 추가</b>를 누르면 악기와 클립이 함께 만들어집니다.
        </p>
      )}
    </section>
  );
}

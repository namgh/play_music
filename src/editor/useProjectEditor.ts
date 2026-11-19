import { useCallback, useMemo, useRef, useState } from 'react';

import type { NoteId, Project } from '../model/project.ts';
import { History } from './history.ts';
import { protectedChange } from './tracks.ts';
import { syncAliases } from './aliases.ts';

/**
 * 편집 상태를 한 곳에 모은다. 컴포넌트는 프로젝트를 직접 고치지 않고 여기를 통한다.
 *
 * `commit` 과 `preview` 를 구분하는 것이 핵심이다:
 *  - `commit` — 되돌릴 수 있는 한 동작 (노트 추가, 드래그 완료)
 *  - `preview` — 아직 끝나지 않은 동작의 중간 상태 (드래그 중). 히스토리에 안 남는다
 *
 * 이걸 구분하지 않으면 드래그 한 번에 언두 단계가 수십 개 생긴다.
 */
export function useProjectEditor(initial: Project, options: { onBlocked?: (reason: string) => void } = {}) {
  const onBlocked = useRef(options.onBlocked);
  onBlocked.current = options.onBlocked;
  const historyRef = useRef<History<Project> | null>(null);
  historyRef.current ??= new History(initial);
  const history = historyRef.current;

  const [project, setProject] = useState<Project>(history.state);
  const [selection, setSelection] = useState<readonly NoteId[]>([]);
  const [revision, setRevision] = useState(0);

  const sync = useCallback((next: Project) => {
    setProject(next);
    setRevision((r) => r + 1);
  }, []);

  /** 보호된 트랙을 고치는 편집은 여기서 거른다 (`tracks.ts` protectedChange) */
  const allowed = useCallback((next: Project) => {
    const blocked = protectedChange(history.state, next);
    if (blocked === null) return true;
    onBlocked.current?.(`"${blocked}" 트랙은 보호돼 있습니다 — 트랙의 자물쇠를 풀고 고치세요`);
    return false;
  }, [history]);

  // 에일리어스는 편집 한 번마다 원본과 맞춘다 (`aliases.ts`) — 에일리어스가 없으면 그대로
  const commit = useCallback((raw: Project) => { const next = syncAliases(history.state, raw); if (allowed(next)) sync(history.commit(next)); }, [allowed, history, sync]);
  const preview = useCallback((raw: Project) => { const next = syncAliases(history.state, raw); if (allowed(next)) sync(history.replace(next)); }, [allowed, history, sync]);

  /** 드래그처럼 중간 상태를 미리 보여준 뒤 마지막에 한 번만 커밋하는 흐름 */
  const commitCurrent = useCallback(() => {
    // 미리보기 **시작 전** 상태를 되돌릴 지점으로 남긴다. 바뀐 것이 없으면 안 쌓는다
    sync(history.commitPreview());
  }, [history, sync]);

  const undo = useCallback(() => {
    sync(history.undo());
    setSelection((ids) => ids);
  }, [history, sync]);

  const redo = useCallback(() => sync(history.redo()), [history, sync]);

  /**
   * 다른 곡으로 갈아탄다 — 히스토리를 새로 시작한다. **보호 검사를 거치지 않는다**:
   * 지금 곡에 보호된 트랙이 있다고 다른 곡을 못 여는 일은 없어야 한다.
   */
  const load = useCallback((next: Project) => {
    historyRef.current = new History(next);
    setSelection([]);
    sync(historyRef.current.state);
  }, [sync]);

  const select = useCallback((ids: readonly NoteId[]) => setSelection(ids), []);
  const toggleSelect = useCallback((id: NoteId) => {
    setSelection((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }, []);

  // 언두로 사라진 노트가 선택에 남아 있으면 인스펙터가 유령을 편집한다
  const liveSelection = useMemo(() => {
    const alive = new Set<NoteId>();
    for (const track of project.tracks) {
      for (const clip of track.clips) for (const note of clip.notes) alive.add(note.id);
    }
    return selection.filter((id) => alive.has(id));
  }, [project, selection]);

  return {
    project,
    selection: liveSelection,
    revision,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    commit,
    preview,
    commitCurrent,
    undo,
    redo,
    load,
    select,
    toggleSelect,
  };
}

export type ProjectEditor = ReturnType<typeof useProjectEditor>;

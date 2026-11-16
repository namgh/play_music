import { useCallback, useMemo, useRef, useState } from 'react';

import type { NoteId, Project } from '../model/project.ts';
import { History } from './history.ts';

/**
 * 편집 상태를 한 곳에 모은다. 컴포넌트는 프로젝트를 직접 고치지 않고 여기를 통한다.
 *
 * `commit` 과 `preview` 를 구분하는 것이 핵심이다:
 *  - `commit` — 되돌릴 수 있는 한 동작 (노트 추가, 드래그 완료)
 *  - `preview` — 아직 끝나지 않은 동작의 중간 상태 (드래그 중). 히스토리에 안 남는다
 *
 * 이걸 구분하지 않으면 드래그 한 번에 언두 단계가 수십 개 생긴다.
 */
export function useProjectEditor(initial: Project) {
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

  const commit = useCallback((next: Project) => sync(history.commit(next)), [history, sync]);
  const preview = useCallback((next: Project) => sync(history.replace(next)), [history, sync]);

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
    select,
    toggleSelect,
  };
}

export type ProjectEditor = ReturnType<typeof useProjectEditor>;

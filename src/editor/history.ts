/**
 * 언두 히스토리 (`plan.md` 5-1 Phase 1 기본기).
 *
 * 스냅샷 방식이다. 프로젝트 데이터가 순수 직렬화 가능한 값만 담고 있어서
 * (`plan.md` 5-4) `structuredClone` 으로 통째로 복제할 수 있다 — 이게 그 규칙의
 * 첫 배당금이다. 오디오 객체가 섞여 있으면 복제 자체가 불가능하다.
 *
 * 되돌리기 단위를 "동작"으로 묶는다: 노트를 드래그하는 동안 매 프레임 커밋하면
 * 언두를 100번 눌러야 원위치로 돌아간다.
 *
 * **계약: 여기서 나온 상태를 변형하지 않는다** (Redux 와 같은 규칙).
 * 들어오는 값은 복제해서 보관하므로 호출자가 넘긴 객체를 나중에 변형해도 히스토리는
 * 안전하다. 반대로 `state` 는 **안정된 참조**를 돌려준다 — 읽을 때마다 복제하면
 * 렌더마다 객체 신원이 바뀌어 React 메모이제이션이 깨지기 때문이다.
 * `edits.ts` 의 편집 함수가 전부 순수하므로 이 계약은 코드로 지켜진다.
 */

export interface HistoryOptions {
  /** 보관할 최대 단계 수 */
  limit?: number;
}

const DEFAULT_LIMIT = 200;

export class History<T> {
  private readonly limit: number;
  private past: T[] = [];
  private future: T[] = [];
  private current: T;
  /**
   * 미리보기(`replace`)가 시작되기 **직전** 상태. 미리보기가 없으면 null.
   *
   * 이게 없던 때에는 `replace` 가 드래그 전 상태를 덮어써서, 드래그를 끝내고
   * 커밋하면 "옮긴 뒤"가 두 번 쌓였다 — 되돌리기를 눌러도 아무 일이 없고
   * 원래 자리는 영영 사라졌다 (2026-11-16 브라우저 검증에서 발견).
   */
  private previewBase: T | null = null;

  constructor(initial: T, options: HistoryOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.current = clone(initial);
  }

  get state(): T {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0 || this.previewBase !== null;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): { past: number; future: number } {
    return { past: this.past.length, future: this.future.length };
  }

  /** 되돌릴 수 있는 한 단계로 커밋한다 */
  commit(next: T): T {
    // 끝나지 않은 미리보기가 있으면 그 **시작점**에서 이어 붙인다
    this.push(this.previewBase ?? this.current);
    this.previewBase = null;
    this.current = clone(next);
    return this.current;
  }

  /**
   * 미리보기를 되돌릴 수 있는 한 단계로 확정한다 (드래그·슬라이더를 놓을 때).
   *
   * 미리보기가 없었거나 결국 제자리로 돌아왔으면 **아무것도 쌓지 않는다** —
   * 음을 그냥 한 번 누른 것까지 언두 단계가 되면 되돌리기가 헛돈다.
   */
  commitPreview(): T {
    const base = this.previewBase;
    if (base === null) return this.current;
    this.previewBase = null;
    if (same(base, this.current)) {
      this.current = base;
      return this.current;
    }
    this.push(base);
    return this.current;
  }

  private push(from: T): void {
    this.past.push(from);
    if (this.past.length > this.limit) this.past.shift();
    this.future = []; // 새 편집을 하면 리두 가지는 버린다
  }

  /**
   * 히스토리에 남기지 않고 현재 상태만 갈아치운다.
   * 드래그 중간 상태처럼 "아직 끝나지 않은 동작"에 쓴다.
   */
  replace(next: T): T {
    this.previewBase ??= this.current;
    this.current = clone(next);
    return this.current;
  }

  undo(): T {
    // 끝나지 않은 미리보기도 편집이다 — 먼저 한 단계로 확정한 뒤 되돌린다
    this.commitPreview();
    const previous = this.past.pop();
    if (previous === undefined) return this.current;
    this.future.push(this.current);
    this.current = previous;
    return this.current;
  }

  redo(): T {
    this.commitPreview(); // 확정되면 리두 가지가 비므로 아래는 아무 일도 안 한다
    const next = this.future.pop();
    if (next === undefined) return this.current;
    this.past.push(this.current);
    this.current = next;
    return this.current;
  }
}

/** 프로젝트는 직렬화 가능한 값뿐이라 문자열로 견줄 수 있다 (`plan.md` 5-4) */
function same<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

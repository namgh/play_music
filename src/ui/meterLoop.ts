/**
 * 미터들이 **한 프레임 루프를 나눠 쓴다.**
 *
 * 트랙마다 `requestAnimationFrame` 을 따로 돌리면 16트랙이면 루프가 16개다.
 * 하는 일은 같은데 예약 비용만 늘고, 프레임마다 도는 코드라 그 낭비가 그대로
 * 편집 중 반응성으로 돌아온다. 루프는 하나만 두고 등록된 일만 순서대로 돌린다.
 *
 * **React 상태를 거치지 않는다.** 레벨은 초당 60번 바뀌는 값이라 `setState` 로
 * 흘리면 그때마다 트리가 다시 그려진다. 각 미터는 자기 DOM 만 직접 만진다.
 */

type Task = () => void;

const tasks = new Set<Task>();
let handle: number | null = null;

function tick(): void {
  for (const task of tasks) task();
  handle = requestAnimationFrame(tick);
}

/** 등록하고, 해제 함수를 돌려준다. 마지막 하나가 빠지면 루프도 멈춘다 */
export function addMeterTask(task: Task): () => void {
  tasks.add(task);
  if (handle === null && typeof requestAnimationFrame === 'function') {
    handle = requestAnimationFrame(tick);
  }
  return () => {
    tasks.delete(task);
    if (tasks.size === 0 && handle !== null) {
      cancelAnimationFrame(handle);
      handle = null;
    }
  };
}

/** 테스트용 — 루프를 강제로 비운다 */
export function resetMeterLoopForTest(): void {
  tasks.clear();
  if (handle !== null) {
    cancelAnimationFrame(handle);
    handle = null;
  }
}

/**
 * 진폭 → 미터 위에서의 자리(0~1).
 *
 * **선형으로 그리면 안 된다.** 음량은 로그로 들리므로, 선형 막대는 아래쪽 60%가
 * 거의 안 움직이고 위쪽에서만 요동친다 — 정작 판단해야 하는 -20~-6dB 구간이
 * 뭉개진다. -60dB 를 바닥으로 잡고 dB 로 편다.
 */
export const METER_FLOOR_DB = -60;

export function meterPosition(amplitude: number): number {
  if (!(amplitude > 0)) return 0;
  const db = 20 * Math.log10(amplitude);
  if (db <= METER_FLOOR_DB) return 0;
  return Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB);
}

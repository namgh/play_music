/**
 * 타임코드 — 영상 작업의 시간 표기 (시:분:초:프레임).
 *
 * 영상 편집자와 "01:00:12:08 에서 음악이 들어온다" 로 말하려면 마디나 분:초로는 안 된다.
 * 여기는 표기와, 장면(히트 포인트)에 박을 맞추는 계산만 한다 — 순수 함수.
 */

export interface TimecodeSettings {
  /** 초당 프레임. 23.976·29.97·59.94 는 NTSC 계열 (실제 속도는 ×1000/1001) */
  fps: number;
  /** 곡의 0초가 몇 초 타임코드인가 — 영화는 보통 01:00:00:00 (3600) 에서 시작한다 */
  startSec: number;
}

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;
export const DEFAULT_TIMECODE: TimecodeSettings = { fps: 24, startSec: 0 };

/** 표기에 쓰는 정수 프레임 수 (23.976 → 24) 와 실제 초당 프레임 */
function rates(fps: number): { nominal: number; real: number } {
  const nominal = Math.round(fps);
  const ntsc = Math.abs(fps - nominal) > 0.001;
  return { nominal, real: ntsc ? (nominal * 1000) / 1001 : nominal };
}

/**
 * 초 → "HH:MM:SS:FF" (논드롭). NTSC 계열은 프레임을 실제 속도로 세고 표기는 정수 프레임으로 한다 —
 * 그래서 23.976 에서 한 시간이 지나면 표기는 3.6초 늦는다 (현장에서 쓰는 논드롭 표기와 같다).
 */
export function formatTimecode(seconds: number, settings: TimecodeSettings = DEFAULT_TIMECODE): string {
  const { nominal, real } = rates(settings.fps);
  // 시작 타임코드는 표기 기준(정수 프레임)으로 더한다
  const frames = Math.max(0, Math.floor(seconds * real + 1e-6) + Math.round(settings.startSec * nominal));
  const f = frames % nominal;
  const totalSec = Math.floor(frames / nominal);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}:${pad(f)}`;
}

/** 한 프레임이 몇 초인가 */
export function frameSeconds(fps: number): number {
  return 1 / rates(fps).real;
}

export interface HitFit {
  bpm: number;
  /** 그 장면이 몇 번째 박에 떨어지는가 (0 = 곡 시작) */
  beat: number;
  /** 지금 템포에서 가장 가까운 박까지의 어긋남 (초, +면 박이 늦다) */
  wasOffSec: number;
}

/**
 * 장면(히트 포인트)이 **박에 딱 떨어지게** 템포를 조금 바꾼다.
 *
 * 곡 시작부터 `hitSec` 초 자리에 장면이 있을 때, 지금 템포에서 가장 가까운 박 번호를 그대로 두고
 * 그 박이 정확히 그 시각에 오도록 템포를 구한다. 템포가 한 값인 곡을 가정한다
 * (템포 변화가 있으면 부르는 쪽이 막는다). `maxChangePct` 를 넘게 바꿔야 하면 null — 음악이 달라진다.
 */
export function fitTempoToHit(bpm: number, hitSec: number, maxChangePct = 8): HitFit | null {
  if (!(hitSec > 0) || !(bpm > 0)) return null;
  const exact = (hitSec * bpm) / 60;
  const beat = Math.max(1, Math.round(exact));
  const next = (beat * 60) / hitSec;
  if (Math.abs(next / bpm - 1) * 100 > maxChangePct) return null;
  return { bpm: Math.round(next * 1000) / 1000, beat, wasOffSec: ((beat - exact) * 60) / bpm };
}

/**
 * 트랙·마스터 레벨 미터.
 *
 * ## 왜 필요했나
 *
 * 데모 곡을 만들어 보니 10트랙에서 마스터를 **10.1dB 내려야** 했다. 그런데 그걸
 * 알 방법이 내보내기밖에 없었다 — 곡을 다 만들고 파일을 뽑아야 "잘렸습니다"가
 * 나온다. 어느 트랙이 범인인지는 그래도 알 수 없다.
 *
 * 미터는 그 답을 **만드는 동안** 준다. 페이더 옆에서 어느 트랙이 혼자 -3dB 를
 * 치고 있는지 보이면 거기서 줄이면 된다.
 *
 * ## 세 가지를 한 막대에 담는다
 *
 *  - **지금 레벨(RMS)** — 체감 음량에 가깝다. 막대가 이걸 그린다
 *  - **최근 피크** — 순간적으로 튄 값. 얇은 선으로 잠깐 머문다. RMS 만 보면
 *    "평균은 괜찮은데 어택에서 넘치는" 경우를 놓친다
 *  - **넘침 표시** — 한 번이라도 1.0 을 넘으면 **켜진 채로 남는다.** 지나가는
 *    빨간 깜빡임은 딴 데 보고 있으면 못 본다. 눌러서 끈다
 */

import { useEffect, useRef } from 'react';

import { addMeterTask, meterPosition } from './meterLoop.ts';

export interface LevelMeterProps {
  /** 지금 레벨을 읽는다. `null` 이면 아직 재생 경로가 없다는 뜻 */
  read: () => { peak: number; rms: number } | null;
  /** 세로 막대로 그린다 (믹서). 기본은 가로 (트랙 줄) */
  vertical?: boolean;
  className?: string;
  label?: string;
}

/** 피크 선이 머무는 시간. 짧으면 못 보고, 길면 지금 상태와 헷갈린다 */
const PEAK_HOLD_MS = 1200;

export function LevelMeter({ read, vertical = false, className = '', label }: LevelMeterProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLButtonElement | null>(null);
  /** 넘쳤다는 사실은 **끄기 전까지 남는다** — 지나가면 못 본다 */
  const clippedRef = useRef(false);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    let peakHold = 0;
    let peakAt = 0;

    return addMeterTask(() => {
      const bar = barRef.current;
      const peakMark = peakRef.current;
      if (!bar || !peakMark) return;

      const level = readRef.current();
      if (!level) {
        // 재생 경로가 아직 없다 — 0 으로 두되 넘침 표시는 건드리지 않는다
        bar.style[vertical ? 'height' : 'width'] = '0%';
        peakMark.style.opacity = '0';
        return;
      }

      const now = performance.now();
      if (level.peak >= peakHold || now - peakAt > PEAK_HOLD_MS) {
        peakHold = level.peak;
        peakAt = now;
      }

      const size = `${(meterPosition(level.rms) * 100).toFixed(1)}%`;
      const at = `${(meterPosition(peakHold) * 100).toFixed(1)}%`;
      bar.style[vertical ? 'height' : 'width'] = size;
      peakMark.style[vertical ? 'bottom' : 'left'] = at;
      peakMark.style.opacity = peakHold > 0 ? '1' : '0';

      // **1.0 을 넘으면 그 지점에서 이미 잘린 것이다** (`headroom.ts` 와 같은 기준)
      if (level.peak >= 1 && !clippedRef.current) {
        clippedRef.current = true;
        if (clipRef.current) {
          clipRef.current.dataset.on = 'true';
          clipRef.current.title = '넘쳤습니다 — 눌러서 표시를 끕니다';
        }
      }
    });
  }, [vertical]);

  const track = vertical
    ? 'relative w-2 min-h-0 flex-1 overflow-hidden rounded-sm bg-neutral-800'
    : 'relative h-1.5 w-full overflow-hidden rounded-sm bg-neutral-800';
  const fill = vertical
    ? 'absolute bottom-0 left-0 w-full bg-teal-400'
    : 'absolute inset-y-0 left-0 bg-teal-400';
  const mark = vertical
    ? 'absolute left-0 h-px w-full bg-teal-100'
    : 'absolute inset-y-0 w-px bg-teal-100';

  return (
    <div
      className={`flex ${vertical ? 'flex-col-reverse items-center gap-1' : 'items-center gap-1.5'} ${className}`}
      aria-label={label}
    >
      <div className={track}>
        <div ref={barRef} className={fill} style={{ [vertical ? 'height' : 'width']: '0%' }} />
        <div ref={peakRef} className={mark} style={{ opacity: 0 }} />
      </div>
      {/* 넘침 표시 — 켜지면 남는다. 눌러서 끈다 */}
      <button
        ref={clipRef}
        type="button"
        aria-label="넘침 표시 끄기"
        onClick={() => {
          clippedRef.current = false;
          if (clipRef.current) {
            clipRef.current.dataset.on = 'false';
            clipRef.current.title = '';
          }
        }}
        data-on="false"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-700 data-[on=true]:bg-red-500"
      />
    </div>
  );
}

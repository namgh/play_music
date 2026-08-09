import { useRef, useState } from 'react';

import type { Clip } from '../model/project.ts';
import { PPQ } from '../model/time.ts';
import { setVelocity } from '../editor/edits.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';

/**
 * 벨로시티 레인 — 음마다 막대 하나. 끌어서 세기를 칠한다.
 *
 * 왜 필요한가: 인스펙터는 한 음씩만 다룬다. 20음의 세기를 맞추려면 20번 클릭해야
 * 하고, 그러면 실사용에서 지친다. FL Studio·Cubase 가 피아노롤 아래에 이 레인을
 * 두는 이유가 그것이다.
 *
 * 피아노롤과 **같은 x 축**을 써야 한다. 안 맞으면 어느 막대가 어느 음인지 알 수 없다 —
 * 그래서 `PX_PER_BEAT` 를 피아노롤과 공유한다.
 */

const PX_PER_BEAT = 56;
const LANE_HEIGHT = 72;
/** 건반 칸 너비. 피아노롤과 맞춰 x 축을 정렬한다 */
const KEYS_WIDTH = 64;

export interface VelocityLaneProps {
  editor: ProjectEditor;
  clip: Clip;
  /** 막대를 두 번 눌렀을 때 들려준다 */
  onAudition?: (midi: number, cents: number) => void;
}

export function VelocityLane({ editor, clip, onAudition }: VelocityLaneProps) {
  const { project, selection } = editor;
  const laneRef = useRef<HTMLDivElement | null>(null);
  /**
   * 끌고 있는 동안 true. 지나가는 막대를 계속 칠한다.
   *
   * 칠하는 동안은 `preview` 로만 바꾸고 뗄 때 `commitCurrent` 로 한 단계를 만든다 —
   * 안 그러면 한 번 끌 때 언두 단계가 수십 개 생긴다
   */
  const [painting, setPainting] = useState(false);

  const pxPerTick = PX_PER_BEAT / PPQ;
  const width = clip.lengthTick * pxPerTick;

  /** y 좌표 → 0~1 세기 (위가 크다) */
  const yToVelocity = (clientY: number): number => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return 0.8;
    const t = 1 - (clientY - rect.top) / rect.height;
    return Math.min(1, Math.max(0, t));
  };

  const paintAt = (clientX: number, clientY: number) => {
    const rect = laneRef.current?.getBoundingClientRect();
    if (!rect) return;
    const tick = (clientX - rect.left) / pxPerTick;
    // 커서 아래에 있는 음. 끌면서 지나가는 것들을 차례로 칠한다
    const under = clip.notes.filter(
      (note) => tick >= note.startTick && tick < note.startTick + note.lengthTick,
    );
    if (under.length === 0) return;

    const velocity = yToVelocity(clientY);
    // 선택이 있으면 선택된 음만 건드린다 — 러버밴드로 고른 뒤 한 번에 맞추는 흐름
    const targets = selection.length > 0
      ? under.filter((note) => selection.includes(note.id))
      : under;
    if (targets.length === 0) return;

    editor.preview(setVelocity(project, targets.map((n) => n.id), velocity));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setPainting(true);
    paintAt(event.clientX, event.clientY);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!painting) return;
    paintAt(event.clientX, event.clientY);
  };

  const onPointerUp = () => {
    if (!painting) return;
    setPainting(false);
    editor.commitCurrent();
  };

  return (
    <div className="overflow-auto rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex">
        {/* 피아노롤 건반 칸과 폭을 맞춘 라벨 자리 */}
        <div
          className="sticky left-0 z-10 flex shrink-0 items-end justify-end border-r border-neutral-800 bg-neutral-950 px-2 pb-1"
          style={{ width: KEYS_WIDTH, height: LANE_HEIGHT }}
        >
          <span className="text-[9px] uppercase tracking-wider text-neutral-500">세기</span>
        </div>

        <div
          ref={laneRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ width, height: LANE_HEIGHT }}
          className="relative cursor-ns-resize"
        >
          {/* 0.25 눈금 — 값을 눈으로 읽을 수 있게 */}
          {[0.25, 0.5, 0.75].map((v) => (
            <div
              key={v}
              style={{ bottom: `${v * 100}%` }}
              className="pointer-events-none absolute inset-x-0 h-px bg-neutral-900"
            />
          ))}

          {clip.notes.map((note) => {
            const selected = selection.includes(note.id);
            const dimmed = selection.length > 0 && !selected;
            return (
              <div
                key={note.id}
                title={`${Math.round(note.velocity * 100)}%`}
                onDoubleClick={() => onAudition?.(note.pitch.midi, note.pitch.cents)}
                style={{
                  left: note.startTick * pxPerTick,
                  width: Math.max(3, note.lengthTick * pxPerTick - 1),
                  height: `${Math.max(2, note.velocity * 100)}%`,
                }}
                className={`absolute bottom-0 rounded-t-[2px] ${
                  selected
                    ? 'bg-teal-300'
                    : dimmed
                      ? 'bg-neutral-700'
                      : 'bg-teal-600/90'
                }`}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { useRef, useState } from 'react';

import type { AutomationMode, AutomationTarget, Project, Track } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { automationTargets } from '../audio/automation.ts';
import {
  addAutomationPoint, clearAutomationLane, deleteAutomationPoint, lanePoints, moveAutomationPoint, setAutomationMode,
} from '../editor/automationEdits.ts';

/**
 * 오토메이션 레인 — 트랙 바로 아래에 펼쳐지는 곡선 한 줄 (Logic 트랙 오토메이션).
 *
 * 빈 곳을 누르면 점, 점을 끌면 이동, 점을 두 번 누르면 삭제. 값은 0~1 로 저장되고
 * 표시만 대상의 단위로 바꾼다 (`automationTargets` 의 format). 왼쪽 칸은 트랙 행과
 * 같은 폭이라 세로선이 이어진다.
 */

export const LANE_H = 56;
const MODES: { mode: AutomationMode; label: string }[] = [
  { mode: 'read', label: '읽기' },
  { mode: 'touch', label: '터치' },
  { mode: 'latch', label: '래치' },
  { mode: 'write', label: '쓰기' },
];
const MINI = 'h-6 shrink-0 rounded border border-rule bg-body px-1.5 text-[11px] text-ink hover:border-ink-3';

export interface AutomationLaneProps {
  editor: ProjectEditor;
  track: Track;
  target: AutomationTarget;
  onTarget: (target: AutomationTarget) => void;
  nameCol: string;
  totalTicks: number;
  /** 가장 가까운 격자(1/16)로 — 끄려면 Alt */
  snap: (tick: number) => number;
}

export function AutomationLane({ editor, track, target, onTarget, nameCol, totalTicks, snap }: AutomationLaneProps) {
  const { project } = editor;
  const targets = automationTargets(track);
  const info = targets.find((t) => t.target === target)?.info ?? targets[0]!.info;
  const points = lanePoints(project, track.id, target);
  const box = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ index: number; origin: Project } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const toTickValue = (clientX: number, clientY: number, alt: boolean) => {
    const r = box.current!.getBoundingClientRect();
    const raw = ((clientX - r.left) / r.width) * totalTicks;
    const value = 1 - (clientY - r.top - 4) / (r.height - 8);
    return { tick: Math.max(0, alt ? Math.round(raw) : snap(raw)), value: Math.max(0, Math.min(1, value)) };
  };
  const x = (tick: number) => `${(tick / totalTicks) * 100}%`;
  const y = (value: number) => 4 + (1 - value) * (LANE_H - 8);

  // 곡선: 첫 점 앞·마지막 점 뒤는 그 값으로 평평하게 (렌더러와 같은 규칙)
  const flat = points.length === 0 ? info.current : null;
  const path = points.length === 0
    ? ''
    : [
      `M 0 ${y(points[0]!.value)}`,
      ...points.map((p) => `L ${(p.tick / totalTicks) * 1000} ${y(p.value)}`),
      `L 1000 ${y(points[points.length - 1]!.value)}`,
    ].join(' ');

  return (
    <div className="flex border-b border-grid" data-automation={`${track.name}:${target}`}>
      <div style={{ height: LANE_H }} className={`flex ${nameCol} shrink-0 flex-col justify-center gap-1 border-r border-rule bg-panel px-2 pl-6`}>
        <div className="flex items-center gap-1.5">
          <select
            aria-label={`${track.name} 오토메이션 대상`}
            value={target}
            onChange={(e) => onTarget(e.target.value as AutomationTarget)}
            className="h-6 min-w-0 flex-1 rounded border border-rule bg-body px-1 text-[11px] text-ink"
          >
            {targets.map((t) => (
              <option key={t.target} value={t.target}>
                {t.info.label}{track.automation.some((l) => l.target === t.target) ? ' ●' : ''}
              </option>
            ))}
          </select>
          <button type="button" className={MINI} disabled={points.length === 0}
            onClick={() => editor.commit(clearAutomationLane(project, track.id, target))}>곡선 지우기</button>
        </div>
        <div className="flex items-center gap-1" role="radiogroup" aria-label={`${track.name} 오토메이션 모드`}>
          {MODES.map(({ mode, label }) => {
            const on = (track.automationMode ?? 'read') === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => editor.commit(setAutomationMode(project, track.id, mode))}
                title={mode === 'read' ? '곡선대로 재생' : mode === 'touch' ? '재생 중 페이더를 잡는 동안 기록' : mode === 'latch' ? '한 번 잡으면 멈출 때까지 기록' : '재생 내내 지금 값으로 덮어씀'}
                className={`h-5 rounded px-1.5 text-[10px] ${on ? (mode === 'read' ? 'bg-ink text-body' : 'bg-rec text-body') : 'text-ink-3 hover:text-ink'}`}
              >{label}</button>
            );
          })}
          <span className="ml-auto font-num text-[12px] text-ink-2">{info.format(points[hover ?? -1]?.value ?? flat ?? points[0]?.value ?? info.current)}</span>
        </div>
      </div>
      <div
        ref={box}
        style={{ height: LANE_H }}
        className="relative flex-1 cursor-crosshair bg-screen-2"
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-point]')) return;
          const { tick, value } = toTickValue(e.clientX, e.clientY, e.altKey);
          editor.commit(addAutomationPoint(project, track.id, target, tick, value));
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const { tick, value } = toTickValue(e.clientX, e.clientY, e.altKey);
          editor.preview(moveAutomationPoint(drag.origin, track.id, target, drag.index, tick, value));
        }}
        onPointerUp={() => { if (drag) { setDrag(null); editor.commitCurrent(); } }}
      >
        <svg viewBox={`0 0 1000 ${LANE_H}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
          {flat !== null
            ? <line x1="0" x2="1000" y1={y(flat)} y2={y(flat)} stroke="var(--color-sink-3)" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
            : <path d={path} fill="none" stroke="var(--color-acc)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
        </svg>
        {points.map((p, i) => (
          <span
            key={`${p.tick}-${i}`}
            data-point
            role="button"
            aria-label={`점 ${i + 1} ${info.format(p.value)}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              setDrag({ index: i, origin: project });
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              const { tick, value } = toTickValue(e.clientX, e.clientY, e.altKey);
              editor.preview(moveAutomationPoint(drag.origin, track.id, target, drag.index, tick, value));
            }}
            onPointerUp={() => { if (drag) { setDrag(null); editor.commitCurrent(); } }}
            onDoubleClick={() => editor.commit(deleteAutomationPoint(project, track.id, target, i))}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            title="끌어서 옮기기 · 두 번 눌러 지우기"
            style={{ left: x(p.tick), top: y(p.value) }}
            className="absolute -ml-[5px] -mt-[5px] h-2.5 w-2.5 cursor-grab rounded-full border-2 border-acc bg-screen"
          />
        ))}
      </div>
    </div>
  );
}

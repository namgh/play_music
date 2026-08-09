import { useMemo } from 'react';

import type { Clip, Note } from '../model/project.ts';
import { curveMaxDeviationCents, sampleCurve } from '../model/curve.ts';
import { ticksToSeconds } from '../model/time.ts';
import { setPitchCurve } from '../editor/edits.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';

/**
 * 음정 곡선 레인 — **차별점 ① 의 입력 수단**.
 *
 * 조사해 보니 이걸 제대로 하는 DAW 가 없다:
 *  - FL Studio 의 노트 미세음정은 **10센트 단위**이고 곡선이 아니라 고정 오프셋이다
 *  - Cubase 는 인포라인에 센트 칸이 없다. 음별 음정은 Note Expression 을 지원하는
 *    악기(HALion 등)에서만 되고, 피치벤드가 -8192~8192 라 1센트=81.92포인트로 안 떨어진다
 *  - Pro Tools 는 음별 음정이 아예 없다
 *
 * 우리는 MIDI 를 쓰지 않고 `{midi, cents}` 를 저장 형식으로 쓰기 때문에 그 제약이 없다.
 *
 * ## 두 가지 모드
 *
 * **파라미터** — 글라이드·비브라토를 슬라이더로. 대부분의 경우 이걸로 충분하고,
 * 값이 숫자로 남아 나중에 다시 이해할 수 있다.
 *
 * **자유곡선** — 그래프를 직접 그린다 (`ROADMAP.md` S1-4). 엔진이 점 배열을 받는
 * 버퍼 ABI 를 갖게 되면서 가능해졌다. 점이 있으면 **글라이드·비브라토를 대신한다**
 * (`plan.md` 5-4) — 섞으면 그린 모양과 들리는 음정이 달라진다.
 *
 * 그래프와 소리가 어긋나지 않는 것은 `audio/pitchCurve.test.ts` 가 **실제 렌더한
 * 파형의 음정**과 화면 예측을 대조해 지킨다.
 */

const LANE_HEIGHT = 116;
const KEYS_WIDTH = 64;
/** y 축 최소 범위. 편차가 작아도 그래프가 납작해지지 않게 */
const MIN_RANGE_CENTS = 60;
const SAMPLES = 240;

export interface PitchCurveLaneProps {
  editor: ProjectEditor;
  clip: Clip;
  onAudition: (midi: number, cents: number) => void;
}

/** 슬라이더 하나 */
function Dial({
  label, value, min, max, step, unit, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 accent-teal-300"
      />
      <span className="w-16 shrink-0 text-right font-mono text-neutral-300">
        {value}{unit ?? ''}
      </span>
    </label>
  );
}

export function PitchCurveLane({ editor, clip, onAudition }: PitchCurveLaneProps) {
  const { project, selection } = editor;

  // 곡선은 음 하나에 붙는다. 여러 음을 고른 채로 편집하면 어느 음의 곡선인지 알 수 없다
  const note: Note | null = selection.length === 1
    ? clip.notes.find((n) => n.id === selection[0]) ?? null
    : null;

  const durationSec = note ? ticksToSeconds(note.lengthTick, project.tempo) : 0;
  const curve = note?.pitchCurve ?? null;

  const glideCents = curve?.glide?.cents ?? 0;
  const glideMs = curve?.glide?.ms ?? 80;
  const vibratoCents = curve?.vibrato?.cents ?? 0;
  const vibratoHz = curve?.vibrato?.hz ?? 5;
  const vibratoDelayMs = curve?.vibrato?.delayMs ?? 0;

  const samples = useMemo(
    () => (note ? sampleCurve(curve, durationSec, SAMPLES) : []),
    [curve, durationSec, note],
  );

  const rangeCents = Math.max(
    MIN_RANGE_CENTS, curveMaxDeviationCents(curve, durationSec) * 1.15,
  );
  const drawing = (curve?.points?.length ?? 0) > 0;

  /** 그래프를 눌러 점을 찍는다. 같은 자리를 다시 누르면 그 점을 지운다 */
  const onDraw = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!note) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const tNorm = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const cents = ((rect.height / 2 - (event.clientY - rect.top)) / (rect.height / 2)) * rangeCents;

    const existing = curve?.points ?? [];
    // 가까운 점을 누르면 지운다 — 지우는 수단이 없으면 실수를 되돌릴 방법이 없다
    const near = existing.findIndex((p) => Math.abs(p.tNorm - tNorm) < 0.03);
    const points = near >= 0
      ? existing.filter((_, i) => i !== near)
      : [...existing, { tNorm, cents: Math.round(cents * 10) / 10 }]
        .sort((a, b) => a.tNorm - b.tNorm);

    editor.commit(setPitchCurve(project, [note.id], {
      glide: curve?.glide ?? null,
      vibrato: curve?.vibrato ?? null,
      points: points.length > 0 ? points : null,
    }));
    onAudition(note.pitch.midi, note.pitch.cents);
  };

  const apply = (patch: {
    glideCents?: number; glideMs?: number;
    vibratoCents?: number; vibratoHz?: number; vibratoDelayMs?: number;
  }) => {
    if (!note) return;
    const g = { cents: patch.glideCents ?? glideCents, ms: patch.glideMs ?? glideMs };
    const v = {
      cents: patch.vibratoCents ?? vibratoCents,
      hz: patch.vibratoHz ?? vibratoHz,
      delayMs: patch.vibratoDelayMs ?? vibratoDelayMs,
    };
    // 값이 0 이면 곡선을 없앤다 — 빈 곡선 객체를 남기면 엔진이 검증된 올패스 경로를
    // 벗어나 보간 경로로 간다 (`string_voice.rs` 의 `is_flat`)
    const glide = g.cents === 0 ? null : g;
    const vibrato = v.cents === 0 ? null : v;
    const next = glide === null && vibrato === null ? null : { glide, vibrato, points: null };
    editor.commit(setPitchCurve(project, [note.id], next));
  };

  // SVG 경로. viewBox 를 0~100 × -50~50 으로 두면 스케일 계산이 단순해진다
  const path = samples.length === 0
    ? ''
    : samples
        .map((s, i) => {
          const x = durationSec > 0 ? (s.tSec / durationSec) * 100 : 0;
          const y = -(s.cents / rangeCents) * 50;
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(3)},${y.toFixed(3)}`;
        })
        .join(' ');

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex">
        <div
          className="flex shrink-0 items-end justify-end border-r border-neutral-800 px-2 pb-1"
          style={{ width: KEYS_WIDTH, height: LANE_HEIGHT }}
        >
          <span className="text-[9px] uppercase tracking-wider text-neutral-500">음정 곡선</span>
        </div>

        <div className="relative flex-1" style={{ height: LANE_HEIGHT }}>
          {note === null ? (
            <p className="flex h-full items-center px-4 text-xs text-neutral-500">
              {selection.length === 0
                ? '음 하나를 선택하면 음정 곡선을 편집할 수 있습니다'
                : `${selection.length}개가 선택됐습니다 — 곡선은 한 음씩 편집합니다`}
            </p>
          ) : (
            <>
              <svg
                viewBox="0 -50 100 100"
                preserveAspectRatio="none"
                className="h-full w-full cursor-crosshair"
                aria-label="음정 곡선 — 눌러서 점을 찍고, 점을 다시 누르면 지웁니다"
                onPointerDown={onDraw}
              >
                {/* 0센트 기준선 — 목표 음정 */}
                <line x1="0" y1="0" x2="100" y2="0" stroke="currentColor"
                  className="text-neutral-700" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
                {/* ±반음 눈금. 도→래 같은 큰 글라이드를 눈으로 읽을 수 있게 */}
                {[100, -100, 200, -200].filter((c) => Math.abs(c) < rangeCents).map((c) => (
                  <line
                    key={c}
                    x1="0" x2="100"
                    y1={-(c / rangeCents) * 50} y2={-(c / rangeCents) * 50}
                    stroke="currentColor" className="text-neutral-800"
                    strokeWidth="0.3" strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
                  />
                ))}
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  className={drawing ? 'text-amber-300' : 'text-teal-300'}
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
                {/* 찍은 점. 다시 누르면 지워진다 */}
                {(curve?.points ?? []).map((point) => (
                  <circle
                    key={`${point.tNorm}:${point.cents}`}
                    cx={point.tNorm * 100}
                    cy={-(point.cents / rangeCents) * 50}
                    r="1.4"
                    className="fill-amber-200"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
              <span className="pointer-events-none absolute left-2 top-1 font-mono text-[9px] text-neutral-500">
                ±{Math.round(rangeCents)}¢ · {durationSec.toFixed(2)}s
                {drawing && ' · 자유곡선'}
              </span>
              {drawing && (
                <button
                  type="button"
                  onClick={() => note && editor.commit(setPitchCurve(project, [note.id], {
                    glide: curve?.glide ?? null,
                    vibrato: curve?.vibrato ?? null,
                    points: null,
                  }))}
                  className="absolute right-2 top-1 rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-300"
                >
                  자유곡선 지우기
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {note !== null && (
        <div className="grid gap-1.5 border-t border-neutral-800 p-3 sm:grid-cols-2">
          {/* 글라이드 범위를 ±400센트로 둔다 — 온음(200)을 넘어야 "도에서 래까지"가 된다 */}
          {drawing && (
            <p className="mb-1 text-[10px] text-amber-300">
              자유곡선이 켜져 있어 아래 값은 소리에 반영되지 않습니다 — 그린 곡선이 우선입니다
            </p>
          )}
          <Dial
            label="시작 오프셋" value={Math.round(glideCents)} min={-400} max={400} step={1} unit="¢"
            onChange={(v) => apply({ glideCents: v })}
          />
          <Dial
            label="도달 시간" value={Math.round(glideMs)} min={5} max={2000} step={5} unit="ms"
            onChange={(v) => apply({ glideMs: v })}
          />
          <Dial
            label="흔들림 폭" value={Math.round(vibratoCents)} min={0} max={200} step={1} unit="¢"
            onChange={(v) => apply({ vibratoCents: v })}
          />
          <Dial
            label="흔들림 속도" value={Number(vibratoHz.toFixed(1))} min={0.5} max={12} step={0.1} unit="Hz"
            onChange={(v) => apply({ vibratoHz: v })}
          />
          <Dial
            label="흔들림 지연" value={Math.round(vibratoDelayMs)} min={0} max={1000} step={10} unit="ms"
            onChange={(v) => apply({ vibratoDelayMs: v })}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onAudition(note.pitch.midi, note.pitch.cents)}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-600"
            >
              들어보기
            </button>
            <button
              type="button"
              disabled={curve === null}
              onClick={() => editor.commit(setPitchCurve(project, [note.id], null))}
              className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-400 disabled:opacity-40"
            >
              곡선 지우기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

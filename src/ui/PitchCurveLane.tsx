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
 * ## 왜 자유곡선을 그리게 하지 않나
 *
 * 엔진의 `PitchCurve` 는 글라이드·비브라토 5개 값만 받는다 (`curve.rs`).
 * 자유곡선(`points`)은 wasm 에 점 배열을 넘기는 **새 버퍼 ABI** 가 필요하고 그건 별도
 * 작업이다. 지원하는 척하면 화면에는 그려지고 소리에는 없는 상태가 되고, 그게 예전에
 * 실제로 났던 버그다.
 *
 * 대신 **글라이드·비브라토를 그래프로 보면서** 조정한다. 사용자가 얻는 것은 같다 —
 * "도에서 래까지 어떤 모양으로 올라갈지"를 눈으로 확인하며 만든다. 글라이드 폭은
 * 온음(200센트)을 넘어도 되므로 도→래가 지금 바로 된다.
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

  const rangeCents = Math.max(MIN_RANGE_CENTS, curveMaxDeviationCents(curve) * 1.15);

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
                className="h-full w-full"
                aria-label="음정 곡선"
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
                  className="text-teal-300"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span className="pointer-events-none absolute left-2 top-1 font-mono text-[9px] text-neutral-500">
                ±{Math.round(rangeCents)}¢ · {durationSec.toFixed(2)}s
              </span>
            </>
          )}
        </div>
      </div>

      {note !== null && (
        <div className="grid gap-1.5 border-t border-neutral-800 p-3 sm:grid-cols-2">
          {/* 글라이드 범위를 ±400센트로 둔다 — 온음(200)을 넘어야 "도에서 래까지"가 된다 */}
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

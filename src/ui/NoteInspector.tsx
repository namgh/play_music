import { useEffect, useState } from 'react';

import type { NoteId, PitchCurve, Project } from '../model/project.ts';
import {
  findNote, moveNotes, nudgeCents, setCents, setPitch, setPitchCurve, setVelocity,
} from '../editor/edits.ts';
import { formatPitch, hzToPitch, pitchName, pitchToHz } from '../model/pitch.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';

/**
 * 선택한 음의 정밀 편집. 차별점 ①(음 단위 정밀 수정)이 사용자에게 닿는 지점이다.
 * 시안은 `mockup/studio-v2.html` 의 센트 다이얼 + 주파수 입력.
 *
 * 세 가지 입력 경로가 모두 같은 데이터를 가리킨다:
 *  반음 버튼 → `midi`, 센트 슬라이더 → `cents`, 주파수 입력 → 둘 다 (환산)
 */

export interface NoteInspectorProps {
  editor: ProjectEditor;
  onAudition: (midi: number, cents: number) => void;
}

export function NoteInspector({ editor, onAudition }: NoteInspectorProps) {
  const { project, selection } = editor;
  const primaryId: NoteId | undefined = selection[0];
  const found = primaryId === undefined ? null : findNote(project, primaryId);

  const [hzDraft, setHzDraft] = useState('');
  const [hzError, setHzError] = useState(false);

  const currentHz = found ? pitchToHz(found.note.pitch, project.tuning) : 0;
  useEffect(() => {
    setHzDraft(found ? currentHz.toFixed(2) : '');
    setHzError(false);
  }, [found, currentHz]);

  if (!found) {
    return (
      <aside className="rounded-lg border border-neutral-800 p-4 text-sm text-neutral-500">
        음을 선택하면 정밀 편집이 열립니다. 격자를 클릭하면 음이 추가됩니다.
      </aside>
    );
  }

  const { note } = found;
  const audition = (next: Project) => {
    const updated = findNote(next, note.id);
    if (updated) onAudition(updated.note.pitch.midi, updated.note.pitch.cents);
  };

  const apply = (next: Project) => {
    editor.commit(next);
    audition(next);
  };

  const commitHz = () => {
    const value = Number.parseFloat(hzDraft);
    if (!Number.isFinite(value) || value <= 0) {
      setHzError(true);
      return;
    }
    setHzError(false);
    apply(setPitch(project, note.id, hzToPitch(value, project.tuning)));
  };

  return (
    <aside className="space-y-5 rounded-lg border border-neutral-800 p-4">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">선택한 음</h2>
        <p className="mt-1 font-mono text-lg text-white">{formatPitch(note.pitch, project.tuning)}</p>
        {selection.length > 1 && (
          <p className="mt-1 text-xs text-neutral-500">{selection.length}개 선택 — 편집은 전체에 적용됩니다</p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-500">반음</span>
          <span className="font-mono text-sm">{pitchName(note.pitch)}</span>
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => apply(moveNotes(project, selection, { semitones: -1 }))}
            className="flex-1 rounded border border-neutral-700 py-1.5 text-sm hover:border-neutral-500">−1</button>
          <button type="button" onClick={() => apply(moveNotes(project, selection, { semitones: 1 }))}
            className="flex-1 rounded border border-neutral-700 py-1.5 text-sm hover:border-neutral-500">＋1</button>
          <button type="button" onClick={() => apply(moveNotes(project, selection, { semitones: -12 }))}
            className="flex-1 rounded border border-neutral-700 py-1.5 text-sm hover:border-neutral-500">−12</button>
          <button type="button" onClick={() => apply(moveNotes(project, selection, { semitones: 12 }))}
            className="flex-1 rounded border border-neutral-700 py-1.5 text-sm hover:border-neutral-500">＋12</button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-500">미세조정</span>
          <span className="font-mono text-sm text-teal-300">
            {note.pitch.cents > 0 ? '+' : ''}{note.pitch.cents.toFixed(1)} ¢
          </span>
        </div>
        <input
          type="range"
          min={-50}
          max={50}
          step={0.1}
          value={note.pitch.cents}
          aria-label="센트 단위 미세조정"
          onChange={(e) => editor.preview(setCents(project, selection, Number(e.target.value)))}
          onPointerUp={() => { editor.commitCurrent(); audition(project); }}
          onKeyUp={() => editor.commitCurrent()}
          className="mt-2 w-full accent-teal-300"
        />
        <div className="mt-1 flex gap-2">
          {[-10, -1, 1, 10].map((delta) => (
            <button
              key={delta}
              type="button"
              onClick={() => apply(nudgeCents(project, selection, delta))}
              className="flex-1 rounded border border-neutral-800 py-1 font-mono text-xs text-neutral-400 hover:border-neutral-600"
            >
              {delta > 0 ? '+' : ''}{delta}¢
            </button>
          ))}
        </div>
      </div>

      <div>
        <label htmlFor="hz" className="text-xs text-neutral-500">주파수 직접 지정</label>
        <div className="mt-2 flex items-center gap-2">
          <input
            id="hz"
            inputMode="decimal"
            value={hzDraft}
            onChange={(e) => setHzDraft(e.target.value)}
            onBlur={commitHz}
            onKeyDown={(e) => { if (e.key === 'Enter') commitHz(); }}
            className={`w-full rounded border bg-neutral-900 px-2 py-1.5 font-mono text-sm ${
              hzError ? 'border-red-700' : 'border-neutral-700'
            }`}
          />
          <span className="text-xs text-neutral-500">Hz</span>
        </div>
        {hzError && <p className="mt-1 text-xs text-red-400">양수만 입력하세요</p>}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-500">세기</span>
          <span className="font-mono text-sm">{note.velocity.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0} max={1} step={0.01}
          value={note.velocity}
          aria-label="세기"
          onChange={(e) => editor.preview(setVelocity(project, selection, Number(e.target.value)))}
          onPointerUp={() => editor.commitCurrent()}
          className="mt-2 w-full accent-teal-300"
        />
      </div>

      <CurveEditor editor={editor} onApplied={audition} />

      <p className="border-t border-neutral-800 pt-3 text-xs text-neutral-500">
        이 수정은 기기 안에서 바로 처리됩니다. AI 를 다시 부르지 않으니 나머지 소리는 그대로입니다.
      </p>
    </aside>
  );
}


/**
 * 음정 곡선 — 목업의 "시작 글라이드 / 흔들림".
 *
 * `plan.md` 5-1 이 Phase 1 에 넣은 항목이고 차별점 ①의 핵심이다.
 * 값이 0이면 곡선이 없는 것으로 취급하고, 그때는 엔진이 검증된 올패스 경로를 쓴다.
 */
function CurveEditor({
  editor,
  onApplied,
}: {
  editor: ProjectEditor;
  onApplied: (next: Project) => void;
}) {
  const { project, selection } = editor;
  const primaryId = selection[0];
  const found = primaryId === undefined ? null : findNote(project, primaryId);
  if (!found) return null;

  const curve = found.note.pitchCurve;
  const glideCents = curve?.glide?.cents ?? 0;
  const glideMs = curve?.glide?.ms ?? 80;
  const vibratoCents = curve?.vibrato?.cents ?? 0;
  const vibratoHz = curve?.vibrato?.hz ?? 5;
  const vibratoDelayMs = curve?.vibrato?.delayMs ?? 120;

  const write = (next: Partial<{
    glideCents: number; glideMs: number;
    vibratoCents: number; vibratoHz: number; vibratoDelayMs: number;
  }>, commit: boolean) => {
    const merged = {
      glideCents, glideMs, vibratoCents, vibratoHz, vibratoDelayMs, ...next,
    };
    const value: PitchCurve = {
      glide: merged.glideCents === 0 ? null : { cents: merged.glideCents, ms: merged.glideMs },
      vibrato: merged.vibratoCents === 0
        ? null
        : { cents: merged.vibratoCents, hz: merged.vibratoHz, delayMs: merged.vibratoDelayMs },
      points: null,
    };
    const flat = value.glide === null && value.vibrato === null;
    const updated = setPitchCurve(project, selection, flat ? null : value);
    if (commit) {
      editor.commit(updated);
      onApplied(updated);
    } else {
      editor.preview(updated);
    }
  };

  const row = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    unit: string,
    key: 'glideCents' | 'glideMs' | 'vibratoCents' | 'vibratoHz' | 'vibratoDelayMs',
  ) => (
    <div className="grid grid-cols-[5.5rem_1fr_4rem] items-center gap-2">
      <label htmlFor={`c-${key}`} className="text-xs text-neutral-500">{label}</label>
      <input
        id={`c-${key}`}
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => write({ [key]: Number(e.target.value) }, false)}
        onPointerUp={(e) => write({ [key]: Number((e.target as HTMLInputElement).value) }, true)}
        className="accent-teal-300"
      />
      <span className="text-right font-mono text-xs text-neutral-300">
        {value}{unit}
      </span>
    </div>
  );

  return (
    <div className="space-y-2 border-t border-neutral-800 pt-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-neutral-500">음정 곡선</span>
        {curve && (
          <button
            type="button"
            onClick={() => { const next = setPitchCurve(project, selection, null); editor.commit(next); }}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            곡선 지우기
          </button>
        )}
      </div>
      {row('시작 글라이드', glideCents, -80, 80, 1, ' ¢', 'glideCents')}
      {glideCents !== 0 && row('도달 시간', glideMs, 10, 400, 5, ' ms', 'glideMs')}
      {row('흔들림', vibratoCents, 0, 60, 1, ' ¢', 'vibratoCents')}
      {vibratoCents !== 0 && row('흔들림 속도', vibratoHz, 1, 12, 0.1, ' Hz', 'vibratoHz')}
      {vibratoCents !== 0 && row('흔들림 지연', vibratoDelayMs, 0, 600, 10, ' ms', 'vibratoDelayMs')}
      <p className="text-xs text-neutral-500">
        곡선이 붙은 음은 편집기에서 다른 색으로 보입니다. 값을 0으로 두면 곡선이 없는
        것으로 처리되고, 그때는 엔진이 음정 정확도가 검증된 경로를 씁니다.
      </p>
    </div>
  );
}

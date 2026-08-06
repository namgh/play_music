import type { EffectSpec, Track } from '../model/project.ts';
import { updateTrack } from '../editor/edits.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { createEffect, EFFECT_SPECS, isEffectType } from '../audio/effects.ts';
import type { EffectType } from '../audio/effects.ts';

/**
 * 믹서 — 레벨·팬·이펙트 (`plan.md` 5-1 Phase 1 기본기).
 *
 * 이펙트 파라미터 UI 는 `EFFECT_SPECS` 선언에서 자동 생성한다. 악기 파라미터와
 * 같은 원칙(`sound.md` 9-5) — 이펙트를 추가할 때 화면을 손으로 만들지 않는다.
 */

const EFFECT_TYPES = Object.keys(EFFECT_SPECS) as EffectType[];

export interface MixerProps {
  editor: ProjectEditor;
}

export function Mixer({ editor }: MixerProps) {
  const { project } = editor;

  const setEffects = (track: Track, effects: EffectSpec[], commit = true) => {
    const next = updateTrack(project, track.id, { effects });
    if (commit) editor.commit(next);
    else editor.preview(next);
  };

  const setMaster = (patch: Partial<{ gain: number; effects: EffectSpec[] }>, commit = true) => {
    const next = { ...project, master: { ...project.master, ...patch } };
    if (commit) editor.commit(next);
    else editor.preview(next);
  };

  return (
    <section className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">믹서</h2>
        <span className="text-xs text-neutral-500">
          이펙트는 Web Audio 내장 노드다 (`plan.md` 5-2 "다듬는 층") — 재생과 내보내기가 같은 그래프를 쓴다
        </span>
      </div>

      {project.tracks.length === 0 && (
        <p className="rounded-lg border border-dashed border-neutral-800 p-4 text-sm text-neutral-500">
          트랙이 없습니다.
        </p>
      )}

      {project.tracks.map((track) => (
        <div key={track.id} className="rounded-lg border border-neutral-800 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-200">
              {track.name}
            </span>

            <Knob
              label="레벨"
              value={track.gain}
              min={0} max={1} step={0.01}
              format={(v) => `${Math.round(v * 100)}`}
              onInput={(v) => editor.preview(updateTrack(project, track.id, { gain: v }))}
              onCommit={() => editor.commitCurrent()}
            />
            <Knob
              label="팬"
              value={track.pan}
              min={-1} max={1} step={0.01}
              format={(v) => (Math.abs(v) < 0.01 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`)}
              onInput={(v) => editor.preview(updateTrack(project, track.id, { pan: v }))}
              onCommit={() => editor.commitCurrent()}
            />

            <select
              aria-label={`${track.name} 이펙트 추가`}
              value=""
              onChange={(e) => {
                if (!isEffectType(e.target.value)) return;
                setEffects(track, [...track.effects, createEffect(e.target.value)]);
              }}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
            >
              <option value="">＋ 이펙트</option>
              {EFFECT_TYPES.map((type) => (
                <option key={type} value={type}>{EFFECT_SPECS[type].label}</option>
              ))}
            </select>
          </div>

          {track.effects.length > 0 && (
            <div className="mt-3 space-y-3">
              {track.effects.map((effect, index) => (
                <EffectPanel
                  key={`${effect.type}-${index}`}
                  effect={effect}
                  onChange={(next, commit) => {
                    const effects = [...track.effects];
                    effects[index] = next;
                    setEffects(track, effects, commit);
                  }}
                  onRemove={() => setEffects(track, track.effects.filter((_, i) => i !== index))}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="rounded-lg border border-teal-900/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1 text-sm font-medium text-teal-200">마스터</span>
          <Knob
            label="레벨"
            value={project.master.gain}
            min={0} max={2} step={0.01}
            format={(v) => v.toFixed(2)}
            onInput={(v) => setMaster({ gain: v }, false)}
            onCommit={() => editor.commitCurrent()}
          />
          <select
            aria-label="마스터 이펙트 추가"
            value=""
            onChange={(e) => {
              if (!isEffectType(e.target.value)) return;
              setMaster({ effects: [...project.master.effects, createEffect(e.target.value)] });
            }}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
          >
            <option value="">＋ 이펙트</option>
            {EFFECT_TYPES.map((type) => (
              <option key={type} value={type}>{EFFECT_SPECS[type].label}</option>
            ))}
          </select>
        </div>

        {project.master.effects.length > 0 && (
          <div className="mt-3 space-y-3">
            {project.master.effects.map((effect, index) => (
              <EffectPanel
                key={`${effect.type}-${index}`}
                effect={effect}
                onChange={(next, commit) => {
                  const effects = [...project.master.effects];
                  effects[index] = next;
                  setMaster({ effects }, commit);
                }}
                onRemove={() =>
                  setMaster({ effects: project.master.effects.filter((_, i) => i !== index) })}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Knob({
  label, value, min, max, step, format, onInput, onCommit,
}: {
  label: string;
  value: number;
  min: number; max: number; step: number;
  format: (value: number) => string;
  onInput: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-500">
      {label}
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="w-24 accent-teal-300"
      />
      <span className="w-10 text-right font-mono text-neutral-300">{format(value)}</span>
    </label>
  );
}

/** 이펙트 하나. 파라미터 슬라이더는 선언에서 자동 생성된다 */
function EffectPanel({
  effect, onChange, onRemove,
}: {
  effect: EffectSpec;
  onChange: (next: EffectSpec, commit: boolean) => void;
  onRemove: () => void;
}) {
  if (!isEffectType(effect.type)) {
    return (
      <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        알 수 없는 이펙트 &quot;{effect.type}&quot; — 이 프로젝트는 더 새로운 버전에서 만들어졌을 수 있습니다.
        <button type="button" onClick={onRemove} className="ml-2 underline">제거</button>
      </p>
    );
  }

  const declared = EFFECT_SPECS[effect.type];
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium text-neutral-300">{declared.label}</span>
        <button
          type="button"
          aria-pressed={effect.bypass}
          onClick={() => onChange({ ...effect, bypass: !effect.bypass }, true)}
          className={`rounded border px-2 py-0.5 text-[10px] ${
            effect.bypass ? 'border-neutral-600 text-neutral-500' : 'border-teal-400 text-teal-300'
          }`}
        >
          {effect.bypass ? '꺼짐' : '켜짐'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${declared.label} 제거`}
          className="px-1 text-xs text-neutral-500 hover:text-red-400"
        >
          ✕
        </button>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {Object.entries(declared.params).map(([key, spec]) => {
          const raw = effect.params[key];
          const value = typeof raw === 'number' ? raw : spec.default;
          return (
            <div key={key} className="grid grid-cols-[5rem_1fr_3.5rem] items-center gap-2">
              <label htmlFor={`fx-${key}`} className="text-[11px] text-neutral-500">{spec.label}</label>
              <input
                id={`fx-${key}`}
                type="range"
                min={spec.min} max={spec.max}
                step={(spec.max - spec.min) / 200}
                value={value}
                onChange={(e) =>
                  onChange({ ...effect, params: { ...effect.params, [key]: Number(e.target.value) } }, false)}
                onPointerUp={(e) =>
                  onChange(
                    { ...effect, params: { ...effect.params, [key]: Number((e.target as HTMLInputElement).value) } },
                    true,
                  )}
                className="accent-teal-300"
              />
              <span className="text-right font-mono text-[11px] text-neutral-400">
                {value.toFixed(spec.max > 100 ? 0 : 1)}{spec.unit ?? ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

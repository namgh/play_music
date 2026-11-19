import { useRef, useState } from 'react';

import type { MidiEffect, Project, Track } from '../model/project.ts';
import type { ParamSpec, ResolvedInstrument } from '../instruments/types.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { updateTrack } from '../editor/edits.ts';
import { EFFECT_SPECS, isEffectType } from '../audio/effects.ts';
import { createMidiEffect, MIDI_EFFECT_LABELS } from '../audio/midiEffects.ts';
import { PPQ } from '../model/time.ts';
import type { SmartMap } from '../model/project.ts';
import { isIdentity, mapKnob, unmapKnob } from '../editor/smartMap.ts';

/**
 * 스마트 컨트롤 + MIDI 이펙트 (Logic Smart Controls · MIDI plug-ins, `LOGIC_PARITY.md` 1-10).
 *
 * 손잡이 8개 — 처음에는 자동으로 고른다(볼륨·팬·악기의 앞쪽 파라미터·이펙트). 손잡이
 * 아래 이름을 눌러 **무엇에 물릴지 바꾼다**(매핑). 매핑은 트랙에 저장된다.
 * 대상 표기: `volume` · `pan` · `tone:<파라미터>` · `fx:<순번>:<파라미터>`.
 */

interface Target {
  id: string;
  label: string;
  min: number;
  max: number;
  log: boolean;
  get: () => number;
  set: (project: Project, v: number) => Project;
}

function targetsFor(track: Track, instrument: ResolvedInstrument | null, params: Record<string, number | string>): Target[] {
  const out: Target[] = [
    { id: 'volume', label: '볼륨', min: 0, max: 1, log: false, get: () => track.gain, set: (p, v) => updateTrack(p, track.id, { gain: v }) },
    { id: 'pan', label: '팬', min: -1, max: 1, log: false, get: () => track.pan, set: (p, v) => updateTrack(p, track.id, { pan: v }) },
  ];
  for (const [key, spec] of Object.entries(instrument?.paramSpecs ?? {}) as [string, ParamSpec][]) {
    if (spec.type !== 'float' || spec.min === undefined || spec.max === undefined) continue;
    out.push({
      id: `tone:${key}`, label: spec.label, min: spec.min, max: spec.max, log: spec.curve === 'log' && spec.min > 0,
      get: () => Number(params[key] ?? spec.default),
      set: (p, v) => updateTrack(p, track.id, { toneParams: { ...(track.toneParams ?? {}), [key]: v } }),
    });
  }
  track.effects.forEach((fx, i) => {
    if (!isEffectType(fx.type)) return;
    for (const [key, spec] of Object.entries(EFFECT_SPECS[fx.type].params)) {
      out.push({
        id: `fx:${i}:${key}`, label: `${EFFECT_SPECS[fx.type].label} ${spec.label}`, min: spec.min, max: spec.max, log: spec.curve === 'log' && spec.min > 0,
        get: () => Number(fx.params[key] ?? spec.default),
        set: (p, v) => {
          const effects = [...track.effects];
          effects[i] = { ...fx, params: { ...fx.params, [key]: v } };
          return updateTrack(p, track.id, { effects });
        },
      });
    }
  });
  return out;
}

/** 손잡이 매핑 창 — 곡선 그림 · 곡선 · 범위 · 거꾸로 · 함께 움직일 대상 */
function MapEditor({ slot, map, targets, onChange }: { slot: number; map: SmartMap; targets: Target[]; onChange: (patch: Partial<SmartMap>) => void }) {
  const pts = Array.from({ length: 33 }, (_, i) => { const x = i / 32; return `${i === 0 ? 'M' : 'L'}${x * 100},${(1 - mapKnob(x, map)) * 40}`; }).join(' ');
  const row = 'grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-1.5 text-[10px] text-sink-2';
  return (
    <div className="mt-3 flex flex-col gap-1.5 rounded-lg bg-screen-2 p-2" data-smart-map>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-sink">손잡이 {slot + 1} 매핑</span>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-8 flex-1 rounded bg-screen" aria-label="매핑 곡선">
          <path d={pts} fill="none" stroke="var(--color-acc)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <label className={row}>곡선
        <input type="range" aria-label="매핑 곡선" min={-1} max={1} step={0.05} value={map.curve ?? 0} onChange={(e) => onChange({ curve: Number(e.target.value) })} className="accent-acc" />
        <span className="text-right font-num text-[12px] text-sink">{(map.curve ?? 0).toFixed(2)}</span></label>
      <label className={row}>최소
        <input type="range" aria-label="매핑 최소" min={0} max={1} step={0.01} value={map.min ?? 0} onChange={(e) => onChange({ min: Number(e.target.value) })} className="accent-acc" />
        <span className="text-right font-num text-[12px] text-sink">{Math.round((map.min ?? 0) * 100)}%</span></label>
      <label className={row}>최대
        <input type="range" aria-label="매핑 최대" min={0} max={1} step={0.01} value={map.max ?? 1} onChange={(e) => onChange({ max: Number(e.target.value) })} className="accent-acc" />
        <span className="text-right font-num text-[12px] text-sink">{Math.round((map.max ?? 1) * 100)}%</span></label>
      <label className="flex items-center gap-1.5 text-[10px] text-sink-2">
        <input type="checkbox" checked={!!map.invert} onChange={(e) => onChange({ invert: e.target.checked })} />거꾸로
      </label>
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-sink-2">함께
        {(map.extra ?? []).map((id) => (
          <button key={id} type="button" onClick={() => onChange({ extra: (map.extra ?? []).filter((x) => x !== id) })}
            className="rounded bg-screen px-1.5 py-0.5 text-sink" title="빼기">{targets.find((t) => t.id === id)?.label ?? id} ✕</button>
        ))}
        <select aria-label="함께 움직일 대상" value="" onChange={(e) => { if (e.target.value) onChange({ extra: [...(map.extra ?? []), e.target.value] }); }}
          className="rounded bg-transparent text-[10px] text-sink-2">
          <option value="">＋ 대상</option>
          {targets.filter((t) => !(map.extra ?? []).includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>
    </div>
  );
}

const to01 = (t: Target, v: number) => (t.log ? Math.log(v / t.min) / Math.log(t.max / t.min) : (v - t.min) / (t.max - t.min));
const from01 = (t: Target, x: number) => {
  const c = Math.max(0, Math.min(1, x));
  return t.log ? t.min * Math.pow(t.max / t.min, c) : t.min + (t.max - t.min) * c;
};
const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toString() : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export interface SmartControlsProps {
  editor: ProjectEditor;
  track: Track;
  instrument: ResolvedInstrument | null;
  params: Record<string, number | string>;
}

export function SmartControls({ editor, track, instrument, params }: SmartControlsProps) {
  const { project } = editor;
  const all = targetsFor(track, instrument, params);
  const chosen = (track.smartControls && track.smartControls.length > 0
    ? track.smartControls.map((id) => all.find((t) => t.id === id)).filter((t): t is Target => !!t)
    : all).slice(0, 8);

  const remap = (slot: number, id: string) => {
    const ids = chosen.map((t) => t.id);
    ids[slot] = id;
    editor.commit(updateTrack(project, track.id, { smartControls: ids }));
  };
  // 매핑 — 손잡이마다 곡선·범위·거꾸로·함께 움직일 대상 (`PARITY_ROUND2.md` 15)
  const maps = track.smartMaps ?? [];
  const [editing, setEditing] = useState<number | null>(null);
  const setMap = (slot: number, patch: Partial<SmartMap>) => {
    const next = chosen.map((_, i) => ({ ...(maps[i] ?? {}) }));
    next[slot] = { ...next[slot], ...patch };
    // 손잡이 매핑을 저장하려면 대상 목록도 굳힌다 (자동 고르기가 바뀌면 자리가 어긋난다)
    editor.commit(updateTrack(project, track.id, { smartMaps: next, smartControls: chosen.map((t) => t.id) }));
  };
  /** 손잡이 위치 x → 첫 대상과 함께 움직이는 대상 모두에 */
  const turn = (slot: number, x: number) => {
    const map = maps[slot];
    const y = mapKnob(x, map);
    let next = chosen[slot]!.set(project, from01(chosen[slot]!, y));
    for (const id of map?.extra ?? []) {
      // 대상은 지금 곡 상태로 다시 찾는다 — 앞 대상을 바꾼 결과 위에 쓴다
      const t = targetsFor(next.tracks.find((x) => x.id === track.id) ?? track, instrument, params).find((o) => o.id === id);
      if (t) next = t.set(next, from01(t, y));
    }
    editor.preview(next);
  };

  const fxList = track.midiEffects ?? [];
  const setFx = (list: MidiEffect[]) => editor.commit(updateTrack(project, track.id, { midiEffects: list }));
  const patchFx = (i: number, patch: Partial<MidiEffect>) => setFx(fxList.map((fx, j) => (j === i ? { ...fx, ...patch } as MidiEffect : fx)));

  return (
    <div className="flex flex-col gap-3" data-smart-controls>
      <div className="rounded-xl bg-screen p-3">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-xs font-semibold text-sink">{track.name}</span>
          <span className="text-[10px] text-sink-3">스마트 컨트롤 · 끌어서 돌리기 · 두 번 눌러 처음 값</span>
        </div>
        <div className="grid grid-cols-4 gap-x-2 gap-y-3">
          {chosen.map((t, slot) => (
            <div key={`${slot}-${t.id}`} className="flex flex-col items-center gap-1">
              <Knob
                label={t.label}
                value01={unmapKnob(to01(t, t.get()), maps[slot])}
                onPreview={(x) => turn(slot, x)}
                onCommit={() => editor.commitCurrent()}
                onReset={() => editor.commit(t.set(project, t.id === 'pan' ? 0 : t.get()))}
              />
              <span className="flex items-center gap-1 font-num text-[12px] text-sink">
                {fmt(t.get())}
                <button type="button" aria-label={`손잡이 ${slot + 1} 매핑`} aria-pressed={editing === slot}
                  onClick={() => setEditing(editing === slot ? null : slot)}
                  className={`rounded px-0.5 text-[10px] ${!isIdentity(maps[slot]) ? 'text-acc' : 'text-sink-3'} hover:text-sink`}>⚙</button>
              </span>
              <select aria-label={`손잡이 ${slot + 1} 대상`} value={t.id} onChange={(e) => remap(slot, e.target.value)}
                className="w-full truncate rounded bg-transparent text-center text-[10px] text-sink-2 hover:text-sink">
                {all.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          ))}
        </div>
        {editing !== null && chosen[editing] && (
          <MapEditor
            slot={editing}
            map={maps[editing] ?? {}}
            targets={all.filter((o) => o.id !== chosen[editing]!.id)}
            onChange={(patch) => setMap(editing, patch)}
          />
        )}
      </div>

      <div className="rounded-xl border border-rule bg-panel p-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="flex-1 text-[11px] font-semibold text-ink-2">MIDI 이펙트 — 음은 그대로, 소리만 바뀜</span>
          <select aria-label="MIDI 이펙트 추가" value="" className="h-6 rounded border border-rule bg-body px-1 text-[11px]"
            onChange={(e) => { if (e.target.value) setFx([...fxList, createMidiEffect(e.target.value as MidiEffect['type'])]); }}>
            <option value="">＋ 추가</option>
            {(Object.keys(MIDI_EFFECT_LABELS) as MidiEffect['type'][]).map((k) => <option key={k} value={k}>{MIDI_EFFECT_LABELS[k]}</option>)}
          </select>
        </div>
        {fxList.length === 0 && <p className="text-[11px] text-ink-3">없음 — 아르페지에이터를 넣으면 화음이 자동으로 쪼개져 울립니다</p>}
        {fxList.map((fx, i) => (
          <div key={`${fx.type}-${i}`} className="mb-1.5 rounded-lg border border-rule bg-body p-2 last:mb-0" data-midi-fx={fx.type}>
            <div className="mb-1 flex items-center gap-1.5">
              <span className={`flex-1 text-xs font-semibold ${fx.bypass ? 'text-ink-3 line-through' : 'text-ink'}`}>{MIDI_EFFECT_LABELS[fx.type]}</span>
              <button type="button" aria-pressed={!fx.bypass} onClick={() => patchFx(i, { bypass: !fx.bypass })}
                className={`h-6 rounded border px-1.5 text-[11px] ${fx.bypass ? 'border-rule text-ink-3' : 'border-ink bg-ink text-body'}`}>{fx.bypass ? '꺼짐' : '켜짐'}</button>
              <button type="button" onClick={() => setFx(fxList.filter((_, j) => j !== i))} aria-label={`${MIDI_EFFECT_LABELS[fx.type]} 지우기`}
                className="h-6 rounded border border-rule px-1.5 text-[11px] text-ink-3 hover:text-rec">✕</button>
            </div>
            <MidiFxFields fx={fx} onPatch={(patch) => patchFx(i, patch)} />
          </div>
        ))}
      </div>
    </div>
  );
}

const SEL = 'h-6 min-w-0 rounded border border-rule bg-body px-1 text-[11px] text-ink';
const RATE_OPTIONS = [[PPQ, '1/4'], [PPQ / 2, '1/8'], [PPQ / 4, '1/16'], [PPQ / 8, '1/32'], [PPQ / 3, '1/8 셋잇단']] as const;

function MidiFxFields({ fx, onPatch }: { fx: MidiEffect; onPatch: (patch: Partial<MidiEffect>) => void }) {
  const num = (label: string, value: number, min: number, max: number, step: number, key: string) => (
    <label className="flex items-center gap-1 text-[11px] text-ink-2">{label}
      <input aria-label={label} type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => onPatch({ [key]: Number(e.target.value) } as Partial<MidiEffect>)} className={`${SEL} w-14 text-right`} />
    </label>
  );
  switch (fx.type) {
    case 'arpeggiator':
      return (
        <div className="flex flex-wrap gap-1.5">
          <select aria-label="아르페지오 방향" value={fx.mode} onChange={(e) => onPatch({ mode: e.target.value as typeof fx.mode })} className={SEL}>
            <option value="up">위로</option><option value="down">아래로</option><option value="updown">위아래</option><option value="random">무작위</option><option value="played">친 순서</option>
          </select>
          <select aria-label="아르페지오 빠르기" value={fx.rate} onChange={(e) => onPatch({ rate: Number(e.target.value) })} className={SEL}>
            {RATE_OPTIONS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
          </select>
          {num('옥타브', fx.octaves, 1, 4, 1, 'octaves')}
          {num('게이트', fx.gate, 0.1, 1, 0.05, 'gate')}
        </div>
      );
    case 'chordTrigger':
      return (
        <select aria-label="코드 모양" value={fx.intervals.join(',')} onChange={(e) => onPatch({ intervals: e.target.value.split(',').map(Number) })} className={SEL}>
          {[['0,4,7', '장3화음'], ['0,3,7', '단3화음'], ['0,7', '파워 코드'], ['0,7,12', '5도+옥타브'], ['0,4,7,11', '장7'], ['0,3,7,10', '단7'], ['0,5,7', 'sus4'], ['0,12', '옥타브']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      );
    case 'transposer':
      return num('반음', fx.semitones, -48, 48, 1, 'semitones');
    case 'velocity':
      return (
        <div className="flex gap-1.5">
          <select aria-label="세기 처리 방식" value={fx.mode} onChange={(e) => onPatch({ mode: e.target.value as typeof fx.mode })} className={SEL}>
            <option value="scale">배율</option><option value="add">더하기</option><option value="fixed">고정</option>
          </select>
          {num('값', fx.value, -1, 4, 0.05, 'value')}
        </div>
      );
    case 'noteRepeater':
      return (
        <div className="flex flex-wrap gap-1.5">
          {num('횟수', fx.repeats, 0, 16, 1, 'repeats')}
          <select aria-label="리피트 간격" value={fx.delay} onChange={(e) => onPatch({ delay: Number(e.target.value) })} className={SEL}>
            {RATE_OPTIONS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
          </select>
          {num('감쇠', fx.feedback, 0, 1, 0.05, 'feedback')}
          {num('음높이', fx.transpose, -12, 12, 1, 'transpose')}
        </div>
      );
    case 'randomizer':
      return <div className="flex gap-1.5">{num('시간(틱)', fx.timing, 0, 240, 5, 'timing')}{num('세기', fx.velocity, 0, 0.5, 0.01, 'velocity')}</div>;
    case 'scaleQuantizer':
      return <p className="text-[11px] text-ink-3">곡의 조성(LCD)에 맞춥니다</p>;
    default:
      return null;
  }
}

/** 손잡이 — 위로 끌면 커진다. 150px 끌면 처음부터 끝까지 */
function Knob({ label, value01, onPreview, onCommit, onReset }: {
  label: string; value01: number; onPreview: (x: number) => void; onCommit: () => void; onReset: () => void;
}) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const v = Math.max(0, Math.min(1, value01));
  const a0 = -135;
  const a = a0 + 270 * v;
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const arc = (from: number, to: number) => {
    const r = 17;
    const [x1, y1] = [22 + r * Math.cos(rad(from)), 22 + r * Math.sin(rad(from))];
    const [x2, y2] = [22 + r * Math.cos(rad(to)), 22 + r * Math.sin(rad(to))];
    return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  return (
    <svg
      role="slider"
      aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}
      tabIndex={0}
      width="44" height="44" viewBox="0 0 44 44"
      className="cursor-ns-resize touch-none"
      onPointerDown={(e) => { (e.target as Element).setPointerCapture(e.pointerId); drag.current = { y: e.clientY, v }; }}
      onPointerMove={(e) => { if (drag.current) onPreview(drag.current.v + (drag.current.y - e.clientY) / 150); }}
      onPointerUp={() => { if (drag.current) { drag.current = null; onCommit(); } }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { onPreview(v + 0.02); onCommit(); e.preventDefault(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { onPreview(v - 0.02); onCommit(); e.preventDefault(); }
      }}
    >
      <path d={arc(a0, 135)} fill="none" stroke="var(--color-grid-2)" strokeWidth="4" strokeLinecap="round" />
      {v > 0.003 && <path d={arc(a0, a)} fill="none" stroke="var(--color-acc)" strokeWidth="4" strokeLinecap="round" />}
      <circle cx="22" cy="22" r="11" fill="var(--color-screen-2)" stroke="var(--color-grid-2)" />
      <line x1="22" y1="22" x2={22 + 9 * Math.cos(rad(a))} y2={22 + 9 * Math.sin(rad(a))} stroke="var(--color-sink)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

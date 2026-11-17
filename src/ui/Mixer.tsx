import { useEffect, useRef, useState } from 'react';

import type { Bus, BusId, EffectSpec, Project, Track, TrackId, Vca } from '../model/project.ts';
import { LevelMeter } from './LevelMeter.tsx';
import { updateTrack } from '../editor/edits.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import {
  addBus, addGroup, addVca, assignGroup, assignVca, deleteBus, deleteVca, setGroupedFlag, setGroupedGain, setSend,
  setTrackOutput, updateBus, updateVca,
} from '../editor/mixer.ts';
import { createEffect, EFFECT_SPECS, isEffectType } from '../audio/effects.ts';
import type { EffectParamSpec, EffectType } from '../audio/effects.ts';
import { EFFECT_CATEGORIES } from '../audio/rustEffects.ts';
import type { EffectCategory } from '../audio/rustEffects.ts';

/**
 * 믹서 — 세로 채널 스트립 (Logic Mixer, `LOGIC_PARITY.md` 1-8).
 *
 * 스트립 순서: 트랙 → 버스(Aux) → VCA → 마스터. 스트립 하나는 위에서 아래로
 * 인서트 · 센드 · 출력 · 그룹/VCA · 팬 · 페이더+미터 · 뮤트/솔로 (Logic 과 같은 순서 —
 * 신호가 흐르는 순서다). 인서트를 누르면 아래 칸에 그 이펙트의 손잡이가 열린다.
 *
 * 이펙트 파라미터 UI 는 `EFFECT_SPECS` 선언에서 자동 생성한다 (`sound.md` 9-5 —
 * 이펙트를 추가할 때 화면을 손으로 만들지 않는다).
 */

const EFFECT_TYPES = Object.keys(EFFECT_SPECS) as EffectType[];
/** 추가 메뉴 — 분류별로 묶는다 (종류가 80개 가까이 된다) */
const EFFECT_GROUPS = (Object.keys(EFFECT_CATEGORIES) as EffectCategory[])
  .map((cat) => ({ cat, types: EFFECT_TYPES.filter((t) => EFFECT_SPECS[t].category === cat) }))
  .filter((g) => g.types.length > 0);

export interface MixerProps {
  editor: ProjectEditor;
  /** 레벨 미터 — 트랙 id, 버스 id, null(마스터). 대체 렌더러에는 없다 */
  readLevel?: (trackId: TrackId | null) => { peak: number; rms: number } | null;
  /** Rust 이펙트 미터 — 소유자(트랙·버스 id 또는 null=마스터), 이펙트 자리 */
  readEffectMeters?: (owner: string | null, index: number) => Float32Array | null;
  /** 지연 보정 중인 가장 긴 지연(샘플) */
  compensationSamples?: () => number;
}

/** 지금 열린 인서트 — 어느 스트립의 몇 번째 이펙트인가 */
type Opened = { owner: 'master' } | { owner: 'track'; id: TrackId } | { owner: 'bus'; id: BusId };
type OpenedInsert = Opened & { index: number };

const STRIP = 'flex w-32 shrink-0 flex-col gap-1.5 border-r border-rule px-2 py-2.5';
const SECTION = 'text-[10px] font-semibold text-ink-3';
const MINI_SELECT = 'h-6 w-full min-w-0 rounded border border-rule bg-body px-1 text-[11px] text-ink';
const INSERT = 'flex h-6 w-full items-center justify-between rounded border px-1.5 text-left text-[11px]';
const TOGGLE = 'h-6 flex-1 rounded border text-[11px] font-semibold';

const panLabel = (v: number) => (Math.abs(v) < 0.01 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`);
const dbLabel = (g: number) => (g <= 0.0001 ? '−∞' : `${(20 * Math.log10(g)).toFixed(1)}`);

export function Mixer({ editor, readLevel, readEffectMeters, compensationSamples }: MixerProps) {
  const { project } = editor;
  const [opened, setOpened] = useState<OpenedInsert | null>(null);
  const buses = project.buses ?? [];
  const vcas = project.vcas ?? [];
  const groups = project.groups ?? [];

  const commitOrPreview = (next: Project, commit: boolean) => (commit ? editor.commit(next) : editor.preview(next));

  const effectsOf = (o: Opened): EffectSpec[] =>
    o.owner === 'master' ? project.master.effects
      : o.owner === 'track' ? project.tracks.find((t) => t.id === o.id)?.effects ?? []
        : buses.find((b) => b.id === o.id)?.effects ?? [];
  const withEffects = (o: Opened, effects: EffectSpec[]): Project =>
    o.owner === 'master' ? { ...project, master: { ...project.master, effects } }
      : o.owner === 'track' ? updateTrack(project, o.id, { effects })
        : updateBus(project, o.id, { effects });

  const insertSection = (o: Opened) => {
    const effects = effectsOf(o);
    return (
      <div className="flex flex-col gap-1">
        <span className={SECTION}>인서트</span>
        {effects.map((effect, index) => {
          const on = opened && opened.owner === o.owner && ('id' in o ? 'id' in opened && opened.id === o.id : true) && opened.index === index;
          const label = isEffectType(effect.type) ? EFFECT_SPECS[effect.type].label : effect.type;
          return (
            <button
              key={`${effect.type}-${index}`}
              type="button"
              onClick={() => setOpened(on ? null : { ...o, index })}
              className={`${INSERT} ${on ? 'border-ink bg-ink text-body' : effect.bypass ? 'border-rule bg-panel text-ink-3 line-through' : 'border-rule bg-body text-ink hover:border-ink-3'}`}
            ><span className="truncate">{label}</span><span className="text-[9px] opacity-60">⋯</span></button>
          );
        })}
        <select
          aria-label="이펙트 추가"
          value=""
          onChange={(e) => {
            if (!isEffectType(e.target.value)) return;
            editor.commit(withEffects(o, [...effects, createEffect(e.target.value)]));
            setOpened({ ...o, index: effects.length });
          }}
          className={MINI_SELECT}
        >
          <option value="">＋ 인서트</option>
          {EFFECT_GROUPS.map((g) => (
            <optgroup key={g.cat} label={EFFECT_CATEGORIES[g.cat]}>
              {g.types.map((type) => <option key={type} value={type}>{EFFECT_SPECS[type].label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
    );
  };

  const fader = (opts: {
    id: string; label: string; value: number; max: number; meterId: TrackId | null | undefined;
    onInput: (v: number) => void; onCommit: () => void;
  }) => (
    // 페이더는 스트립 바닥에 맞춘다 — 인서트 개수가 달라도 페이더 줄이 가지런해야 견줄 수 있다
    <div className="flex flex-col items-center gap-1 [label+&]:mt-0 [:not(label)+&]:mt-auto">
      <span className="font-num text-[13px] text-ink-2">{dbLabel(opts.value)}</span>
      <div className="flex h-40 items-stretch gap-2">
        <input
          type="range"
          aria-label={`${opts.label} 페이더`}
          min={0} max={opts.max} step={0.005}
          value={opts.value}
          onChange={(e) => opts.onInput(Number(e.target.value))}
          onPointerUp={opts.onCommit}
          onKeyUp={opts.onCommit}
          style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
          className="h-40 w-6 accent-ink"
        />
        {readLevel && opts.meterId !== undefined && (
          <LevelMeter vertical className="h-40" label={`${opts.label} 레벨`} read={() => readLevel(opts.meterId as TrackId | null)} />
        )}
      </div>
    </div>
  );

  const pan = (label: string, value: number, onInput: (v: number) => void, onCommit: () => void) => (
    <label className="mt-auto flex items-center gap-1.5 text-[10px] text-ink-3">
      팬
      <input
        type="range" min={-1} max={1} step={0.01} value={value}
        aria-label={`${label} 팬`}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={onCommit}
        onDoubleClick={() => { onInput(0); onCommit(); }}
        className="w-full min-w-0 accent-ink"
      />
      <span className="w-7 text-right font-num text-[12px] text-ink-2">{panLabel(value)}</span>
    </label>
  );

  const trackStrip = (track: Track) => (
    <div key={track.id} className={STRIP} data-strip={track.name}>
      <i className={`h-1 rounded-full bg-${({ j1: 't1', j2: 't2', j3: 't3', j4: 't4', j5: 't5', j6: 't6' } as Record<string, string>)[track.color] ?? 'ink-3'}`} />
      <span className="truncate text-xs font-semibold text-ink" title={track.name}>{track.name}</span>
      {insertSection({ owner: 'track', id: track.id })}
      {buses.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={SECTION}>센드</span>
          {buses.map((bus) => {
            const send = track.sends?.find((s) => s.busId === bus.id);
            return (
              <label key={bus.id} className="flex items-center gap-1 text-[10px] text-ink-2" title={`${bus.name}(으)로 보내는 양 — 0 이면 끊는다`}>
                <span className="w-9 truncate">{bus.name}</span>
                <input
                  type="range" min={0} max={1} step={0.01} value={send?.level ?? 0}
                  aria-label={`${track.name} → ${bus.name} 센드`}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    editor.preview(setSend(project, track.id, bus.id, v <= 0 ? null : v));
                  }}
                  onPointerUp={() => editor.commitCurrent()}
                  className="w-full min-w-0 accent-ink"
                />
              </label>
            );
          })}
        </div>
      )}
      <span className={SECTION}>출력</span>
      <select aria-label={`${track.name} 출력`} value={track.output ?? ''} className={MINI_SELECT}
        onChange={(e) => editor.commit(setTrackOutput(project, track.id, (e.target.value || null) as BusId | null))}>
        <option value="">마스터</option>
        {buses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      {(groups.length > 0 || vcas.length > 0) && (
        <div className="flex gap-1">
          {groups.length > 0 && (
            <select aria-label={`${track.name} 그룹`} value={track.groupId ?? ''} className={MINI_SELECT}
              onChange={(e) => editor.commit(assignGroup(project, track.id, (e.target.value || null) as Track['groupId'] | null ?? null))}>
              <option value="">그룹 —</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {vcas.length > 0 && (
            <select aria-label={`${track.name} VCA`} value={track.vcaId ?? ''} className={MINI_SELECT}
              onChange={(e) => editor.commit(assignVca(project, track.id, (e.target.value || null) as Track['vcaId'] | null ?? null))}>
              <option value="">VCA —</option>
              {vcas.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
        </div>
      )}
      {pan(track.name, track.pan, (v) => editor.preview(updateTrack(project, track.id, { pan: v })), () => editor.commitCurrent())}
      {fader({
        id: track.id, label: track.name, value: track.gain, max: 1, meterId: track.id,
        onInput: (v) => editor.preview(setGroupedGain(project, track.id, v)),
        onCommit: () => editor.commitCurrent(),
      })}
      <div className="flex gap-1">
        <button type="button" aria-pressed={track.mute} onClick={() => editor.commit(setGroupedFlag(project, track.id, 'mute', !track.mute))}
          className={`${TOGGLE} ${track.mute ? 'border-acc bg-acc text-acc-ink' : 'border-rule bg-body text-ink-3'}`}>M</button>
        <button type="button" aria-pressed={track.solo} onClick={() => editor.commit(setGroupedFlag(project, track.id, 'solo', !track.solo))}
          className={`${TOGGLE} ${track.solo ? 'border-ink bg-ink text-body' : 'border-rule bg-body text-ink-3'}`}>S</button>
      </div>
    </div>
  );

  const busStrip = (bus: Bus) => (
    <div key={bus.id} className={`${STRIP} bg-panel`} data-strip={bus.name}>
      <i className="h-1 rounded-full bg-ink-3" />
      <input aria-label="버스 이름" value={bus.name}
        onChange={(e) => editor.preview(updateBus(project, bus.id, { name: e.target.value }))}
        onBlur={() => editor.commitCurrent()}
        className="h-5 w-full min-w-0 rounded border border-transparent bg-transparent text-xs font-semibold text-ink hover:border-rule" />
      <span className="text-[10px] text-ink-3">버스 (Aux) · {project.tracks.filter((t) => t.output === bus.id || t.sends?.some((s) => s.busId === bus.id)).length}개 받음</span>
      {insertSection({ owner: 'bus', id: bus.id })}
      <span className={SECTION}>출력</span>
      <span className="text-[11px] text-ink-2">마스터</span>
      {pan(bus.name, bus.pan, (v) => editor.preview(updateBus(project, bus.id, { pan: v })), () => editor.commitCurrent())}
      {fader({
        id: bus.id, label: bus.name, value: bus.gain, max: 1.5, meterId: bus.id as unknown as TrackId,
        onInput: (v) => editor.preview(updateBus(project, bus.id, { gain: v })),
        onCommit: () => editor.commitCurrent(),
      })}
      <div className="flex gap-1">
        <button type="button" aria-pressed={bus.mute} onClick={() => editor.commit(updateBus(project, bus.id, { mute: !bus.mute }))}
          className={`${TOGGLE} ${bus.mute ? 'border-acc bg-acc text-acc-ink' : 'border-rule bg-body text-ink-3'}`}>M</button>
        <button type="button" title="버스 지우기 — 보내던 트랙은 마스터로" onClick={() => { editor.commit(deleteBus(project, bus.id)); setOpened(null); }}
          className={`${TOGGLE} border-rule bg-body text-ink-3 hover:border-rec hover:text-rec`}>✕</button>
      </div>
    </div>
  );

  const vcaStrip = (vca: Vca) => (
    <div key={vca.id} className={`${STRIP} w-24 bg-panel`} data-strip={vca.name}>
      <input aria-label="VCA 이름" value={vca.name}
        onChange={(e) => editor.preview(updateVca(project, vca.id, { name: e.target.value }))}
        onBlur={() => editor.commitCurrent()}
        className="h-5 w-full min-w-0 rounded border border-transparent bg-transparent text-xs font-semibold text-ink hover:border-rule" />
      <span className="text-[10px] text-ink-3">VCA · {project.tracks.filter((t) => t.vcaId === vca.id).length}트랙</span>
      {fader({
        id: vca.id, label: vca.name, value: vca.gain, max: 1.5, meterId: undefined,
        onInput: (v) => editor.preview(updateVca(project, vca.id, { gain: v })),
        onCommit: () => editor.commitCurrent(),
      })}
      <div className="flex gap-1">
        <button type="button" aria-pressed={vca.mute} onClick={() => editor.commit(updateVca(project, vca.id, { mute: !vca.mute }))}
          className={`${TOGGLE} ${vca.mute ? 'border-acc bg-acc text-acc-ink' : 'border-rule bg-body text-ink-3'}`}>M</button>
        <button type="button" title="VCA 지우기" onClick={() => editor.commit(deleteVca(project, vca.id))}
          className={`${TOGGLE} border-rule bg-body text-ink-3 hover:border-rec hover:text-rec`}>✕</button>
      </div>
    </div>
  );

  const masterStrip = (
    <div className={`${STRIP} border-r-0 bg-panel`} data-strip="마스터">
      <i className="h-1 rounded-full bg-acc" />
      <span className="text-xs font-semibold text-ink">마스터</span>
      {insertSection({ owner: 'master' })}
      {fader({
        id: 'master', label: '마스터', value: project.master.gain, max: 2, meterId: null,
        onInput: (v) => editor.preview({ ...project, master: { ...project.master, gain: v } }),
        onCommit: () => editor.commitCurrent(),
      })}
    </div>
  );

  const openedEffects = opened ? effectsOf(opened) : [];
  const openedEffect = opened ? openedEffects[opened.index] : undefined;
  const openedOwnerName = !opened ? '' : opened.owner === 'master' ? '마스터'
    : opened.owner === 'track' ? project.tracks.find((t) => t.id === opened.id)?.name ?? ''
      : buses.find((b) => b.id === opened.id)?.name ?? '';

  return (
    <section className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="font-disp text-lg leading-none text-ink">믹서</h2>
        <span className="text-[11px] text-ink-3">트랙 {project.tracks.length} · 버스 {buses.length} · VCA {vcas.length}</span>
        <CompensationBadge read={compensationSamples} />
        <span className="flex-1" />
        <button type="button" onClick={() => editor.commit(addBus(project).project)}
          className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3"
          title="Aux 버스 — 센드나 트랙 출력을 받아 이펙트를 함께 건다">＋ 버스</button>
        <button type="button" onClick={() => editor.commit(addVca(project).project)}
          className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3"
          title="VCA — 여러 트랙의 볼륨을 한 페이더로">＋ VCA</button>
        <button type="button" onClick={() => editor.commit(addGroup(project).project)}
          className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink hover:border-ink-3"
          title="그룹 — 묶인 트랙의 볼륨·뮤트·솔로가 함께 움직인다">＋ 그룹</button>
      </div>

      <div className="flex overflow-x-auto rounded-xl border border-rule bg-body">
        {project.tracks.map(trackStrip)}
        {buses.map(busStrip)}
        {vcas.map(vcaStrip)}
        {masterStrip}
      </div>

      {opened && openedEffect && (
        <EffectPanel
          owner={openedOwnerName}
          effect={openedEffect}
          readMeters={readEffectMeters ? () => readEffectMeters(opened.owner === 'master' ? null : opened.id, opened.index) : undefined}
          onChange={(next, commit) => {
            const effects = [...openedEffects];
            effects[opened.index] = next;
            commitOrPreview(withEffects(opened, effects), commit);
          }}
          onRemove={() => {
            editor.commit(withEffects(opened, openedEffects.filter((_, i) => i !== opened.index)));
            setOpened(null);
          }}
          onClose={() => setOpened(null)}
        />
      )}
    </section>
  );
}

/** 지연 보정 표시 — 지연 있는 이펙트를 쓰면 "PDC 21ms" */
function CompensationBadge({ read }: { read?: (() => number) | undefined }) {
  const [samples, setSamples] = useState(0);
  useEffect(() => {
    if (!read) return;
    const timer = setInterval(() => setSamples(read()), 500);
    return () => clearInterval(timer);
  }, [read]);
  if (samples <= 0) return null;
  return (
    <span className="rounded border border-rule px-1.5 font-num text-[12px] text-ink-2" data-pdc
      title="지연 있는 이펙트에 맞춰 나머지 트랙을 늦춘다 (플러그인 지연 보정)">PDC {(samples / 48).toFixed(1)}ms</span>
  );
}

/** 슬라이더 위치(0…1) ↔ 값 — 로그 곡선이면 주파수처럼 옥타브마다 같은 거리 */
function toPos(spec: EffectParamSpec, v: number): number {
  if (spec.curve === 'log' && spec.min > 0) return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  return (v - spec.min) / (spec.max - spec.min || 1);
}
function fromPos(spec: EffectParamSpec, t: number): number {
  if (spec.curve === 'log' && spec.min > 0) return spec.min * Math.pow(spec.max / spec.min, t);
  return spec.min + t * (spec.max - spec.min);
}
function formatValue(spec: EffectParamSpec, v: number): string {
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return `${v.toFixed(digits)}${spec.unit ?? ''}`;
}

/** 이펙트 미터 — 게인 감소는 위에서 아래로 차는 막대, 나머지는 값 */
function EffectMeters({ type, read }: { type: EffectType; read: () => Float32Array | null }) {
  const decl = EFFECT_SPECS[type].meters ?? [];
  const [values, setValues] = useState<number[]>([]);
  const raf = useRef(0);
  useEffect(() => {
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 60) {
        last = t;
        const m = read();
        if (m) setValues(Array.from(m.subarray(0, decl.length)));
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [read, decl.length]);
  if (decl.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-3" data-effect-meters>
      {decl.map((m, i) => {
        const v = values[i] ?? m.max;
        const t = Math.max(0, Math.min(1, (v - m.min) / (m.max - m.min || 1)));
        const reduction = m.unit === 'dB' && m.max === 0 && m.label !== '감지';
        return (
          <div key={m.label} className="flex w-28 flex-col gap-1">
            <span className="text-[10px] text-ink-3">{m.label}</span>
            <div className="h-1.5 overflow-hidden rounded bg-body">
              <div className={`h-full ${reduction ? 'ml-auto bg-rec' : 'bg-ink'}`} style={{ width: `${(reduction ? 1 - t : t) * 100}%` }} />
            </div>
            <span className="font-num text-[12px] text-ink-2">{m.unit === 'dB' ? `${v.toFixed(1)}dB` : v.toFixed(m.max > 10 ? 0 : 2)}{m.unit && m.unit !== 'dB' ? m.unit : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 이펙트 하나. 파라미터 슬라이더는 선언에서 자동 생성된다 */
function EffectPanel({
  owner, effect, onChange, onRemove, onClose, readMeters,
}: {
  owner: string;
  effect: EffectSpec;
  readMeters?: (() => Float32Array | null) | undefined;
  onChange: (next: EffectSpec, commit: boolean) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  if (!isEffectType(effect.type)) {
    return (
      <p className="rounded-xl border border-rec bg-panel px-3 py-2 text-xs text-ink">
        알 수 없는 이펙트 &quot;{effect.type}&quot; — 이 프로젝트는 더 새로운 버전에서 만들어졌을 수 있습니다.
        <button type="button" onClick={onRemove} className="ml-2 underline">제거</button>
      </p>
    );
  }

  const declared = EFFECT_SPECS[effect.type];
  return (
    <div className="rounded-xl border border-rule bg-panel p-3" data-effect-panel={declared.label}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-ink-3">{owner} ·</span>
        <span className="flex-1 text-sm font-semibold text-ink">{declared.label}</span>
        {declared.latency ? <span className="font-num text-[12px] text-ink-3" title="이 이펙트의 처리 지연 — 지연 보정이 맞춘다">지연 {declared.latency}샘플</span> : null}
        <button
          type="button"
          aria-pressed={!effect.bypass}
          onClick={() => onChange({ ...effect, bypass: !effect.bypass }, true)}
          className={`h-7 rounded-md border px-2.5 text-xs ${effect.bypass ? 'border-rule bg-body text-ink-3' : 'border-ink bg-ink text-body'}`}
        >{effect.bypass ? '꺼짐' : '켜짐'}</button>
        <button type="button" onClick={onRemove} aria-label={`${declared.label} 제거`}
          className="h-7 rounded-md border border-rule bg-body px-2.5 text-xs text-ink-3 hover:border-rec hover:text-rec">제거</button>
        <button type="button" onClick={onClose} className="h-7 rounded-md border border-rule bg-body px-2.5 text-xs text-ink-2">닫기</button>
      </div>

      <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
        {Object.entries(declared.params).map(([key, spec]) => {
          const raw = effect.params[key];
          const value = typeof raw === 'number' ? raw : spec.default;
          const set = (v: number, commit: boolean) => onChange({ ...effect, params: { ...effect.params, [key]: v } }, commit);
          if (spec.options) {
            return (
              <div key={key} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
                <label htmlFor={`fx-${key}`} className="text-[11px] text-ink-2">{spec.label}</label>
                <select id={`fx-${key}`} value={Math.round(value)} onChange={(e) => set(Number(e.target.value), true)}
                  className="h-7 rounded-md border border-rule bg-body px-1.5 text-xs text-ink">
                  {spec.options.map((o, i) => <option key={o} value={i}>{o}</option>)}
                </select>
              </div>
            );
          }
          const pos = (el: HTMLInputElement) => fromPos(spec, Number(el.value) / 1000);
          return (
            <div key={key} className="grid grid-cols-[5.5rem_1fr_4rem] items-center gap-2">
              <label htmlFor={`fx-${key}`} className="text-[11px] text-ink-2">{spec.label}</label>
              <input
                id={`fx-${key}`}
                type="range"
                min={0} max={1000} step={1}
                value={Math.round(toPos(spec, value) * 1000)}
                onChange={(e) => set(pos(e.target), false)}
                onPointerUp={(e) => set(pos(e.target as HTMLInputElement), true)}
                onKeyUp={(e) => set(pos(e.target as HTMLInputElement), true)}
                onDoubleClick={() => set(spec.default, true)}
                title="두 번 누르면 기본값"
                className="accent-ink"
              />
              <span className="text-right font-num text-[13px] text-ink-2">{formatValue(spec, value)}</span>
            </div>
          );
        })}
      </div>
      {readMeters && <EffectMeters type={effect.type} read={readMeters} />}
    </div>
  );
}

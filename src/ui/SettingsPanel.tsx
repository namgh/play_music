import { useEffect, useState } from 'react';

import type { Project } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { COMMANDS, findConflicts, formatBinding, rebind, bindingFromEvent } from './shortcuts.ts';
import type { CommandId } from './shortcuts.ts';
import { diffBindings, effectiveBindings } from './settings.ts';
import type { AppSettings } from './settings.ts';
import type { MidiDevice } from '../audio/midiInput.ts';

/**
 * 설정 — 일반 · 단축키 · MIDI 장치 (Logic 설정·키 명령, `LOGIC_PARITY.md` 1-16).
 * 조율(A4)은 곡의 성질이라 프로젝트에 저장하고 나머지는 앱 설정이다.
 */

export interface SettingsPanelProps {
  editor: ProjectEditor;
  settings: AppSettings;
  onSettings: (s: AppSettings) => void;
  midi: { devices: MidiDevice[]; error: string | null; supported: boolean; lastNote: string | null };
  onClose: () => void;
}

type Tab = 'general' | 'keys' | 'midi';
const TAB_LABEL: Record<Tab, string> = { general: '일반', keys: '단축키', midi: 'MIDI 장치' };

export function SettingsPanel({ editor, settings, onSettings, midi, onClose }: SettingsPanelProps) {
  const { project } = editor;
  const [tab, setTab] = useState<Tab>('general');
  const [capturing, setCapturing] = useState<CommandId | null>(null);
  const bindings = effectiveBindings(settings);
  const conflicts = findConflicts(bindings);

  // 단축키 받기 — 다음에 누르는 키를 그 명령에 문다. Esc 는 취소
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { setCapturing(null); return; }
      const b = bindingFromEvent(e);
      if (!b) return;
      onSettings({ ...settings, bindings: diffBindings(rebind(bindings, capturing, b)) });
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, bindings, onSettings, settings]);

  const setTuning = (hz: number) => editor.commit({ ...project, tuning: { ...project.tuning, a4Hz: Math.max(400, Math.min(480, hz)) } } as Project);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-6" onClick={onClose}>
      <div role="dialog" aria-label="설정" onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-rule bg-body shadow-2xl">
        <div className="flex items-center gap-2 border-b border-rule px-5 py-3">
          <h2 className="font-disp text-lg text-ink">설정</h2>
          <div className="ml-4 flex gap-1 rounded-lg bg-panel p-1" role="tablist">
            {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`h-7 rounded-md px-3 text-xs ${tab === t ? 'bg-body font-semibold text-ink shadow-sm' : 'text-ink-3'}`}>{TAB_LABEL[t]}</button>
            ))}
          </div>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="h-7 rounded-md border border-rule px-2.5 text-xs text-ink-2">닫기</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'general' && (
            <div className="space-y-5 text-sm text-ink">
              <section>
                <h3 className="mb-2 text-[11px] font-semibold text-ink-3">재생</h3>
                <div className="flex items-center gap-3">
                  <span className="w-28 text-xs text-ink-2">카운트인</span>
                  {([1, 2] as const).map((n) => (
                    <button key={n} type="button" aria-pressed={settings.countInBars === n} onClick={() => onSettings({ ...settings, countInBars: n })}
                      className={`h-8 rounded-md border px-3 text-xs ${settings.countInBars === n ? 'border-ink bg-ink text-body' : 'border-rule bg-panel'}`}>{n}마디</button>
                  ))}
                </div>
              </section>
              <section>
                <h3 className="mb-2 text-[11px] font-semibold text-ink-3">이 곡 — 조율</h3>
                <div className="flex items-center gap-3">
                  <span className="w-28 text-xs text-ink-2">A4 기준음</span>
                  <input aria-label="A4 기준음" type="number" min={400} max={480} step={0.1} value={project.tuning.a4Hz}
                    onChange={(e) => setTuning(Number(e.target.value))}
                    className="h-8 w-24 rounded-md border border-rule bg-body px-2 text-right font-num text-[15px]" />
                  <span className="text-xs text-ink-3">Hz</span>
                  {[440, 442, 432].map((hz) => (
                    <button key={hz} type="button" onClick={() => setTuning(hz)} className="h-8 rounded-md border border-rule bg-panel px-2 text-xs">{hz}</button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-ink-3">곡에 저장됩니다. 오케스트라(442)·고음악(415) 같은 기준에 맞출 때.</p>
              </section>
            </div>
          )}

          {tab === 'keys' && (
            <div>
              {conflicts.length > 0 && (
                <p className="mb-3 rounded-lg bg-rec/10 px-3 py-2 text-xs text-rec">겹치는 키: {conflicts.map((c) => formatBinding(c.binding)).join(', ')}</p>
              )}
              <div className="mb-3 flex items-center">
                <p className="flex-1 text-[11px] text-ink-3">바꾸기를 누른 뒤 원하는 키를 누르세요 (Esc 취소). 같은 키를 쓰던 명령에서는 빠집니다.</p>
                <button type="button" onClick={() => onSettings({ ...settings, bindings: {} })}
                  className="h-7 rounded-md border border-rule bg-panel px-2.5 text-xs text-ink">전부 기본값</button>
              </div>
              {(['재생', '편집', '음', '보기', '파일'] as const).map((group) => (
                <section key={group} className="mb-4">
                  <h3 className="mb-1.5 text-[11px] font-semibold text-ink-3">{group}</h3>
                  <ul className="divide-y divide-rule rounded-xl border border-rule">
                    {COMMANDS.filter((c) => c.group === group).map((c) => (
                      <li key={c.id} className="flex items-center gap-2 px-3 py-1.5" data-command={c.id}>
                        <span className="flex-1 text-xs text-ink">{c.label}</span>
                        <span className="flex gap-1">
                          {(bindings[c.id] ?? []).map((b) => (
                            <kbd key={formatBinding(b)} className="rounded border border-rule bg-panel px-1.5 py-0.5 font-num text-[13px] text-ink">{formatBinding(b)}</kbd>
                          ))}
                          {(bindings[c.id] ?? []).length === 0 && <span className="text-[11px] text-ink-3">없음</span>}
                        </span>
                        <button type="button" onClick={() => setCapturing(c.id)}
                          className={`h-7 w-20 rounded-md border text-xs ${capturing === c.id ? 'border-acc bg-acc text-acc-ink' : 'border-rule bg-body text-ink-2'}`}
                        >{capturing === c.id ? '키를 누르세요' : '바꾸기'}</button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {tab === 'midi' && (
            <div className="space-y-3 text-sm">
              {!midi.supported && <p className="text-xs text-ink-2">이 브라우저는 Web MIDI 를 주지 않습니다 (크롬·엣지에서 됩니다). 데스크톱 앱에서는 장치를 직접 엽니다.</p>}
              {midi.error && <p className="text-xs text-rec">장치 목록을 못 받았습니다: {midi.error}</p>}
              {midi.supported && (
                <>
                  <p className="text-[11px] text-ink-3">건반을 고르면 그 건반으로 고른 트랙을 연주하고, 녹음·스텝 입력도 그 건반으로 됩니다.</p>
                  <ul className="divide-y divide-rule rounded-xl border border-rule">
                    <li className="flex items-center gap-2 px-3 py-2">
                      <input type="radio" name="midi-in" id="midi-none" checked={settings.midiInputId === null}
                        onChange={() => onSettings({ ...settings, midiInputId: null })} className="accent-ink" />
                      <label htmlFor="midi-none" className="text-xs text-ink">쓰지 않음</label>
                    </li>
                    {midi.devices.map((d) => (
                      <li key={d.id} className="flex items-center gap-2 px-3 py-2">
                        <input type="radio" name="midi-in" id={`midi-${d.id}`} checked={settings.midiInputId === d.id}
                          onChange={() => onSettings({ ...settings, midiInputId: d.id })} className="accent-ink" />
                        <label htmlFor={`midi-${d.id}`} className="text-xs text-ink">{d.name}</label>
                      </li>
                    ))}
                    {midi.devices.length === 0 && <li className="px-3 py-2 text-xs text-ink-3">연결된 MIDI 입력 장치가 없습니다</li>}
                  </ul>
                  <p className="font-num text-[13px] text-ink-2">마지막으로 받은 음: {midi.lastNote ?? '—'}</p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

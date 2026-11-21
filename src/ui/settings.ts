/**
 * 앱 설정 — 곡이 아니라 **이 사람의 작업 환경**이라 프로젝트가 아닌 브라우저 저장소에 둔다
 * (Logic 앱 설정과 프로젝트 설정의 구분, `LOGIC_PARITY.md` 1-16).
 */

import type { Bindings, CommandId } from './shortcuts.ts';
import { COMMANDS, defaultBindings } from './shortcuts.ts';

export interface AppSettings {
  countInBars: 1 | 2;
  /** 메트로놈 크기 0~1 */
  metronomeLevel: number;
  /** 사용자가 바꾼 단축키만 — 나머지는 기본값을 따른다 (기본값이 바뀌면 따라가게) */
  bindings: Partial<Bindings>;
  /** 쓸 MIDI 입력 장치 id. null 이면 끔 */
  midiInputId: string | null;
  /** 소리가 나갈 장치 id. null 이면 시스템 기본 */
  audioOutputId: string | null;
  /** 마이크(녹음 입력) 장치 id. null 이면 시스템 기본 */
  audioInputId: string | null;
  /** 지연과 안정의 균형 — 작게(연주·녹음) / 보통 / 크게(트랙이 많아 끊길 때) */
  latency: LatencyMode;
}

export type LatencyMode = 'interactive' | 'balanced' | 'playback';
export const LATENCY_MODES: { id: LatencyMode; label: string; hint: string }[] = [
  { id: 'interactive', label: '작게', hint: '건반을 치거나 녹음할 때 — 누르면 바로 난다' },
  { id: 'balanced', label: '보통', hint: '끊김이 가끔 있을 때' },
  { id: 'playback', label: '크게', hint: '트랙·이펙트가 많아 소리가 끊길 때 — 연주는 조금 늦게 난다' },
];

export const DEFAULT_SETTINGS: AppSettings = { countInBars: 1, metronomeLevel: 0.8, bindings: {}, midiInputId: null, audioOutputId: null, audioInputId: null, latency: 'interactive' };
const KEY = 'settings-v1';

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AppSettings>;
    return {
      countInBars: raw.countInBars === 2 ? 2 : 1,
      metronomeLevel: typeof raw.metronomeLevel === 'number' ? Math.max(0, Math.min(1, raw.metronomeLevel)) : 0.8,
      bindings: raw.bindings && typeof raw.bindings === 'object' ? raw.bindings : {},
      midiInputId: typeof raw.midiInputId === 'string' ? raw.midiInputId : null,
      audioOutputId: typeof raw.audioOutputId === 'string' ? raw.audioOutputId : null,
      audioInputId: typeof raw.audioInputId === 'string' ? raw.audioInputId : null,
      latency: LATENCY_MODES.some((m) => m.id === raw.latency) ? raw.latency! : 'interactive',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AppSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 저장소가 막혀 있다 — 이번 실행 동안만 */ }
}

/** 기본값 위에 사용자 지정을 얹은 전체 단축키 */
export function effectiveBindings(s: AppSettings): Bindings {
  const base = defaultBindings();
  for (const spec of COMMANDS) {
    const own = s.bindings[spec.id as CommandId];
    if (own) base[spec.id] = own;
  }
  return base;
}

/** 전체 단축키에서 기본값과 다른 것만 남긴다 (저장용) */
export function diffBindings(all: Bindings): Partial<Bindings> {
  const base = defaultBindings();
  const out: Partial<Bindings> = {};
  for (const spec of COMMANDS) {
    if (JSON.stringify(all[spec.id]) !== JSON.stringify(base[spec.id])) out[spec.id] = all[spec.id];
  }
  return out;
}

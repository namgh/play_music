/**
 * MIDI 입력 장치 (Web MIDI, `LOGIC_PARITY.md` 1-16). 건반을 꽂으면 그 건반으로 연주·녹음한다.
 *
 * 메시지 해석은 순수 함수로 떼어 둔다 — 장치 없이 테스트된다.
 */

import { useEffect, useRef, useState } from 'react';

export type MidiMessage =
  | { kind: 'noteOn'; channel: number; midi: number; velocity: number }
  | { kind: 'noteOff'; channel: number; midi: number }
  | { kind: 'cc'; channel: number; controller: number; value: number }
  | { kind: 'pitchBend'; channel: number; value: number }
  | null;

/** 바이트 → 메시지. 세기 0 의 노트온은 노트오프다 (많은 건반이 그렇게 보낸다) */
export function parseMidi(data: ArrayLike<number>): MidiMessage {
  const status = data[0] ?? 0;
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const a = data[1] ?? 0;
  const b = data[2] ?? 0;
  if (kind === 0x90 && b > 0) return { kind: 'noteOn', channel, midi: a, velocity: b / 127 };
  if (kind === 0x80 || (kind === 0x90 && b === 0)) return { kind: 'noteOff', channel, midi: a };
  if (kind === 0xb0) return { kind: 'cc', channel, controller: a, value: b / 127 };
  if (kind === 0xe0) return { kind: 'pitchBend', channel, value: ((b << 7) | a) / 8192 - 1 };
  return null;
}

export interface MidiDevice { id: string; name: string }

/**
 * 장치 목록과, 고른 장치의 메시지. 브라우저가 Web MIDI 를 안 주면(사파리 등) `supported` 가 false.
 * 처음 부를 때 권한을 묻는다 — 그래서 사용자가 설정 화면을 열었을 때만 켠다(`enabled`).
 */
export function useMidiInput(enabled: boolean, inputId: string | null, onMessage: (m: MidiMessage) => void) {
  const [devices, setDevices] = useState<MidiDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

  useEffect(() => {
    if (!enabled || !supported) return;
    let access: MIDIAccess | null = null;
    let alive = true;
    const refresh = () => {
      if (!access || !alive) return;
      setDevices([...access.inputs.values()].map((i) => ({ id: i.id, name: i.name ?? i.id })));
      for (const input of access.inputs.values()) {
        input.onmidimessage = input.id === inputId ? (e) => { if (e.data) handler.current(parseMidi(e.data)); } : null;
      }
    };
    navigator.requestMIDIAccess().then((a) => {
      access = a;
      a.onstatechange = refresh;
      refresh();
      setError(null);
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
      if (access) for (const input of access.inputs.values()) input.onmidimessage = null;
    };
  }, [enabled, supported, inputId]);

  return { devices, error, supported };
}

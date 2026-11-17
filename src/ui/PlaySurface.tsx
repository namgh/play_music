import { useEffect, useRef, useState } from 'react';

import { keyLabelFor, typingAction, VELOCITY_STEPS } from './musicalTyping.ts';
import { pitchName } from '../model/pitch.ts';

/**
 * 연주 칸 — 화면 건반 + 컴퓨터 건반 연주 + 스텝 입력 (Logic Play Surface · Musical Typing ·
 * Step Input, `LOGIC_PARITY.md` 1-6·1-7). 화면 아래에 붙어 열고 닫는다.
 *
 * 스텝 입력이 켜져 있으면 친 음이 **커서 자리에 찍히고 커서가 음 길이만큼 나간다.**
 * Shift 를 누른 채 치면 커서가 안 나가서 화음이 된다 (Logic 과 같다).
 */

export interface PlaySurfaceProps {
  /** 음 하나 들려주기 */
  onPlay: (midi: number, velocity: number) => void;
  /** 스텝 입력 — 커서 자리에 찍기. `chord` 면 커서를 옮기지 않는다 */
  onStep: (midi: number, velocity: number, chord: boolean) => void;
  /** 스텝 입력에서 쉼표(빈 자리) — 커서만 음 길이만큼 */
  onRest: () => void;
  onClose: () => void;
}

const WHITE = [0, 2, 4, 5, 7, 9, 11];

export function PlaySurface({ onPlay, onStep, onRest, onClose }: PlaySurfaceProps) {
  const [octave, setOctave] = useState(4);
  const [velIndex, setVelIndex] = useState(4);
  const [step, setStep] = useState(false);
  const [down, setDown] = useState<Set<number>>(new Set());
  const velocity = VELOCITY_STEPS[velIndex]!;

  // 키 이벤트 처리기는 최신 상태를 봐야 한다 — ref 로 넘긴다
  const live = useRef({ octave, velocity, step, onPlay, onStep, onRest });
  live.current = { octave, velocity, step, onPlay, onStep, onRest };

  const strike = (midi: number, chord: boolean) => {
    const s = live.current;
    s.onPlay(midi, s.velocity);
    if (s.step) s.onStep(midi, s.velocity, chord);
  };

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // 글자를 치는 칸에서는 연주하지 않는다
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
      return !e.metaKey && !e.ctrlKey && !e.altKey;
    };
    const onDown = (e: KeyboardEvent) => {
      if (!typing(e) || e.repeat) return;
      if (e.code === 'Tab' && live.current.step) { e.preventDefault(); live.current.onRest(); return; }
      const action = typingAction(e.code, live.current.octave);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.kind === 'octave') setOctave((o) => Math.max(0, Math.min(8, o + action.delta)));
      else if (action.kind === 'velocity') setVelIndex((v) => Math.max(0, Math.min(VELOCITY_STEPS.length - 1, v + action.delta)));
      else {
        setDown((d) => new Set(d).add(action.midi));
        strike(action.midi, e.shiftKey);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const action = typingAction(e.code, live.current.octave);
      if (action?.kind === 'note') setDown((d) => { const n = new Set(d); n.delete(action.midi); return n; });
    };
    // 캡처 단계에서 받는다 — 앱 단축키(Space·Delete 등)보다 먼저, 연주 키만 가로챈다
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);

  // 두 옥타브 + 끝 도. 지금 옥타브부터
  const low = (octave + 1) * 12;
  const whites: number[] = [];
  for (let m = low; m <= low + 24; m++) if (WHITE.includes(m % 12)) whites.push(m);
  const W = 100 / whites.length;

  return (
    <div className="shrink-0 border-t border-rule bg-panel px-5 py-3" data-play-surface>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-disp text-sm text-ink">건반</span>
        <span className="text-[11px] text-ink-3">자판으로 연주 — A~' 흰 건반 · W E T Y U O P 검은 건반 · Z/X 옥타브 · C/V 세기</span>
        <span className="flex-1" />
        <button type="button" onClick={() => setOctave((o) => Math.max(0, o - 1))} className="h-7 rounded-md border border-rule bg-body px-2 text-xs" aria-label="옥타브 내리기">Z ◀</button>
        <span className="w-14 text-center font-num text-[15px] text-ink" aria-label="옥타브">C{octave}</span>
        <button type="button" onClick={() => setOctave((o) => Math.min(8, o + 1))} className="h-7 rounded-md border border-rule bg-body px-2 text-xs" aria-label="옥타브 올리기">▶ X</button>
        <span className="ml-2 text-[11px] text-ink-3">세기</span>
        <span className="w-10 text-center font-num text-[15px] text-ink" aria-label="연주 세기">{Math.round(velocity * 127)}</span>
        <button
          type="button"
          aria-pressed={step}
          onClick={() => setStep((s) => !s)}
          title="친 음이 커서 자리에 찍히고 커서가 음 길이만큼 나갑니다. Shift = 화음, Tab = 쉼표"
          className={`ml-2 h-7 rounded-md border px-2.5 text-xs ${step ? 'border-rec bg-rec text-body' : 'border-rule bg-body text-ink'}`}
        >{step ? '스텝 입력 중' : '스텝 입력'}</button>
        <button type="button" onClick={onClose} className="h-7 rounded-md border border-rule bg-body px-2.5 text-xs text-ink-2">닫기</button>
      </div>
      <div className="relative h-20 select-none" role="group" aria-label="화면 건반">
        {whites.map((m, i) => (
          <button
            key={m}
            type="button"
            data-key={m}
            onPointerDown={(e) => { setDown((d) => new Set(d).add(m)); strike(m, e.shiftKey); }}
            onPointerUp={() => setDown((d) => { const n = new Set(d); n.delete(m); return n; })}
            onPointerLeave={() => setDown((d) => { const n = new Set(d); n.delete(m); return n; })}
            style={{ left: `${i * W}%`, width: `${W}%` }}
            className={`absolute inset-y-0 flex flex-col items-center justify-end gap-0.5 rounded-b-md border border-rule pb-1.5 text-[10px] ${down.has(m) ? 'bg-acc text-acc-ink' : 'bg-keyw text-ink-3'}`}
            aria-label={pitchName({ midi: m, cents: 0 })}
          >
            <span className="font-semibold text-ink-2">{keyLabelFor(m, octave) ?? ''}</span>
            {m % 12 === 0 && <span>{pitchName({ midi: m, cents: 0 })}</span>}
          </button>
        ))}
        {whites.slice(0, -1).map((m, i) => {
          const black = m + 1;
          if (WHITE.includes(black % 12)) return null;
          return (
            <button
              key={black}
              type="button"
              data-key={black}
              onPointerDown={(e) => { setDown((d) => new Set(d).add(black)); strike(black, e.shiftKey); }}
              onPointerUp={() => setDown((d) => { const n = new Set(d); n.delete(black); return n; })}
              onPointerLeave={() => setDown((d) => { const n = new Set(d); n.delete(black); return n; })}
              style={{ left: `${(i + 1) * W - W * 0.32}%`, width: `${W * 0.64}%` }}
              className={`absolute top-0 z-10 flex h-[60%] items-end justify-center rounded-b-md pb-1 text-[10px] font-semibold ${down.has(black) ? 'bg-acc text-acc-ink' : 'bg-keyb text-sink-2'}`}
              aria-label={pitchName({ midi: black, cents: 0 })}
            >{keyLabelFor(black, octave) ?? ''}</button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 마스터링 도우미 — 믹스를 재고 마스터 체인을 제안한다 (Logic Mastering Assistant,
 * `LOGIC_PARITY.md` 1-12). **잰 값과 정한 규칙**으로 고른다 — 생성 AI 가 아니다.
 *
 * 하는 일: 통합 라우드니스(LUFS)·트루 피크·저역/고역 균형을 재고 →
 *  EQ(저역·고역 선반으로 균형) → 컴프(살짝 묶기) → 리미터(목표 라우드니스까지 밀고 천장 −1).
 * 바꾼 이유를 줄마다 남긴다 — 사람이 듣고 되돌릴 수 있어야 한다.
 */

import type { EffectSpec } from '../model/project.ts';
import { createEffect } from './effects.ts';
import { integratedLufs, spectrum, truePeakDbfs } from './quality.ts';

export type MasterTarget = 'streaming' | 'loud' | 'gentle';
export const MASTER_TARGETS: Record<MasterTarget, { label: string; lufs: number }> = {
  streaming: { label: '스트리밍 (−14 LUFS)', lufs: -14 },
  loud: { label: '크게 (−9 LUFS)', lufs: -9 },
  gentle: { label: '여유 있게 (−18 LUFS)', lufs: -18 },
};

export interface MixAnalysis {
  lufs: number;
  truePeakDb: number;
  /** 저역(40–200Hz) 에너지 − 중역(200–2k) (dB) */
  lowVsMid: number;
  /** 고역(4–12k) − 중역 (dB) */
  highVsMid: number;
}

/** 믹스를 잰다. 48kHz 스테레오 기준 (LUFS 규격) */
export function analyzeMix(channels: readonly Float32Array[], sampleRate: number): MixAnalysis {
  const mono = new Float32Array(channels[0]!.length);
  for (const ch of channels) for (let i = 0; i < ch.length; i++) mono[i]! += ch[i]! / channels.length;
  // 스펙트럼은 여러 조각의 평균 — 한 조각만 보면 그 자리 악기에 휘둘린다
  const size = 16384;
  const bands = { low: 0, mid: 0, high: 0 };
  let count = 0;
  for (let start = 0; start + size <= mono.length; start += size * 2) {
    const mag = spectrum(mono.subarray(start, start + size), size);
    const hz = (k: number) => (k * sampleRate) / size;
    for (let k = 1; k < mag.length; k++) {
      const p = mag[k]! * mag[k]!;
      const f = hz(k);
      if (f >= 40 && f < 200) bands.low += p;
      else if (f >= 200 && f < 2000) bands.mid += p;
      else if (f >= 4000 && f < 12000) bands.high += p;
    }
    count++;
  }
  const db = (x: number) => 10 * Math.log10(Math.max(x, 1e-20));
  return {
    lufs: sampleRate === 48000 ? integratedLufs(channels, sampleRate) : -Infinity,
    truePeakDb: Math.max(...channels.map((ch) => truePeakDbfs(ch))),
    lowVsMid: count ? db(bands.low) - db(bands.mid) : 0,
    highVsMid: count ? db(bands.high) - db(bands.mid) : 0,
  };
}

export interface MasterSuggestion {
  effects: EffectSpec[];
  reasons: string[];
  /** 예상 라우드니스 (어림) */
  expectedLufs: number;
}

/** 대중음악 믹스의 흔한 균형 — 이보다 크게 벗어나면 선반 EQ 로 반쯤 되돌린다 */
const LOW_REF = 2;   // 저역이 중역보다 조금 크다
const HIGH_REF = -12; // 고역은 중역보다 한참 작다

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Math.round(v * 10) / 10;

export function suggestMaster(a: MixAnalysis, target: MasterTarget): MasterSuggestion {
  const reasons: string[] = [];
  const eq = createEffect('eq');
  const lowFix = clamp((LOW_REF - a.lowVsMid) / 2, -4, 4);
  const highFix = clamp((HIGH_REF - a.highVsMid) / 2, -4, 4);
  eq.params = { ...eq.params, lowGainDb: round(lowFix), highGainDb: round(highFix) };
  reasons.push(Math.abs(lowFix) < 0.5 ? '저역 균형은 괜찮습니다' : `저역이 ${lowFix < 0 ? '많아' : '모자라'} 낮은 선반을 ${round(lowFix)}dB`);
  reasons.push(Math.abs(highFix) < 0.5 ? '고역 균형은 괜찮습니다' : `고역이 ${highFix < 0 ? '날카로워' : '어두워'} 높은 선반을 ${round(highFix)}dB`);

  const comp = createEffect('compressor');
  comp.params = { ...comp.params, thresholdDb: -20, ratio: 2, attackMs: 25, releaseMs: 200, makeupDb: 1.5 };
  reasons.push('컴프 2:1 로 살짝 묶어 밀도를 맞춥니다');

  const goal = MASTER_TARGETS[target].lufs;
  const now = Number.isFinite(a.lufs) ? a.lufs : -20;
  // 메이크업 1.5dB 를 빼고 나머지를 리미터 입력으로 민다 (최대 18dB)
  const push = clamp(goal - now - 1.5, 0, 18);
  const limiter = createEffect('limiter');
  limiter.params = { ...limiter.params, inputDb: round(push), ceilingDb: -1, releaseMs: 120 };
  reasons.push(Number.isFinite(a.lufs)
    ? `지금 ${round(a.lufs)} LUFS → 목표 ${goal} LUFS: 리미터로 ${round(push)}dB 밀고 천장 −1dBTP`
    : `라우드니스를 못 쟀습니다(48kHz 가 아님) — 리미터 천장만 −1dBTP`);
  if (goal - now - 1.5 > 18) reasons.push('목표까지 18dB 넘게 모자랍니다 — 믹스 자체가 작으니 트랙 볼륨부터 올리세요');
  if (goal - now < -3) reasons.push('이미 목표보다 큽니다 — 마스터 볼륨을 낮추는 쪽이 낫습니다');
  return { effects: [eq, comp, limiter], reasons, expectedLufs: Math.min(goal, now + push + 1.5) };
}

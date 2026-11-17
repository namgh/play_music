/**
 * 바운스 후처리 — 범위 자르기 · 노멀라이즈 · 디더 · 측정 (Logic Bounce, `LOGIC_PARITY.md` 1-13).
 *
 * 렌더러는 언제나 곡 처음부터 끝(+꼬리)까지 그린다. 범위·노멀라이즈·디더는 그 결과를
 * **순수 함수로 다듬는다** — 렌더 경로를 하나로 두어야 미리듣기와 같은 소리가 나간다.
 */

import { integratedLufs, truePeakDbfs } from './quality.ts';
import { peakAmplitude } from './wav.ts';

export interface BounceRange {
  startSec: number;
  /** 미포함. 꼬리(리버브 등)는 호출자가 더해서 준다 */
  endSec: number;
}

/** [start, end) 를 잘라 낸다. 범위가 버퍼를 넘으면 있는 데까지 */
export function sliceRange(channels: readonly Float32Array[], sampleRate: number, range: BounceRange): Float32Array[] {
  const from = Math.max(0, Math.floor(range.startSec * sampleRate));
  return channels.map((ch) => ch.slice(Math.min(from, ch.length), Math.min(ch.length, Math.ceil(range.endSec * sampleRate))));
}

/**
 * 끝 페이드 — 범위를 곡 중간에서 끊으면 잘린 자리가 "딱" 하고 튄다.
 * 짧게(기본 10ms) 0 으로 내린다.
 */
export function fadeOutTail(channels: readonly Float32Array[], sampleRate: number, ms = 10): Float32Array[] {
  const n = Math.round((ms / 1000) * sampleRate);
  return channels.map((ch) => {
    const out = ch.slice();
    const len = Math.min(n, out.length);
    for (let i = 0; i < len; i++) out[out.length - len + i]! *= 1 - (i + 1) / len;
    return out;
  });
}

/** 피크 노멀라이즈 — 가장 큰 샘플이 `targetDb` dBFS 가 되게. 무음이면 그대로 */
export function normalizePeak(channels: readonly Float32Array[], targetDb: number): { channels: Float32Array[]; gainDb: number } {
  const peak = peakAmplitude(channels);
  if (peak <= 0) return { channels: channels.map((c) => c.slice()), gainDb: 0 };
  const gain = Math.pow(10, targetDb / 20) / peak;
  return { channels: channels.map((ch) => ch.map((v) => v * gain)), gainDb: 20 * Math.log10(gain) };
}

/**
 * TPDF 디더 — 16bit 로 줄일 때 양자화 잡음을 소리와 무관한 잔잔한 잡음으로 바꾼다.
 * 없으면 페이드아웃 끝자락이 지글거린다. **씨앗 고정** — 같은 곡은 같은 파일.
 */
export function tpdfDither(channels: readonly Float32Array[], bitDepth: 16 | 24, seed = 0x51ed): Float32Array[] {
  const lsb = 1 / (Math.pow(2, bitDepth - 1) - 1);
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
  return channels.map((ch) => ch.map((v) => v + (rand() - rand()) * lsb));
}

export interface BounceReport {
  peakDb: number;
  truePeakDb: number;
  /** 48kHz 에서만 잰다 (`integratedLufs`). 다른 표본율이면 null */
  lufs: number | null;
  seconds: number;
}

export function measureBounce(channels: readonly Float32Array[], sampleRate: number): BounceReport {
  const peak = peakAmplitude(channels);
  return {
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    truePeakDb: Math.max(...channels.map((ch) => truePeakDbfs(ch))),
    lufs: sampleRate === 48000 ? integratedLufs(channels, sampleRate) : null,
    seconds: (channels[0]?.length ?? 0) / sampleRate,
  };
}

/** 파일 이름에 쓸 수 없는 문자 정리 */
export function safeFileName(name: string, fallback: string): string {
  return name.trim().replace(/[/\\?%*:|"<>]/g, '-').slice(0, 60) || fallback;
}

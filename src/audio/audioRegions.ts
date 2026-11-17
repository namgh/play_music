/**
 * 오디오 클립 재생 계획 — 어느 에셋을 언제, 어디부터, 얼마나, 어떤 크기·페이드로
 * (Logic 오디오 리전, `LOGIC_PARITY.md` 1-5). 순수 계산이라 브라우저 없이 테스트된다.
 * 실제 소리 내기(AudioBufferSourceNode)는 `scheduleAudioRegions` 하나뿐이고 세 렌더러가 같이 쓴다.
 */

import type { AudioRegion, Project, TrackId } from '../model/project.ts';
import { audibleTracks, isClipAudible, vcaScale } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';
import { ticksToSeconds } from '../model/time.ts';

export interface AudioPlan {
  trackId: TrackId;
  assetId: string;
  /** 재생 시작(`fromTick`) 기준 몇 초 뒤에 */
  whenSec: number;
  /** 에셋의 몇 초부터 (거꾸로면 뒤집은 버퍼 기준) */
  offsetSec: number;
  durationSec: number;
  gain: number;
  fadeInSec: number;
  fadeOutSec: number;
  reverse: boolean;
  /** 페이드를 클립 처음부터 셀 때, 재생이 클립 중간에서 시작하면 그만큼 이미 지났다 */
  elapsedSec: number;
  regionSec: number;
}

/** `fromTick` 부터 재생할 때 울려야 할 오디오 클립들 */
export function planAudio(project: Project, fromTick: Ticks): AudioPlan[] {
  const out: AudioPlan[] = [];
  const t0 = ticksToSeconds(fromTick, project.tempo);
  for (const track of audibleTracks(project)) {
    for (const clip of track.clips) {
      if (!clip.audio || !isClipAudible(clip)) continue;
      const a = clip.audio;
      const start = ticksToSeconds(clip.startTick, project.tempo);
      const end = ticksToSeconds(clip.startTick + clip.lengthTick, project.tempo);
      const regionSec = Math.min(end - start, Math.max(0, a.assetSec - a.offsetSec));
      if (regionSec <= 0 || start + regionSec <= t0) continue;
      const elapsed = Math.max(0, t0 - start);
      out.push({
        trackId: track.id,
        assetId: a.assetId,
        whenSec: Math.max(0, start - t0),
        // 거꾸로면 뒤집은 버퍼에서 거울 자리를 읽는다
        offsetSec: a.reverse ? a.assetSec - (a.offsetSec + regionSec) + elapsed : a.offsetSec + elapsed,
        durationSec: regionSec - elapsed,
        gain: Math.pow(10, a.gainDb / 20) * track.gain * vcaScale(project, track),
        fadeInSec: Math.min(a.fadeInSec, regionSec / 2),
        fadeOutSec: Math.min(a.fadeOutSec, regionSec / 2),
        reverse: a.reverse,
        elapsedSec: elapsed,
        regionSec,
      });
    }
  }
  return out;
}

/** 리전의 이 시각(클립 기준 초)에서의 페이드 배율 */
export function fadeAt(plan: Pick<AudioPlan, 'fadeInSec' | 'fadeOutSec' | 'regionSec'>, t: number): number {
  let g = 1;
  if (plan.fadeInSec > 0 && t < plan.fadeInSec) g *= Math.max(0, t / plan.fadeInSec);
  if (plan.fadeOutSec > 0 && t > plan.regionSec - plan.fadeOutSec) g *= Math.max(0, (plan.regionSec - t) / plan.fadeOutSec);
  return g;
}

/** 버퍼 뒤집기 — 거꾸로 재생용 (원본은 그대로) */
export function reversedCopy(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i]!;
  }
  return out;
}

/**
 * 계획대로 소리를 예약한다. `destination(trackId)` 는 그 트랙 팬 앞(페이더 뒤) 입력.
 * 만든 소스들을 돌려준다 — 정지할 때 끊어야 한다.
 */
export function scheduleAudioRegions(
  ctx: BaseAudioContext,
  plans: readonly AudioPlan[],
  buffers: ReadonlyMap<string, AudioBuffer>,
  anchorTimeSec: number,
  destination: (trackId: TrackId) => AudioNode | null,
): AudioScheduledNode[] {
  const nodes: AudioScheduledNode[] = [];
  const reversed = new Map<string, AudioBuffer>();
  for (const plan of plans) {
    const base = buffers.get(plan.assetId);
    const dest = destination(plan.trackId);
    if (!base || !dest) continue;
    let buffer = base;
    if (plan.reverse) {
      buffer = reversed.get(plan.assetId) ?? reversedCopy(ctx, base);
      reversed.set(plan.assetId, buffer);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    const at = anchorTimeSec + plan.whenSec;
    // 페이드: 시작·끝 지점과 꺾이는 지점만 찍고 선형으로 잇는다
    const points = [0, plan.fadeInSec, plan.regionSec - plan.fadeOutSec, plan.regionSec]
      .filter((t) => t >= plan.elapsedSec - 1e-9 && t <= plan.regionSec + 1e-9);
    g.gain.setValueAtTime(plan.gain * fadeAt(plan, plan.elapsedSec), at);
    for (const t of points) if (t > plan.elapsedSec) g.gain.linearRampToValueAtTime(plan.gain * fadeAt(plan, t), at + (t - plan.elapsedSec));
    src.connect(g).connect(dest);
    src.start(at, plan.offsetSec, plan.durationSec);
    src.onended = () => { src.disconnect(); g.disconnect(); };
    nodes.push(src);
  }
  return nodes;
}

export type AudioScheduledNode = AudioBufferSourceNode;

export type { AudioRegion };

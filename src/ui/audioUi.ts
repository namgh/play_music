/**
 * 화면 쪽 오디오 도우미 — 파일·녹음을 에셋으로 넣고 클립을 만든다, 파형 봉우리 캐시.
 * 화면용 디코딩은 재생 컨텍스트와 따로 둔다(작은 오프라인 컨텍스트) — 재생 엔진을
 * 깨우지 않고 파형을 그릴 수 있게.
 */

import { useEffect, useState } from 'react';

import type { Project, TrackId } from '../model/project.ts';
import { addClip, addTrack } from '../editor/edits.ts';
import { decodeAsset, peaks, putAsset } from '../audio/assets.ts';
import { secondsToTicks } from '../model/time.ts';
import type { Ticks } from '../model/time.ts';

let decoder: OfflineAudioContext | null = null;
const ctx = () => (decoder ??= new OfflineAudioContext(1, 1, 48000));

export async function importAudioBytes(bytes: ArrayBuffer): Promise<{ assetId: string; seconds: number }> {
  const assetId = await putAsset(bytes);
  const buffer = await decodeAsset(ctx(), assetId);
  if (!buffer) throw new Error('이 형식의 오디오를 읽지 못했습니다 (WAV·MP3·AAC·FLAC·OGG 가 됩니다)');
  return { assetId, seconds: buffer.duration };
}

/**
 * 에셋을 클립으로 놓는다. `trackId` 가 없거나 그 자리에 다른 클립이 있으면 새 오디오 트랙을 만든다.
 * 클립 길이는 소리 길이를 틱으로 바꾼 것 — 템포가 바뀌어도 소리는 늘어나지 않는다.
 */
export function placeAudio(
  project: Project,
  input: { assetId: string; seconds: number; name: string; atTick: Ticks; trackId: TrackId | null },
): { project: Project; trackId: TrackId } {
  const lengthTick = Math.max(1, secondsToTicks(input.seconds + (projectSecondsAt(project, input.atTick)), project.tempo) - input.atTick);
  const tryOn = (p: Project, trackId: TrackId) => {
    const r = addClip(p, { trackId, startTick: input.atTick, lengthTick, label: input.name });
    return {
      project: {
        ...r.project,
        tracks: r.project.tracks.map((t) => (t.id !== trackId ? t : {
          ...t,
          clips: t.clips.map((c) => (c.id !== r.clipId ? c : {
            ...c,
            audio: { assetId: input.assetId, name: input.name, assetSec: input.seconds, offsetSec: 0, gainDb: 0, fadeInSec: 0, fadeOutSec: 0, reverse: false },
          })),
        })),
      },
      trackId,
    };
  };
  if (input.trackId) {
    try { return tryOn(project, input.trackId); } catch { /* 겹친다 — 새 트랙으로 */ }
  }
  const made = addTrack(project, { name: input.name.replace(/\.[^.]+$/, ''), instrumentId: 'acoustic-guitar' });
  const withKind: Project = { ...made.project, tracks: made.project.tracks.map((t) => (t.id === made.trackId ? { ...t, kind: 'audio' as const } : t)) };
  return tryOn(withKind, made.trackId);
}

function projectSecondsAt(project: Project, tick: Ticks): number {
  // ticksToSeconds 를 거꾸로 쓰지 않으려고 — 시작 자리 초 + 소리 길이 → 끝 틱
  let lo = 0;
  let hi = 1e6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (secondsToTicks(mid, project.tempo) < tick) lo = mid; else hi = mid;
  }
  return lo;
}

const peakCache = new Map<string, Float32Array>();

/** 파형 봉우리 (bins 개). 처음엔 null, 풀리면 다시 그린다 */
export function usePeaks(assetId: string | undefined, bins = 400): Float32Array | null {
  const key = assetId ? `${assetId}:${bins}` : '';
  const [value, setValue] = useState<Float32Array | null>(() => (key ? peakCache.get(key) ?? null : null));
  useEffect(() => {
    if (!assetId) { setValue(null); return; }
    const hit = peakCache.get(key);
    if (hit) { setValue(hit); return; }
    let alive = true;
    void decodeAsset(ctx(), assetId).then((b) => {
      if (!b || !alive) return;
      const p = peaks(b, bins);
      peakCache.set(key, p);
      setValue(p);
    });
    return () => { alive = false; };
  }, [assetId, bins, key]);
  return value;
}

/** 마이크 녹음 — MediaRecorder. 멈추면 바이트를 돌려준다 */
export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  /** `deviceId` — 설정에서 고른 마이크. 없으면 시스템 기본 */
  async start(deviceId: string | null = null): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
    this.recorder = new MediaRecorder(this.stream);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.start();
  }

  stop(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const r = this.recorder;
      if (!r) { reject(new Error('녹음 중이 아니다')); return; }
      r.onstop = async () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve(await new Blob(this.chunks, { type: r.mimeType }).arrayBuffer());
      };
      r.stop();
    });
  }
}

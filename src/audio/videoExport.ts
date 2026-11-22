/**
 * 영상과 함께 내보내기 — 영상의 그림 + 곡의 믹스를 한 파일(WebM)로.
 *
 * 브라우저에는 영상을 다시 싸는 도구가 없어서 **실시간으로 한 번 틀면서 녹화한다**
 * (영상 길이만큼 걸린다). 영상의 원래 소리는 넣지 않는다 — 필요하면 "소리 꺼내기"로
 * 오디오 트랙에 올려 믹스에 섞는다. 감독·편집자에게 "이 장면에 이 음악" 을 보여 주는 용도다.
 */

export interface VideoExportInput {
  videoBytes: ArrayBuffer;
  /** 곡 믹스 (채널마다) */
  channels: Float32Array[];
  sampleRate: number;
  /** 영상이 곡의 몇 초에서 시작하는가 (음수면 영상이 먼저 시작) */
  offsetSec: number;
  onProgress?: (ratio: number) => void;
}

/** 녹화에 쓸 형식 — 되는 것 중 첫째 */
export function pickVideoMime(isSupported: (mime: string) => boolean): string | null {
  for (const mime of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
    if (isSupported(mime)) return mime;
  }
  return null;
}

/**
 * 영상 시각 0 에서 곡의 어디를 틀어야 하는가.
 * 영상이 곡 `offsetSec` 초에 시작하니, 양수면 믹스를 그만큼 건너뛰어 시작하고 음수면 그만큼 기다렸다 튼다.
 */
export function mixStart(offsetSec: number): { skipSec: number; delaySec: number } {
  return offsetSec >= 0 ? { skipSec: offsetSec, delaySec: 0 } : { skipSec: 0, delaySec: -offsetSec };
}

export async function exportVideoWithMix(input: VideoExportInput): Promise<Blob> {
  const mime = pickVideoMime((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('이 브라우저는 영상 녹화를 지원하지 않습니다');
  const url = URL.createObjectURL(new Blob([input.videoBytes]));
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  const ctx = new AudioContext({ sampleRate: input.sampleRate });
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('영상을 열 수 없습니다'));
    });
    const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
    if (!capture) throw new Error('이 브라우저는 영상 그림을 받아 오지 못합니다');
    const buffer = ctx.createBuffer(Math.max(1, input.channels.length), Math.max(1, input.channels[0]?.length ?? 1), input.sampleRate);
    input.channels.forEach((data, ch) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, ch));
    const dest = ctx.createMediaStreamDestination();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);

    const stream = new MediaStream([...capture.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 256_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

    const { skipSec, delaySec } = mixStart(input.offsetSec);
    recorder.start(250);
    if (skipSec < buffer.duration) source.start(ctx.currentTime + delaySec, skipSec);
    await video.play();
    await new Promise<void>((resolve) => {
      const tick = () => {
        input.onProgress?.(video.duration > 0 ? Math.min(1, video.currentTime / video.duration) : 0);
        if (video.ended) resolve(); else setTimeout(tick, 200);
      };
      video.onended = () => resolve();
      tick();
    });
    recorder.stop();
    await done;
    return new Blob(chunks, { type: mime.split(';')[0]! });
  } finally {
    URL.revokeObjectURL(url);
    void ctx.close();
  }
}

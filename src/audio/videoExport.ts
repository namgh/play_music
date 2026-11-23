/**
 * 영상과 함께 내보내기 — 영상의 그림 + 곡의 믹스를 한 파일(MP4 · WebM)로.
 *
 * 먼저 **다시 싸기**(`muxVideoWithMix`)를 한다: 영상의 그림을 그대로 옮기고(그 그릇이 못 담는
 * 코덱이면 다시 인코딩) 곡의 믹스를 AAC/Opus 로 붙인다. 틀어 보지 않으므로 영상 길이보다 훨씬 빠르고
 * 그림이 열화되지 않는다. 영상 파일을 못 읽으면 예전 방식 — **실시간으로 한 번 틀면서 녹화**
 * (`recordVideoWithMix`, WebM, 영상 길이만큼 걸린다) — 으로 물러난다.
 *
 * 영상의 원래 소리는 넣지 않는다 — 필요하면 "소리 꺼내기"로 오디오 트랙에 올려 믹스에 섞는다.
 */

export type VideoContainer = 'mp4' | 'webm';

export interface VideoExportInput {
  videoBytes: ArrayBuffer;
  /** 곡 믹스 (채널마다) */
  channels: Float32Array[];
  sampleRate: number;
  /** 영상이 곡의 몇 초에서 시작하는가 (음수면 영상이 먼저 시작) */
  offsetSec: number;
  onProgress?: (ratio: number) => void;
  /** 담을 그릇. 없으면 MP4 */
  container?: VideoContainer;
}

export interface VideoExportResult {
  blob: Blob;
  ext: VideoContainer;
  /** 그림을 어떻게 옮겼나 — 그대로 / 다시 인코딩 / 실시간 녹화 */
  how: 'copy' | 'transcode' | 'record';
}

/** MP4 에 그림을 다시 인코딩하지 않고 옮겨도 되는 코덱인가 */
export function copyableInMp4(codec: string | null): boolean {
  return codec === 'avc' || codec === 'hevc';
}

/** 영상 길이만큼의 믹스 — 영상 시각 0 부터, 비는 곳은 무음 */
export function alignMix(channels: readonly Float32Array[], sampleRate: number, offsetSec: number, durationSec: number): Float32Array[] {
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const shift = Math.round(offsetSec * sampleRate);
  return channels.map((src) => {
    const out = new Float32Array(frames);
    const from = Math.max(0, -shift);
    const to = Math.min(frames, src.length - shift);
    for (let i = from; i < to; i++) { const v = src[i + shift]!; out[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
    return out;
  });
}

/**
 * 다시 싸기 — 틀지 않고 파일을 만든다. 그림은 그릇이 담을 수 있으면 그대로 옮긴다.
 */
export async function muxVideoWithMix(input: VideoExportInput): Promise<VideoExportResult> {
  const container = input.container ?? 'mp4';
  const mb = await import('mediabunny');
  const source = new mb.Input({ source: new mb.BufferSource(input.videoBytes), formats: mb.ALL_FORMATS });
  try {
    const track = await source.getPrimaryVideoTrack();
    if (!track) throw new Error('영상에 그림이 없습니다');
    const codec = await track.getCodec();
    const duration = await track.computeDuration();
    if (!(duration > 0)) throw new Error('영상 길이를 읽지 못했습니다');
    const format = container === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
    const target = new mb.BufferTarget();
    const output = new mb.Output({ format, target });

    const decoderConfig = await track.getDecoderConfig();
    // MP4 는 "어디서나 열리는 파일" 이어야 한다 — 그릇은 VP8·VP9 도 담지만 그러면 QuickTime·TV·메신저가 못 연다.
    // 그래서 MP4 에는 H.264·H.265 만 그대로 옮기고 나머지는 H.264 로 다시 인코딩한다
    const portable = container === 'mp4' ? copyableInMp4(codec) : codec !== null && format.getSupportedVideoCodecs().includes(codec);
    const copy = portable && decoderConfig !== null && codec !== null;
    const rotation = await track.getRotation();
    let pumpVideo: () => Promise<void>;
    if (copy) {
      const video = new mb.EncodedVideoPacketSource(codec);
      output.addVideoTrack(video, { rotation });
      pumpVideo = async () => {
        const sink = new mb.EncodedPacketSink(track);
        let first = true;
        for await (const packet of sink.packets()) {
          await video.add(packet, first ? { decoderConfig } : undefined);
          first = false;
          input.onProgress?.(Math.max(0, Math.min(1, packet.timestamp / duration)));
        }
      };
    } else {
      if (!(await track.canDecode())) throw new Error('이 영상의 그림을 풀지 못합니다');
      const width = await track.getDisplayWidth();
      const height = await track.getDisplayHeight();
      const quality = new mb.Quality('high');
      const wanted = container === 'mp4' ? format.getSupportedVideoCodecs().filter((c) => c === 'avc') : format.getSupportedVideoCodecs();
      const outCodec = await mb.getFirstEncodableVideoCodec(wanted, { width, height, quality });
      if (!outCodec) throw new Error('이 브라우저는 그 형식으로 그림을 담지 못합니다');
      const video = new mb.VideoSampleSource({ codec: outCodec, quality });
      output.addVideoTrack(video);
      pumpVideo = async () => {
        const sink = new mb.VideoSampleSink(track);
        for await (const sample of sink.samples()) {
          await video.add(sample);
          input.onProgress?.(Math.max(0, Math.min(1, sample.timestamp / duration)));
          sample.close();
        }
      };
    }

    const sampleRate = input.sampleRate;
    const mix = alignMix(input.channels.length > 0 ? input.channels : [new Float32Array(1)], sampleRate, input.offsetSec, duration);
    const numberOfChannels = mix.length;
    const probe = { numberOfChannels, sampleRate };
    let audioCodec = await mb.getFirstEncodableAudioCodec(format.getSupportedAudioCodecs().filter((c) => c === 'aac' || c === 'opus'), probe);
    if (!audioCodec && container === 'mp4') {
      (await import('@mediabunny/aac-encoder')).registerAacEncoder();
      audioCodec = 'aac';
    }
    if (!audioCodec) throw new Error('이 브라우저는 그 형식으로 소리를 담지 못합니다');
    const audio = new mb.AudioSampleSource({ codec: audioCodec, quality: new mb.Quality({ bitrate: 256_000 }) });
    output.addAudioTrack(audio);

    await output.start();
    const pumpAudio = async () => {
      const frames = mix[0]!.length;
      const CHUNK = Math.round(sampleRate / 2);
      for (let at = 0; at < frames; at += CHUNK) {
        const n = Math.min(CHUNK, frames - at);
        const data = new Float32Array(n * numberOfChannels);
        for (let ch = 0; ch < numberOfChannels; ch++) data.set(mix[ch]!.subarray(at, at + n), ch * n);
        const sample = new mb.AudioSample({ data, format: 'f32-planar', numberOfChannels, sampleRate, timestamp: at / sampleRate });
        await audio.add(sample);
        sample.close();
      }
    };
    try {
      // 둘을 같이 민다 — 한쪽만 먼저 다 넣으면 다른 쪽이 올 때까지 통째로 쥐고 있는다
      await Promise.all([pumpVideo(), pumpAudio()]);
      await output.finalize();
    } catch (err) {
      await output.cancel().catch(() => { /* 이미 끝났다 */ });
      throw err;
    }
    if (!target.buffer) throw new Error('파일을 쓰지 못했습니다');
    input.onProgress?.(1);
    return { blob: new Blob([target.buffer], { type: container === 'mp4' ? 'video/mp4' : 'video/webm' }), ext: container, how: copy ? 'copy' : 'transcode' };
  } finally {
    source.dispose();
  }
}

/**
 * 영상과 함께 내보내기 — 다시 싸기를 먼저 하고, 안 되면 실시간 녹화로 물러난다.
 * `fellBack` 에 물러난 까닭을 담는다 (사용자에게 왜 오래 걸리는지 알려야 한다).
 */
export async function exportVideoWithMix(input: VideoExportInput, onFallback?: (why: string) => void): Promise<VideoExportResult> {
  try {
    return await muxVideoWithMix(input);
  } catch (err) {
    onFallback?.(err instanceof Error ? err.message : String(err));
    const blob = await recordVideoWithMix(input);
    return { blob, ext: blob.type.includes('mp4') ? 'mp4' : 'webm', how: 'record' };
  }
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

/** 실시간 녹화 — 영상을 한 번 틀면서 그림과 믹스를 같이 받아 적는다 (영상 길이만큼 걸린다) */
export async function recordVideoWithMix(input: VideoExportInput): Promise<Blob> {
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

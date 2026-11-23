/**
 * 내보내기 형식 — WAV · FLAC · MP3 · M4A(AAC) · OGG(Opus).
 *
 * WAV 는 우리 인코더(`wav.ts`)가 쓴다. 나머지는 mediabunny 가 싼다 — 브라우저에 그 코덱이
 * 있으면 그것을, 없으면 WASM 인코더(LAME · libFLAC · FFmpeg AAC)를 쓴다. 인코더는 **고를 때만**
 * 내려받는다 (WAV 만 쓰는 사람은 한 바이트도 안 받는다).
 *
 * 렌더는 한 번이고 형식은 그 결과를 싸는 일이다 — 형식마다 소리가 달라지지 않게 (`bounce.ts`).
 */

import { encodeWav } from './wav.ts';

export type AudioFormat = 'wav' | 'flac' | 'mp3' | 'm4a' | 'ogg';

export interface AudioFormatInfo {
  id: AudioFormat;
  label: string;
  ext: string;
  mime: string;
  /** 손실 압축 — 비트레이트를 고른다. 아니면 비트 깊이를 고른다 */
  lossy: boolean;
  bitDepths: readonly (16 | 24 | 32)[];
  hint: string;
}

export const AUDIO_FORMATS: readonly AudioFormatInfo[] = [
  { id: 'wav', label: 'WAV', ext: 'wav', mime: 'audio/wav', lossy: false, bitDepths: [24, 16, 32], hint: '무손실 · 어디서나 열립니다' },
  { id: 'flac', label: 'FLAC', ext: 'flac', mime: 'audio/flac', lossy: false, bitDepths: [24, 16], hint: '무손실 · WAV 의 절반쯤 크기' },
  { id: 'mp3', label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', lossy: true, bitDepths: [], hint: '보내기 좋은 작은 파일' },
  { id: 'm4a', label: 'M4A', ext: 'm4a', mime: 'audio/mp4', lossy: true, bitDepths: [], hint: 'AAC · 아이폰·스트리밍용' },
  { id: 'ogg', label: 'OGG', ext: 'ogg', mime: 'audio/ogg', lossy: true, bitDepths: [], hint: 'Opus · 48kHz 로만 담습니다' },
];

export const BITRATES = [128, 192, 256, 320] as const;

export function formatInfo(format: AudioFormat): AudioFormatInfo {
  return AUDIO_FORMATS.find((f) => f.id === format) ?? AUDIO_FORMATS[0]!;
}

export interface EncodeOptions {
  format: AudioFormat;
  sampleRate: number;
  /** 무손실 형식의 비트 깊이 (32 는 WAV float 만) */
  bitDepth: 16 | 24 | 32;
  /** 손실 형식의 비트레이트 */
  kbps: number;
}

/** 이 형식이 받는 값으로 옵션을 맞춘다 — 창이 형식을 바꿀 때 남은 값이 어긋나지 않게 */
export function fitOptions(options: EncodeOptions): EncodeOptions {
  const info = formatInfo(options.format);
  const bitDepth = info.lossy ? 24 : (info.bitDepths.includes(options.bitDepth) ? options.bitDepth : info.bitDepths[0]!);
  // Opus 는 48kHz 로만 돈다
  const sampleRate = options.format === 'ogg' ? 48000 : options.sampleRate;
  return { ...options, bitDepth, sampleRate };
}

/** 디더가 필요한가 — 16bit 정수로 줄일 때만 */
export function needsDither(options: EncodeOptions): boolean {
  return !formatInfo(options.format).lossy && options.bitDepth === 16;
}

const registered = new Set<string>();

/**
 * 채널을 그 형식의 파일 바이트로. 채널 길이가 다르면 가장 긴 것에 맞춘다.
 * 손실 형식과 FLAC 은 ±1 을 넘는 값을 자른다 (WAV 32bit float 만 그대로 담는다).
 */
export async function encodeAudio(channels: readonly Float32Array[], options: EncodeOptions): Promise<Uint8Array> {
  if (channels.length === 0) throw new Error('채널이 없다');
  const o = fitOptions(options);
  if (o.format === 'wav') return encodeWav(channels, { sampleRate: o.sampleRate, bitDepth: o.bitDepth });

  const mb = await import('mediabunny');
  const numberOfChannels = channels.length;
  const frames = channels.reduce((max, ch) => Math.max(max, ch.length), 0);
  const probe = { numberOfChannels, sampleRate: o.sampleRate };

  let codec: 'flac' | 'mp3' | 'aac' | 'opus';
  let format: InstanceType<typeof mb.FlacOutputFormat | typeof mb.Mp3OutputFormat | typeof mb.Mp4OutputFormat | typeof mb.OggOutputFormat>;
  if (o.format === 'flac') {
    codec = 'flac';
    format = new mb.FlacOutputFormat();
    if (!registered.has('flac') && !(await mb.canEncodeAudio('flac', probe))) {
      (await import('@mediabunny/flac-encoder')).registerFlacEncoder();
      registered.add('flac');
    }
  } else if (o.format === 'mp3') {
    codec = 'mp3';
    format = new mb.Mp3OutputFormat();
    if (!registered.has('mp3') && !(await mb.canEncodeAudio('mp3', probe))) {
      (await import('@mediabunny/mp3-encoder')).registerMp3Encoder();
      registered.add('mp3');
    }
  } else if (o.format === 'm4a') {
    codec = 'aac';
    format = new mb.Mp4OutputFormat({ fastStart: 'in-memory' });
    if (!registered.has('aac') && !(await mb.canEncodeAudio('aac', probe))) {
      (await import('@mediabunny/aac-encoder')).registerAacEncoder();
      registered.add('aac');
    }
  } else {
    codec = 'opus';
    format = new mb.OggOutputFormat();
    if (!(await mb.canEncodeAudio('opus', probe))) throw new Error('이 브라우저는 Opus 로 담지 못합니다 — MP3 나 M4A 를 고르세요');
  }

  const target = new mb.BufferTarget();
  const output = new mb.Output({ format, target });
  const source = new mb.AudioSampleSource(codec === 'flac'
    ? { codec }
    : { codec, quality: new mb.Quality({ bitrate: o.kbps * 1000 }) });
  output.addAudioTrack(source);
  await output.start();

  // 1초씩 — 통째로 넣으면 인코더가 한 번에 다 물고 있는다
  const CHUNK = o.sampleRate;
  const clamp = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);
  for (let at = 0; at < frames; at += CHUNK) {
    const n = Math.min(CHUNK, frames - at);
    let data: Float32Array | Int16Array;
    let sampleFormat: 'f32-planar' | 's16';
    if (codec === 'flac' && o.bitDepth === 16) {
      // libFLAC 은 들어온 표본 형식으로 비트 깊이를 정한다 — 16bit 는 정수로 넘긴다
      sampleFormat = 's16';
      data = new Int16Array(n * numberOfChannels);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const src = channels[ch]!;
        for (let i = 0; i < n; i++) data[i * numberOfChannels + ch] = Math.round(clamp(at + i < src.length ? src[at + i]! : 0) * 32767);
      }
    } else {
      sampleFormat = 'f32-planar';
      data = new Float32Array(n * numberOfChannels);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const src = channels[ch]!;
        for (let i = 0; i < n; i++) data[ch * n + i] = clamp(at + i < src.length ? src[at + i]! : 0);
      }
    }
    const sample = new mb.AudioSample({ data, format: sampleFormat, numberOfChannels, sampleRate: o.sampleRate, timestamp: at / o.sampleRate });
    await source.add(sample);
    sample.close();
  }
  await output.finalize();
  if (!target.buffer) throw new Error('파일을 쓰지 못했다');
  return new Uint8Array(target.buffer);
}

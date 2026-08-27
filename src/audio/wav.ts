/**
 * WAV 인코딩 (`plan.md` 5-1 Phase 1 완료 조건 — "내보낼 수 있다").
 *
 * 24bit 정수 PCM 으로 쓴다 (`sound.md` 6-6: 출력 48kHz, 내보내기 24bit).
 * 32bit float 도 규격에는 있지만 받는 쪽 호환성이 떨어진다.
 *
 * 순수 함수다 — 브라우저 API 없이 테스트된다. 다운로드는 호출자 몫.
 */

export type BitDepth = 16 | 24;

export interface WavOptions {
  sampleRate: number;
  bitDepth?: BitDepth;
}

/**
 * 채널들의 최대 진폭. **1 을 넘으면 인코딩에서 잘린다** (`quantizeSample` 이 자른다).
 *
 * 조용히 잘린 파일이 나가는 것이 문제다 — 사용자는 자기 곡이 그대로 나갔다고 믿는다.
 * 리미터를 다는 대신 **알려 준다** (`WORKPLAN.md` 4절: 마스터 리미터는 안 넣는다).
 */
export function peakAmplitude(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

/** float 샘플을 정수로. 클리핑은 여기서 한 번만 한다 */
function quantizeSample(value: number, maxAmplitude: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  // 음수 쪽이 한 칸 더 넓은 2의 보수 범위를 그대로 쓰지 않고 대칭으로 자른다.
  // 비대칭으로 스케일하면 0 이 0 으로 가지 않아 DC 가 생긴다
  return Math.round(clamped * maxAmplitude);
}

/**
 * 채널별 Float32 를 WAV 바이트로. 채널 길이가 다르면 가장 긴 것에 맞춰 0으로 채운다.
 */
export function encodeWav(channels: readonly Float32Array[], options: WavOptions): Uint8Array {
  if (channels.length === 0) throw new Error('채널이 없다');
  const bitDepth = options.bitDepth ?? 24;
  const bytesPerSample = bitDepth / 8;
  const numChannels = channels.length;
  const frames = channels.reduce((max, ch) => Math.max(max, ch.length), 0);

  const dataBytes = frames * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');

  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt 청크 크기
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, options.sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true);                      // block align
  view.setUint16(34, bitDepth, true);

  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const maxAmplitude = Math.pow(2, bitDepth - 1) - 1;
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const source = channels[ch]!;
      const sample = quantizeSample(frame < source.length ? source[frame]! : 0, maxAmplitude);
      if (bitDepth === 16) {
        view.setInt16(offset, sample, true);
        offset += 2;
      } else {
        // 24bit 은 DataView 에 없으므로 리틀엔디언으로 직접 쓴다
        const u = sample < 0 ? sample + 0x1000000 : sample;
        bytes[offset] = u & 0xff;
        bytes[offset + 1] = (u >> 8) & 0xff;
        bytes[offset + 2] = (u >> 16) & 0xff;
        offset += 3;
      }
    }
  }

  return bytes;
}

/** 헤더만 읽어 되돌린다 — 테스트와 디버깅용 */
export function readWavHeader(bytes: Uint8Array): {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  frames: number;
  /** 데이터 청크가 시작하는 자리. **44 라고 가정하면 안 된다** (위 주석) */
  dataOffset: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV 가 아니다');

  // **청크를 훑는다. 44바이트 헤더를 가정하지 않는다.**
  //
  // 우리가 쓴 파일은 늘 표준 배치라 고정 오프셋으로도 돌았다. 그런데 **밖에서 온
  // 파일은 대부분 그렇지 않다** — macOS `afconvert` 는 `fmt ` 를 40바이트 확장
  // 형식으로 쓰고 그 뒤에 `FLLR` 채움 청크를 넣는다. 그러면 데이터가 4096바이트
  // 지점에서 시작하는데, 44 로 읽으면 **조용히 0초짜리로 읽힌다.** 값이 틀리는 것도
  // 아니고 길이가 0 이 되니, 비교 결과 전체가 말없이 무의미해진다.
  let cursor = 12;
  let fmtAt = -1;
  let dataAt = -1;
  let dataBytes = 0;
  while (cursor + 8 <= bytes.length) {
    const id = tag(cursor);
    const size = view.getUint32(cursor + 4, true);
    if (id === 'fmt ') fmtAt = cursor + 8;
    if (id === 'data') {
      dataAt = cursor + 8;
      // 크기를 0 이나 과대값으로 쓰는 인코더가 있다 — 파일 길이로 자른다
      dataBytes = size > 0 && size <= bytes.length - dataAt ? size : bytes.length - dataAt;
      break;
    }
    if (size <= 0) break;
    cursor += 8 + size + (size % 2); // 청크는 짝수 경계에 붙는다
  }
  if (fmtAt < 0 || dataAt < 0) throw new Error('WAV 에 fmt 나 data 청크가 없다');

  const channels = view.getUint16(fmtAt + 2, true);
  const bitDepth = view.getUint16(fmtAt + 14, true);
  return {
    sampleRate: view.getUint32(fmtAt + 4, true),
    channels,
    bitDepth,
    frames: Math.floor(dataBytes / (channels * (bitDepth / 8))),
    dataOffset: dataAt,
  };
}

/** 데이터 청크를 float 로 되돌린다 — 왕복 검증용 */
export function decodeWav(bytes: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  const header = readWavHeader(bytes);
  const bytesPerSample = header.bitDepth / 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxAmplitude = Math.pow(2, header.bitDepth - 1) - 1;

  const channels = Array.from({ length: header.channels }, () => new Float32Array(header.frames));
  let offset = header.dataOffset;
  for (let frame = 0; frame < header.frames; frame++) {
    for (let ch = 0; ch < header.channels; ch++) {
      let sample: number;
      if (header.bitDepth === 16) {
        sample = view.getInt16(offset, true);
      } else {
        const u = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
        sample = u >= 0x800000 ? u - 0x1000000 : u;
      }
      channels[ch]![frame] = sample / maxAmplitude;
      offset += bytesPerSample;
    }
  }
  return { channels, sampleRate: header.sampleRate };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_FORMATS, encodeAudio, fitOptions, formatInfo, needsDither } from './encode.ts';
import { decodeWav, readWavHeader } from './wav.ts';

const sine = (n: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / 48000));

test('형식 옵션 — 형식이 못 받는 값은 그 형식의 것으로 맞춘다', () => {
  assert.equal(fitOptions({ format: 'flac', sampleRate: 48000, bitDepth: 32, kbps: 256 }).bitDepth, 24);
  assert.equal(fitOptions({ format: 'wav', sampleRate: 44100, bitDepth: 32, kbps: 256 }).bitDepth, 32);
  // Opus 는 48kHz 로만
  assert.equal(fitOptions({ format: 'ogg', sampleRate: 44100, bitDepth: 24, kbps: 192 }).sampleRate, 48000);
  assert.equal(fitOptions({ format: 'mp3', sampleRate: 44100, bitDepth: 16, kbps: 192 }).sampleRate, 44100);
});

test('디더 — 16bit 정수로 줄일 때만. 손실 형식은 16 이 남아 있어도 걸지 않는다', () => {
  assert.equal(needsDither(fitOptions({ format: 'wav', sampleRate: 48000, bitDepth: 16, kbps: 256 })), true);
  assert.equal(needsDither(fitOptions({ format: 'flac', sampleRate: 48000, bitDepth: 16, kbps: 256 })), true);
  assert.equal(needsDither(fitOptions({ format: 'wav', sampleRate: 48000, bitDepth: 24, kbps: 256 })), false);
  assert.equal(needsDither(fitOptions({ format: 'mp3', sampleRate: 48000, bitDepth: 16, kbps: 256 })), false);
});

test('형식 목록 — 확장자가 겹치지 않고, 모르는 형식은 WAV 로', () => {
  assert.equal(new Set(AUDIO_FORMATS.map((f) => f.ext)).size, AUDIO_FORMATS.length);
  assert.equal(formatInfo('nope' as never).id, 'wav');
});

test('WAV 32bit float — 1 을 넘는 값도 자르지 않고 그대로 돌아온다', async () => {
  const left = Float32Array.from([0, 0.25, -0.5, 1.5, -2.25, 1e-7]);
  const bytes = await encodeAudio([left, left], { format: 'wav', sampleRate: 48000, bitDepth: 32, kbps: 256 });
  const header = readWavHeader(bytes);
  assert.equal(header.format, 3);
  assert.equal(header.bitDepth, 32);
  assert.equal(header.frames, left.length);
  assert.deepEqual([...decodeWav(bytes).channels[1]!], [...left]);
});

test('WAV 24bit — 정수 형식은 그대로 (꼬리표 1), ±1 에서 자른다', async () => {
  const bytes = await encodeAudio([Float32Array.from([0.5, 3, -3])], { format: 'wav', sampleRate: 44100, bitDepth: 24, kbps: 256 });
  assert.equal(readWavHeader(bytes).format, 1);
  const back = decodeWav(bytes).channels[0]!;
  assert.ok(Math.abs(back[0]! - 0.5) < 1e-6);
  assert.equal(back[1], 1);
  assert.equal(back[2], -1);
});

test('MP3 · FLAC — 브라우저 없이도 WASM 인코더가 파일을 쓴다 (머리와 크기)', async () => {
  const ch = sine(48000);
  const mp3 = await encodeAudio([ch, ch], { format: 'mp3', sampleRate: 48000, bitDepth: 24, kbps: 128 });
  assert.ok(mp3[0] === 0xff || String.fromCharCode(...mp3.subarray(0, 3)) === 'ID3');
  // 1초 · 128kbps = 16KB 안팎
  assert.ok(mp3.length > 12000 && mp3.length < 22000, `mp3 ${mp3.length}`);
  const flac = await encodeAudio([ch, ch], { format: 'flac', sampleRate: 48000, bitDepth: 16, kbps: 256 });
  assert.equal(String.fromCharCode(...flac.subarray(0, 4)), 'fLaC');
  // 스트림 정보: 표본율 20bit · 채널 3bit · 비트 깊이 5bit
  const info = (flac[18]! << 16) | (flac[19]! << 8) | flac[20]!;
  assert.equal(info >> 4, 48000);
  assert.equal(((info >> 1) & 7) + 1, 2);
  assert.equal((((info & 1) << 4) | (flac[21]! >> 4)) + 1, 16);
  assert.ok(flac.length < 48000 * 2 * 2, `flac ${flac.length}`);
});

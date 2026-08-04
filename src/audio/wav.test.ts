import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeWav, encodeWav, readWavHeader } from './wav.ts';

test('헤더가 규격대로 쓰인다', () => {
  const pcm = new Float32Array(100);
  const bytes = encodeWav([pcm], { sampleRate: 48000, bitDepth: 24 });
  const header = readWavHeader(bytes);
  assert.deepEqual(header, { sampleRate: 48000, channels: 1, bitDepth: 24, frames: 100 });
  assert.equal(bytes.length, 44 + 100 * 3);
});

test('스테레오·16bit', () => {
  const bytes = encodeWav([new Float32Array(50), new Float32Array(50)], {
    sampleRate: 44100,
    bitDepth: 16,
  });
  const header = readWavHeader(bytes);
  assert.equal(header.channels, 2);
  assert.equal(header.bitDepth, 16);
  assert.equal(header.frames, 50);
});

test('24bit 왕복 오차가 양자화 한 칸 이내다', () => {
  const n = 4096;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.9 * Math.sin((2 * Math.PI * 440 * i) / 48000);

  const { channels } = decodeWav(encodeWav([pcm], { sampleRate: 48000, bitDepth: 24 }));
  const step = 1 / (Math.pow(2, 23) - 1);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(channels[0]![i]! - pcm[i]!));
  assert.ok(worst <= step, `왕복 오차 ${worst.toExponential(2)} 가 양자화 단위 ${step.toExponential(2)} 를 넘는다`);
});

test('채널 순서가 프레임 단위로 섞인다 (인터리브)', () => {
  const left = new Float32Array([1, 0, 1, 0]);
  const right = new Float32Array([0, 1, 0, 1]);
  const { channels } = decodeWav(encodeWav([left, right], { sampleRate: 48000, bitDepth: 16 }));
  assert.deepEqual([...channels[0]!].map(Math.round), [1, 0, 1, 0]);
  assert.deepEqual([...channels[1]!].map(Math.round), [0, 1, 0, 1]);
});

test('범위를 넘는 샘플은 클리핑된다', () => {
  const pcm = new Float32Array([2, -2, 0]);
  const { channels } = decodeWav(encodeWav([pcm], { sampleRate: 48000, bitDepth: 24 }));
  assert.ok(Math.abs(channels[0]![0]! - 1) < 1e-6);
  assert.ok(Math.abs(channels[0]![1]! - -1) < 1e-6);
  assert.equal(channels[0]![2], 0);
});

test('0 은 정확히 0 으로 간다', () => {
  // 비대칭 스케일을 쓰면 무음에 DC 가 생긴다
  const { channels } = decodeWav(encodeWav([new Float32Array(64)], { sampleRate: 48000 }));
  assert.ok(channels[0]!.every((v) => v === 0));
});

test('채널 길이가 다르면 긴 쪽에 맞춰 0으로 채운다', () => {
  const bytes = encodeWav([new Float32Array(10), new Float32Array(4)], { sampleRate: 48000 });
  assert.equal(readWavHeader(bytes).frames, 10);
  const { channels } = decodeWav(bytes);
  assert.ok(channels[1]!.slice(4).every((v) => v === 0));
});

test('채널이 없으면 에러다', () => {
  assert.throws(() => encodeWav([], { sampleRate: 48000 }), /채널/);
});

test('WAV 가 아닌 바이트를 읽으면 에러다', () => {
  assert.throws(() => readWavHeader(new Uint8Array(64)), /WAV/);
});

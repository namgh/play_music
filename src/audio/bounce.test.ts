/**
 * 바운스 후처리 (`LOGIC_PARITY.md` 1-13).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fadeOutTail, measureBounce, normalizePeak, safeFileName, sliceRange, tpdfDither } from './bounce.ts';

const sine = (sec: number, sr = 48000, amp = 0.5) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * 1000 * i) / sr));

test('범위 자르기 — 초 단위, 넘치면 있는 데까지', () => {
  const ch = [Float32Array.from({ length: 100 }, (_, i) => i)];
  assert.deepEqual([...sliceRange(ch, 10, { startSec: 2, endSec: 3 })[0]!], [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  assert.equal(sliceRange(ch, 10, { startSec: 9, endSec: 99 })[0]!.length, 10);
});

test('끝 페이드 — 마지막 샘플은 0, 앞은 그대로', () => {
  const out = fadeOutTail([new Float32Array(1000).fill(1)], 48000, 10)[0]!;
  assert.equal(out[999], 0);
  assert.equal(out[0], 1);
});

test('노멀라이즈 — 피크가 목표 dB, 무음은 그대로', () => {
  const { channels, gainDb } = normalizePeak([sine(0.1, 48000, 0.25)], -1);
  const peak = Math.max(...channels[0]!.map(Math.abs));
  assert.ok(Math.abs(20 * Math.log10(peak) + 1) < 0.01);
  assert.ok(Math.abs(gainDb - (20 * Math.log10(0.25) * -1 - 1)) < 0.1);
  assert.equal(normalizePeak([new Float32Array(10)], -1).gainDb, 0);
});

test('디더 — 1 LSB 안쪽, 씨앗이 같으면 같은 결과', () => {
  const x = [new Float32Array(1000)];
  const a = tpdfDither(x, 16, 3)[0]!;
  const lsb = 1 / 32767;
  assert.ok(a.every((v) => Math.abs(v) <= lsb));
  assert.ok(a.some((v) => v !== 0));
  assert.deepEqual(a, tpdfDither(x, 16, 3)[0]);
});

test('측정 — 사인 0.5 는 피크 −6dB, 48k 에서만 LUFS', () => {
  const r = measureBounce([sine(1), sine(1)], 48000);
  assert.ok(Math.abs(r.peakDb + 6.02) < 0.05);
  assert.ok(r.truePeakDb >= r.peakDb - 0.01);
  assert.ok(r.lufs !== null && r.lufs < -3 && r.lufs > -12, String(r.lufs));
  assert.equal(measureBounce([sine(1, 44100)], 44100).lufs, null);
  assert.equal(safeFileName(' a/b:c ', 'x'), 'a-b-c');
});

test('ZIP — 표준 CRC, 이름 UTF-8, 풀면 같은 바이트', async () => {
  const { crc32, makeZip } = await import('./zip.ts');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const a = new Uint8Array([1, 2, 3]);
  const b = new TextEncoder().encode('베이스');
  const zip = makeZip([{ name: '킥.wav', data: a }, { name: 'b.txt', data: b }]);
  const dir = await import('node:os').then((os) => os.tmpdir());
  const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const folder = mkdtempSync(join(dir, 'zip-'));
  writeFileSync(join(folder, 't.zip'), zip);
  // macOS 의 unzip 은 UTF-8 이름을 깨뜨린다 — 표준을 지키는 파이썬 zipfile 로 푼다
  execFileSync('python3', ['-I', '-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', join(folder, 't.zip'), folder]);
  assert.deepEqual([...readFileSync(join(folder, '킥.wav'))], [1, 2, 3]);
  assert.equal(readFileSync(join(folder, 'b.txt'), 'utf8'), '베이스');
});

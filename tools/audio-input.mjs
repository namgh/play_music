/**
 * 비교에 넣을 오디오 파일을 읽는다 — **WAV 가 아니어도 받는다.**
 *
 * 사람이 들고 오는 파일은 대개 MP3·M4A·FLAC 이다. 도구가 WAV 만 받으면 거기서
 * 흐름이 끊기고, 결국 "변환해서 다시 오세요"가 된다. macOS 에 기본으로 있는
 * `afconvert` 로 그 단계를 없앤다 (`ffmpeg` 은 이 기계에 없다).
 *
 * ## 표본율은 절대 바꾸지 않는다
 *
 * 변환은 컨테이너·코덱만 푼다. **리샘플링은 하지 않는다** — 리샘플러의 품질이
 * 비교 결과에 섞여 들어가면 무엇을 재고 있는지 알 수 없게 된다
 * (`quality-compare.mjs` 가 표본율이 다르면 아예 멈추는 것과 같은 이유다).
 *
 * 상용 음원은 보통 44.1kHz 이고 우리 렌더 기본값은 48kHz 다. 맞추는 방향은
 * **우리 쪽을 상대 표본율로 렌더하는 것**이다 — 상대를 건드리지 않는다.
 * `npm run demo -- --rate 44100` 이 그 용도다.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

/** 손대지 않고 그대로 읽는 형식 */
const NATIVE = new Set(['.wav', '.wave']);

/**
 * 어떤 오디오 파일이든 WAV 바이트로 돌려준다.
 * WAV 면 그대로, 아니면 `afconvert` 로 풀어서.
 */
export function readAudioBytes(path) {
  if (NATIVE.has(extname(path).toLowerCase())) return readFileSync(path);

  const dir = mkdtempSync(join(tmpdir(), 'audio-in-'));
  const out = join(dir, `${basename(path, extname(path))}.wav`);
  try {
    // LEI16 = 리틀엔디언 16비트 정수. 표본율·채널은 원본을 따른다
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', path, out], { stdio: 'pipe' });
    return readFileSync(out);
  } catch (error) {
    const hint = process.platform === 'darwin'
      ? '`afconvert` 로 풀지 못했다. 파일이 깨졌거나 DRM 이 걸린 형식일 수 있다'
      : '이 기계에는 `afconvert` 가 없다 (macOS 전용). WAV 로 변환해서 넣어 주세요';
    throw new Error(`${path}: ${hint}\n  ${String(error.message ?? error).split('\n')[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

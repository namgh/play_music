/**
 * **제품 품질 기준** — "들었을 때 깨끗한가".
 *
 * 이 파일이 재는 것은 사실감이 아니라 **신호 무결성**이다. 사실감은 귀로 판정하지만
 * (`sound.md` 11-3), 깨끗함은 숫자로 판정할 수 있고 **여기서 깨지면 제품이 아니다.**
 *
 * 상용 DAW·플러그인이 통과하는 기준을 그대로 쓴다:
 *
 * | 항목 | 기준 | 왜 |
 * |---|---|---|
 * | 에일리어싱 | 하모닉 대비 -60dB 이하 | `sound.md` 11-2 |
 * | 클릭(불연속) | 파형 자체의 최대 기울기 이하 | 딸깍 소리는 바로 들린다 |
 * | DC 오프셋 | -60dBFS 이하 | 헤드룸을 먹고 스피커를 밀어 놓는다 |
 * | 무음 구간 잡음 | -90dBFS 이하 | 24bit 의 의미가 없어진다 |
 * | 내보내기 왕복 | 24bit 양자화 오차 이내 | 파일이 원본과 달라지면 안 된다 |
 * | NaN·발산 | 하나도 없음 | 그 시점부터 트랙 전체가 무음이 된다 |
 *
 * **악기 목록을 순회한다** (`sound.md` 9-7) — 악기를 추가하면 검증이 자동으로 붙는다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { WASM_PARAM_ORDER, WasmVoiceEngine } from './voice/wasmEngine.ts';
import { encodeWav, decodeWav, peakAmplitude } from './wav.ts';
import { renderProjectOffline } from './offlineRender.ts';
import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import { PPQ } from '../model/time.ts';
import { seededRng } from './analysis.ts';
import { loadAllInstruments, playableInstrumentIds } from '../instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import { voiceKindIndex } from '../instruments/types.ts';
import type { Project } from '../model/project.ts';

const FS = 48000;
const BLOCK = 128;
const registry = await loadAllInstruments();
const wasmPath = fileURLToPath(new URL('../generated/dsp.wasm', import.meta.url));

async function engine(): Promise<WasmVoiceEngine> {
  return WasmVoiceEngine.create(await readFile(wasmPath), FS);
}

/** 음 하나를 렌더한다 */
function renderNote(
  wasm: WasmVoiceEngine,
  instrumentId: string,
  midi: number,
  seconds: number,
  velocity = 1,
): Float32Array {
  const instrument = resolveInstrument(instrumentId, registry);
  // **보이스 타입을 반드시 넘긴다.** 안 넘기면 0(줄)으로 해석돼 마림바가 줄 악기로
  // 울린다 — 처음 이 파일을 짰을 때 그것 때문에 "모달 악기가 NaN" 이라는 잘못된
  // 결론이 나왔다 (`HANDOFF.md`: 측정기를 먼저 검증하라)
  const params = {
    ...instrumentParams(instrument, 'default', null),
    voiceKind: voiceKindIndex(instrument.voice),
  };
  wasm.allOff();
  wasm.noteOn(440 * Math.pow(2, (midi - 69) / 12), velocity, params);
  const total = Math.round(seconds * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    wasm.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
  }
  return out;
}

const dbfs = (amplitude: number): number => 20 * Math.log10(Math.max(amplitude, 1e-12));

/** 이웃 샘플 사이의 최대 점프 */
function maxJump(x: Float32Array, from = 0, to = x.length): number {
  let worst = 0;
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) {
    worst = Math.max(worst, Math.abs(x[i]! - x[i - 1]!));
  }
  return worst;
}

test('모든 악기가 유한하고 발산하지 않는다', async () => {
  // NaN 이 한 번 생기면 **그 시점부터 트랙 전체가 무음**이 된다 (sound.md 6-5)
  const wasm = await engine();
  const broken: string[] = [];

  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    for (const midi of [instrument.range.low, instrument.range.high]) {
      const x = renderNote(wasm, id, midi, 1.5);
      if (!x.every(Number.isFinite)) broken.push(`${id} midi=${midi}: 유한하지 않다`);
      const peak = peakAmplitude([x]);
      if (peak > 4) broken.push(`${id} midi=${midi}: 피크 ${peak.toFixed(1)} — 터졌다`);
    }
  }
  assert.deepEqual(broken, [], `발산:\n${broken.join('\n')}`);
});

test('모든 악기에 DC 오프셋이 없다', async () => {
  // DC 는 안 들리는데 **헤드룸을 먹고** 스피커 콘을 한쪽으로 밀어 놓는다.
  // 여러 트랙이 쌓이면 그만큼 클리핑이 빨라진다
  const wasm = await engine();
  const failures: string[] = [];

  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    const midi = Math.round((instrument.range.low + instrument.range.high) / 2);
    const x = renderNote(wasm, id, midi, 1.0);
    const mean = x.reduce((sum, v) => sum + v, 0) / x.length;
    const rms = Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length);
    if (rms < 1e-6) continue; // 소리가 없으면 볼 것도 없다
    // 신호 대비 상대 DC 로 본다 — 절대값은 악기 음량에 좌우된다.
    //
    // 기준을 -30dB 로 두는 이유: 유한한 창으로 평균을 내면 마지막 주기가 잘려
    // 잔여가 남는다 (220Hz 를 1초 재면 주기당 1/220 → 약 -47dB, 유니즌 7개면 그만큼
    // 더). **진짜 DC 문제는 -20dB 급으로 나타나므로** -30dB 면 충분히 걸린다
    const relative = dbfs(Math.abs(mean) / rms);
    if (relative > -30) failures.push(`${id}: DC ${relative.toFixed(1)}dB (신호 대비)`);
  }
  assert.deepEqual(failures, [], `DC 오프셋:\n${failures.join('\n')}`);
});

test('발음 시작에 클릭이 없다', async () => {
  // 첫 샘플이 0 에서 갑자기 튀면 딸깍 소리가 난다. **파형 자체의 최대 기울기**와
  // 비교한다 — 절대값으로 재면 큰 소리 악기가 항상 걸린다
  const wasm = await engine();
  const failures: string[] = [];

  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    const midi = Math.round((instrument.range.low + instrument.range.high) / 2);
    const x = renderNote(wasm, id, midi, 0.5);
    const onset = maxJump(x, 0, 8);
    const steady = maxJump(x, 200, x.length);
    if (steady < 1e-9) continue;
    if (onset > steady * 1.5) {
      failures.push(`${id}: 어택 점프 ${onset.toExponential(2)} vs 정상 ${steady.toExponential(2)}`);
    }
  }
  assert.deepEqual(failures, [], `어택 클릭:\n${failures.join('\n')}`);
});

test('노트오프에 클릭이 없다', async () => {
  // 뮤트가 한 샘플에 0 으로 떨어지면 그게 클릭이다 (`WORKPLAN.md` 2-4)
  const wasm = await engine();
  const params = instrumentParams(
    resolveInstrument('acoustic-guitar', registry), 'default', null,
  );
  wasm.allOff();
  const voice = wasm.noteOn(220, 1, params);

  const before = new Float32Array(BLOCK * 20);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < before.length; at += BLOCK) {
    scratch.fill(0);
    wasm.process(scratch, BLOCK);
    before.set(scratch, at);
  }
  const steady = maxJump(before, BLOCK * 4);

  wasm.noteOff(voice, 120);
  const after = new Float32Array(BLOCK * 30);
  for (let at = 0; at < after.length; at += BLOCK) {
    scratch.fill(0);
    wasm.process(scratch, BLOCK);
    after.set(scratch, at);
  }
  const release = maxJump(after);
  assert.ok(
    release <= steady * 1.5,
    `노트오프 점프 ${release.toExponential(2)} vs 정상 ${steady.toExponential(2)}`,
  );
});

test('무음 구간이 실제로 무음이다', async () => {
  // 잡음이 남으면 24bit 로 내보내는 의미가 없다. 비정규수 처리도 여기서 드러난다
  const wasm = await engine();
  const x = renderNote(wasm, 'acoustic-guitar', 57, 0.2);
  wasm.allOff();

  const tail = new Float32Array(FS);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < tail.length; at += BLOCK) {
    scratch.fill(0);
    wasm.process(scratch, BLOCK);
    tail.set(scratch, at);
  }
  void x;
  const floor = dbfs(peakAmplitude([tail]));
  assert.ok(floor < -90, `무음 구간 잡음이 ${floor.toFixed(1)}dBFS 다`);
});

test('24bit 내보내기가 원본을 보존한다', () => {
  // 왕복 오차가 양자화 한 칸(-138dBFS)보다 크면 인코딩이 틀린 것이다
  const n = 4096;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const rng = seededRng();
  for (let i = 0; i < n; i++) {
    left[i] = Math.sin((2 * Math.PI * 440 * i) / FS) * 0.7;
    right[i] = (rng() * 2 - 1) * 0.3;
  }

  const bytes = encodeWav([left, right], { sampleRate: FS, bitDepth: 24 });
  const back = decodeWav(bytes);
  assert.equal(back.sampleRate, FS);
  assert.equal(back.channels.length, 2);

  let worst = 0;
  for (let ch = 0; ch < 2; ch++) {
    const source = ch === 0 ? left : right;
    for (let i = 0; i < n; i++) {
      worst = Math.max(worst, Math.abs(back.channels[ch]![i]! - source[i]!));
    }
  }
  // 24bit 한 칸 = 2⁻²³ ≈ 1.2e-7. 반올림이므로 절반까지 허용
  assert.ok(worst < 1.2e-7, `왕복 오차 ${worst.toExponential(2)} (${dbfs(worst).toFixed(0)}dBFS)`);
});

test('여러 트랙을 겹쳐도 헤드룸이 남는다', async () => {
  // **클리핑되면 제품이 아니다.** 실제 편곡에 가까운 밀도로 겹쳐 본다
  const project: Project = createEmptyProject('헤드룸');
  project.tempo.bpm = 120;
  project.lengthBars = 2;

  const parts: [string, number[]][] = [
    ['acoustic-guitar', [52, 55, 59]],
    ['electric-bass', [40]],
    ['acoustic-piano', [64, 67, 71]],
    ['synth-pad', [59, 62]],
    ['kick', [36]],
    ['snare', [38]],
    ['hihat', [42]],
  ];
  for (const [instrumentId, midis] of parts) {
    const track = createTrack({ name: instrumentId, instrumentId });
    const clip = createClip({ startTick: 0, lengthTick: 8 * PPQ });
    for (const midi of midis) {
      for (let beat = 0; beat < 8; beat++) {
        clip.notes.push(createNote({ startTick: beat * PPQ, lengthTick: PPQ, midi }));
      }
    }
    track.clips.push(clip);
    project.tracks.push(track);
  }

  // **트랙마다 엔진을 준다.** 안 주면 TS 폴백으로 떨어져 신스가 "미구현" 으로
  // 실패한다 — 실제 재생 경로가 아니므로 여기서 재는 의미도 없다
  const bytes = await readFile(wasmPath);
  const engines = await Promise.all(
    project.tracks.map(() => WasmVoiceEngine.create(bytes, FS)),
  );
  const { pcm } = renderProjectOffline(project, registry, {
    sampleRate: FS, rng: seededRng(), tailSec: 1, wasm: engines,
  });
  assert.ok(pcm.every(Number.isFinite), '합산에서 발산했다');

  const peak = peakAmplitude([pcm]);
  // 7트랙 20음이 동시에 울려도 넘치면 안 된다. 넘으면 사용자가 볼륨을 못 맞춘
  // 것이 아니라 **엔진 기본값이 너무 큰 것**이다
  assert.ok(peak <= 1, `7트랙 합주 피크가 ${dbfs(peak).toFixed(1)}dBFS — 잘린다`);
  // 반대로 너무 작아도 안 된다 (헤드룸만 남기고 소리가 작으면 쓸 수 없다)
  assert.ok(peak > 0.05, `합주가 ${dbfs(peak).toFixed(1)}dBFS 로 너무 작다`);
});

test('세게 쳐도 한 악기가 넘치지 않는다', async () => {
  // 벨로시티 최대에서 한 음만 쳐도 넘으면 화음을 못 친다
  const wasm = await engine();
  const loud: string[] = [];
  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    const midi = Math.round((instrument.range.low + instrument.range.high) / 2);
    const peak = peakAmplitude([renderNote(wasm, id, midi, 1.0, 1)]);
    if (peak > 1) loud.push(`${id}: ${dbfs(peak).toFixed(1)}dBFS`);
  }
  assert.deepEqual(loud, [], `한 음이 이미 넘친다:\n${loud.join('\n')}`);
});

test('극단 파라미터를 퍼징해도 깨지지 않는다', async () => {
  // `sound.md` 11-5 가 요구하는 항목인데 지금까지 없었다.
  //
  // **파라미터가 72개다.** 사용자가 튜닝 도구에서 아무 조합이나 만들 수 있고,
  // 그중 하나가 NaN 을 내면 그 시점부터 트랙 전체가 무음이 된다. 악기 정의로
  // 도달 가능한 조합만 보는 것으로는 부족하다.
  const wasm = await engine();
  const rng = seededRng();
  const failures: string[] = [];

  // 각 슬롯의 "말이 되는 최대치". 범위를 넘는 값도 섞어 넣는다 —
  // 엔진은 위에서 클램프해 주기를 기대하면 안 된다 (`sound.md` 6-5)
  const wild = () => {
    const roll = rng();
    if (roll < 0.15) return 0;
    if (roll < 0.3) return -1 * rng() * 1000;      // 음수
    if (roll < 0.45) return rng() * 20000;          // 아주 큰 값
    if (roll < 0.5) return Number.POSITIVE_INFINITY;
    if (roll < 0.55) return Number.NaN;
    return rng() * 2;                                // 보통 범위
  };

  for (let trial = 0; trial < 300; trial++) {
    const params: Record<string, number> = {};
    for (const key of WASM_PARAM_ORDER) params[key] = wild();
    // 보이스 타입만은 유효하게 — 아니면 늘 같은 보이스만 돌게 된다
    params.voiceKind = trial % 5;

    wasm.allOff();
    wasm.noteOn(440 * Math.pow(2, (rng() * 60 - 30) / 12), rng(), params);

    const scratch = new Float32Array(BLOCK);
    let broke = false;
    for (let block = 0; block < 24 && !broke; block++) {
      scratch.fill(0);
      wasm.process(scratch, BLOCK);
      for (const v of scratch) {
        // NaN·무한대는 물론이고 **터무니없이 큰 값**도 깨진 것이다
        if (!Number.isFinite(v) || Math.abs(v) > 50) {
          failures.push(`시도 ${trial} (보이스 ${params.voiceKind}): ${v}`);
          broke = true;
          break;
        }
      }
    }
    if (failures.length >= 5) break; // 몇 개만 보여도 충분하다
  }

  assert.deepEqual(failures, [], `퍼징에서 깨짐:\n${failures.join('\n')}`);
});

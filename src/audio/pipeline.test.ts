/**
 * 종단 테스트: **프로젝트 데이터 → 스케줄러 → 보이스 → PCM**.
 *
 * 이게 이 프로젝트에서 가장 중요한 테스트다. 모델과 엔진이 각각 정확해도
 * 이어붙이는 지점에서 음정이 틀어지면 "음정이 정밀하다"는 주장은 무너진다.
 * 데이터에 찍은 센트가 실제 파형에서 그대로 나오는지 본다 (`sound.md` 11-1).
 *
 * 측정 방식이 두 가지다:
 *  - **격리 측정** — 음 하나만 울리는 렌더. 악기·음역을 훑을 때 쓴다 (빠르고 단순)
 *  - **문맥 측정** — 음을 늘어놓은 채로, 같이 울리는 주파수를 모델에 넣고 함께 푼다
 *    (`analysis.ts` 의 `measureFreqInContext`). 실제 곡에 가까운 조건이다
 *
 * 처음에는 격리 측정밖에 없었고, 음을 늘어놓으면 앞 음이 몇 초씩 남아
 * -14센트 지정에서 -8.6센트로 실패했다. 지금은 문맥 측정으로 그 조건에서도 잡는다.
 * 되는 이유: 무슨 음이 울리는지 **프로젝트 데이터에서 정확히 알기** 때문이다.
 * 모르는 상태의 음정 검출은 오디오 도메인 문제이고 `plan.md` 가 Phase 4 로 미뤄 뒀다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import { detune, pitchToHz } from '../model/pitch.ts';
import { PPQ, ticksToSeconds } from '../model/time.ts';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createRegistry, playableInstrumentIds } from '../instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import { DEFAULT_RELEASE_MS, noteOffFields, WasmVoiceEngine } from './voice/wasmEngine.ts';
import { measureCentsError, measureCentsErrorInContext, seededRng } from './analysis.ts';
import { renderProjectOffline, slice } from './offlineRender.ts';
import type { Project } from '../model/project.ts';
import type { ParamValue } from '../instruments/types.ts';

const SAMPLE_RATE = 48000;
const TOLERANCE_CENTS = 1;
const registry = createRegistry();
const wasmPath = fileURLToPath(new URL('../generated/dsp.wasm', import.meta.url));

/** Float32Array 는 스프레드하면 스택이 터진다 (수십만 인자) */
function peakAbs(pcm: Float32Array): number {
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  return peak;
}

function projectWithNotes(
  instrumentId: string,
  notes: { midi: number; cents?: number; startBeat?: number }[],
  opts: { bpm?: number; toneParams?: Record<string, ParamValue> } = {},
): Project {
  const project = createEmptyProject('종단 테스트');
  project.tempo.bpm = opts.bpm ?? 60; // 4분음표 = 1초
  project.lengthBars = Math.max(1, Math.ceil(notes.length / 4));

  const track = createTrack({ name: '테스트', instrumentId });
  if (opts.toneParams) track.toneParams = opts.toneParams;
  const clip = createClip({ startTick: 0, lengthTick: Math.max(1, notes.length) * PPQ });
  notes.forEach((n, i) => {
    const note = createNote({
      startTick: (n.startBeat ?? i) * PPQ,
      lengthTick: PPQ,
      midi: n.midi,
    });
    if (n.cents) note.pitch = detune(note.pitch, n.cents);
    clip.notes.push(note);
  });
  track.clips.push(clip);
  project.tracks.push(track);
  return project;
}

/**
 * 음 하나만 울리는 렌더에서 센트 오차를 잰다.
 *
 * `wasm` 을 주면 실제 엔진으로, 안 주면 TS 대체 경로로 잰다.
 * TS 경로는 웨이브가이드만 구현하므로 신스·모달을 재려면 wasm 이 필요하다.
 */
function centsErrorOf(
  instrumentId: string,
  midi: number,
  cents = 0,
  wasm: WasmVoiceEngine | null = null,
): number {
  const project = projectWithNotes(instrumentId, [{ midi, cents }]);
  // 앰프는 끈다 — ±1센트 주장은 합성 엔진에 대한 것이고, 왜곡은 상호변조로
  // 측정값을 당긴다 (wasmString.test.ts 가 그 크기를 따로 묶는다)
  //
  // **유니즌도 끈다.** 유니즌은 여러 오실레이터를 대칭으로 벌리는 것이고, 그러면
  // 설계상 **단일 기본음이 존재하지 않는다** — 수퍼소우가 그 자체로 그런 소리다.
  // 단일 기본음을 재는 이 측정으로는 "의도한 퍼짐"과 "엔진의 오차"를 구분할 수 없다
  // (`HANDOFF.md` 의 "측정 구간이 틀렸다" 사례와 같은 종류다).
  //
  // 대신 **두 갈래로 나눠 전부 검증한다:**
  //  - 오실레이터 자체의 음정 — 여기서 유니즌을 끄고 잰다
  //  - 벌리는 배치의 대칭성 — `synth.rs` 의 `unison_detune_offsets` 단위 테스트가
  //    오프셋 합이 정확히 0 인지 본다 (한쪽으로 쏠리면 평균이 밀린다)
  // 어느 쪽도 검증에서 빠지지 않는다
  project.tracks[0]!.toneParams = { ampEnabled: 0, synthUnison: 1 };
  const { pcm } = renderProjectOffline(project, registry, {
    sampleRate: SAMPLE_RATE,
    rng: seededRng(),
    tailSec: 1,
    wasm,
  });
  const note = project.tracks[0]!.clips[0]!.notes[0]!;
  const targetHz = pitchToHz(note.pitch, project.tuning);
  // 노트 길이 + 여운까지 본다. 측정기가 살아 있는 구간을 스스로 찾는다
  const segment = slice(pcm, 0, ticksToSeconds(note.lengthTick, project.tempo) + 1, SAMPLE_RATE);
  return measureCentsError(segment, targetHz, SAMPLE_RATE);
}

test('데이터에 찍은 음정이 파형에 그대로 나온다', () => {
  for (const midi of [40, 47, 52, 57, 62, 67, 76, 88]) {
    const err = centsErrorOf('acoustic-guitar', midi);
    assert.ok(Math.abs(err) <= TOLERANCE_CENTS, `midi=${midi} 오차 ${err.toFixed(3)} 센트`);
  }
});

test('센트 미세조정이 파형에 정확히 반영된다', () => {
  // 차별점 ①(음 단위 정밀 수정)이 소리까지 도달하는지.
  // 데이터에 -14센트를 넣었으면 파형도 -14센트여야 한다
  for (const cents of [-49, -37, -14, -1, 0, 1, 14, 37, 49]) {
    const err = centsErrorOf('acoustic-guitar', 57, cents);
    assert.ok(Math.abs(err) <= TOLERANCE_CENTS, `${cents}센트 지정 → 오차 ${err.toFixed(3)} 센트`);
  }
});

test('모든 내장 악기가 자기 음역에서 음정이 맞는다', async () => {
  // sound.md 9-7: 정의를 추가하면 검증이 자동으로 적용돼야 한다.
  // 악기 목록을 순회하므로 새 악기를 넣어도 테스트를 새로 쓸 필요가 없다.
  //
  // **실제 엔진(wasm)으로 잰다.** TS 대체 경로는 웨이브가이드만 구현하므로
  // 신스·모달 악기를 재려면 wasm 이 필요하고, 그게 실제로 쓰이는 경로이기도 하다
  const wasm = await WasmVoiceEngine.create(await readFile(wasmPath), SAMPLE_RATE);
  const failures: string[] = [];

  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    const { low, high } = instrument.range;

    // 타악기는 **음정 정확도의 대상이 아니다.** 킥·탐은 음정이 시간에 따라
    // 스윕하고(그게 "둥" 소리의 정체다), 스네어·하이햇·클랩은 설계상 음을 무시한다
    // (하이햇을 반음 올려 봐야 하이햇이다 — Rust 테스트가 그 성질을 검증한다).
    // 여기서 재면 스윕 중인 값을 "오차"로 읽게 된다
    if (instrument.voice === 'percussion') continue;

    // 모달(벨·마림바)은 **모드가 촘촘한 비정수 배치**라 기본음만 따로 재기 어렵다.
    // 예를 들어 차임벨의 1.19배 모드는 기본음에서 300센트 거리인데, 8주기 창의
    // 분해능이 그보다 넓어 측정값을 끌어당긴다. 모드 배치 자체가 정확한지는
    // Rust 단위 테스트(`modal.rs`)가 직접 검증하므로, 여기서는 큰 이탈만 잡는다
    const tolerance = instrument.voice === 'modal' ? 5 : TOLERANCE_CENTS;

    for (const midi of [low, Math.round((low + high) / 2), high]) {
      const err = centsErrorOf(id, midi, 0, wasm);
      if (Math.abs(err) > tolerance) {
        failures.push(
          `${id} (${instrument.voice}) midi=${midi}: ${err.toFixed(3)} 센트 (허용 ±${tolerance})`,
        );
      }
    }
  }

  assert.deepEqual(failures, [], `음정 오차 초과:\n${failures.join('\n')}`);
});

test('음을 늘어놓은 상태에서도 각 음의 센트가 정확하다', () => {
  // 처음 이 테스트를 격리 없이 짰다가 -8.6센트로 실패했던 바로 그 조건.
  // 앞뒤가 같은 음 ±센트라 간섭이 최악이다 (목표에서 1~2Hz 거리)
  const offsets = [0, -14, 12, -37, 25];
  const project = projectWithNotes('acoustic-guitar', offsets.map((c) => ({ midi: 57, cents: c })));
  const { pcm } = renderProjectOffline(project, registry, {
    sampleRate: SAMPLE_RATE,
    rng: seededRng(),
    tailSec: 2,
  });

  const notes = project.tracks[0]!.clips[0]!.notes;
  const allHz = notes.map((n) => pitchToHz(n.pitch, project.tuning));

  notes.forEach((note, i) => {
    const onsetSec = ticksToSeconds(note.startTick, project.tempo);
    // 이 음이 시작될 때 아직 울리고 있는 음들이 간섭원이다
    const interferersHz = allHz.filter((_, j) => j < i);
    const err = measureCentsErrorInContext(pcm, allHz[i]!, SAMPLE_RATE, {
      interferersHz,
      start: Math.round(onsetSec * SAMPLE_RATE) + Math.round(0.02 * SAMPLE_RATE),
      available: Math.round(0.95 * SAMPLE_RATE),
    });
    assert.ok(
      Math.abs(err) <= TOLERANCE_CENTS,
      `${i}번째 음(${offsets[i]}센트, 간섭 ${interferersHz.length}개) 오차 ${err.toFixed(3)} 센트`,
    );
  });
});

test('화음 안에서도 각 음의 음정이 정확하다', () => {
  // 동시 발음. 서로의 하모닉이 겹치는 최악 조건 중 하나
  const midis = [52, 56, 59, 64];
  const project = projectWithNotes(
    'acoustic-guitar',
    midis.map((midi) => ({ midi, startBeat: 0 })),
  );
  const { pcm } = renderProjectOffline(project, registry, {
    sampleRate: SAMPLE_RATE,
    rng: seededRng(),
    tailSec: 2,
  });

  const notes = project.tracks[0]!.clips[0]!.notes;
  const allHz = notes.map((n) => pitchToHz(n.pitch, project.tuning));

  allHz.forEach((hz, i) => {
    const err = measureCentsErrorInContext(pcm, hz, SAMPLE_RATE, {
      interferersHz: allHz.filter((_, j) => j !== i),
      start: Math.round(0.03 * SAMPLE_RATE),
      available: Math.round(1.2 * SAMPLE_RATE),
    });
    assert.ok(Math.abs(err) <= TOLERANCE_CENTS, `midi=${midis[i]} 오차 ${err.toFixed(3)} 센트`);
  });
});

test('화음이 단음보다 크다 (보이스가 독립적으로 합산된다)', () => {
  // 위 테스트가 음정을 보므로 여기서는 합산 자체만 본다 —
  // 보이스가 서로를 덮어쓰지 않고 더해지는지
  const chord = projectWithNotes('acoustic-guitar', [
    { midi: 52, startBeat: 0 }, { midi: 56, startBeat: 0 }, { midi: 59, startBeat: 0 },
  ]);
  const single = projectWithNotes('acoustic-guitar', [{ midi: 52 }]);

  const c = renderProjectOffline(chord, registry, { sampleRate: SAMPLE_RATE, rng: seededRng() });
  const s = renderProjectOffline(single, registry, { sampleRate: SAMPLE_RATE, rng: seededRng() });

  assert.ok(peakAbs(c.pcm) > peakAbs(s.pcm), '음 3개가 1개보다 커야 한다');
  assert.ok(c.pcm.every(Number.isFinite));
});

test('음소거된 트랙은 파형에 없다', () => {
  const project = projectWithNotes('acoustic-guitar', [{ midi: 57 }]);
  const loud = renderProjectOffline(project, registry, { sampleRate: SAMPLE_RATE, rng: seededRng() });
  assert.ok(peakAbs(loud.pcm) > 0.01, '소리가 나야 한다');

  project.tracks[0]!.mute = true;
  const muted = renderProjectOffline(project, registry, { sampleRate: SAMPLE_RATE, rng: seededRng() });
  assert.equal(peakAbs(muted.pcm), 0, '음소거하면 완전 무음이어야 한다');
});

test('DC 오프셋이 남지 않는다', () => {
  // M0 에서 전체 RMS 의 60%가 DC 였던 버그. 음으로는 안 들려서 숨는다
  const project = projectWithNotes('electric-bass', [{ midi: 28 }, { midi: 40 }, { midi: 55 }]);
  const { pcm } = renderProjectOffline(project, registry, { sampleRate: SAMPLE_RATE, rng: seededRng() });

  let sum = 0;
  let sq = 0;
  for (const v of pcm) { sum += v; sq += v * v; }
  const dc = Math.abs(sum / pcm.length);
  const rms = Math.sqrt(sq / pcm.length);
  assert.ok(dc < rms * 0.02, `DC ${dc.toExponential(2)} 가 RMS ${rms.toExponential(2)} 의 2% 를 넘는다`);
});

test('극단 파라미터에서 NaN·발산이 없다', () => {
  // sound.md 6-5: NaN 하나가 그 시점부터 전체를 무음으로 만든다
  const project = projectWithNotes(
    'mandolin',
    [{ midi: 55 }, { midi: 91 }],
    { toneParams: { stiffness: 0.05, damping: 0.25, sustainSec: 10, pluckHardness: 1 } },
  );
  const { pcm } = renderProjectOffline(project, registry, { sampleRate: SAMPLE_RATE, rng: seededRng() });
  assert.ok(pcm.every(Number.isFinite), '유한값이 아닌 샘플이 있다');
  assert.ok(peakAbs(pcm) < 4, '값이 비정상적으로 크다 (발산 의심)');
});

test('모든 내장 악기가 소리를 낸다 (보이스 타입 4종)', async () => {
  // sound.md 9-1: 악기 추가는 정의 파일 하나. 새 보이스 타입을 붙여도
  // 상위 레이어(스케줄러·믹서·UI)는 손대지 않는다 — 그게 실제로 되는지 본다
  const wasm = await WasmVoiceEngine.create(await readFile(wasmPath), SAMPLE_RATE);
  const silent: string[] = [];

  for (const id of playableInstrumentIds()) {
    const instrument = resolveInstrument(id, registry);
    const midi = Math.round((instrument.range.low + instrument.range.high) / 2);
    const project = projectWithNotes(id, [{ midi }]);
    const { pcm } = renderProjectOffline(project, registry, {
      sampleRate: SAMPLE_RATE,
      rng: seededRng(),
      tailSec: 1,
      wasm,
    });
    if (peakAbs(pcm) < 1e-4) silent.push(`${id} (${instrument.voice})`);
    assert.ok(pcm.every(Number.isFinite), `${id}: 유한하지 않은 샘플`);
  }

  assert.deepEqual(silent, [], `소리가 안 나는 악기:\n${silent.join('\n')}`);
});

test('TS 대체 경로는 미구현 보이스를 조용히 무음으로 두지 않는다', () => {
  // wasm 이 없을 때의 경로. 조용히 무음이면 "왜 소리가 안 나지"로 시간을 버린다
  const project = projectWithNotes('acoustic-guitar', [{ midi: 57 }]);
  const broken = createRegistry([
    { id: 'drum-kit', schemaVersion: 1, name: '드럼', voice: 'sampler', category: '드럼' },
  ]);
  project.tracks[0]!.instrumentId = 'drum-kit';
  assert.throws(
    () => renderProjectOffline(project, broken, { sampleRate: SAMPLE_RATE, rng: seededRng() }),
    /미구현/,
  );
});

test('트랙마다 앰프 설정이 분리된다', async () => {
  // **실제 버그였다.** 엔진 인스턴스 하나에 앰프 체인이 하나뿐이라 여러 트랙이
  // 공유하면 설정이 섞였다 — 퍼즈 트랙과 클린 트랙을 동시에 울리면 나중에
  // 발음한 쪽 설정이 둘 다에 걸렸다 (측정 오차 101%).
  //
  // 실제 재생·내보내기는 트랙마다 워크렛 노드를 따로 두므로 안전했지만,
  // **검증 경로가 그 구조를 따르지 않아 이 버그를 못 보고 있었다.**
  const bytes = await readFile(wasmPath);
  const engines = async (count: number) =>
    Promise.all(Array.from({ length: count }, () => WasmVoiceEngine.create(bytes, SAMPLE_RATE)));

  const guitar = (tone: string, midi: number) => {
    const project = projectWithNotes('electric-guitar', [{ midi, startBeat: 0 }]);
    project.tracks[0]!.toneId = tone;
    return project;
  };

  // **따로 렌더할 때와 같은 노트를 써야 한다.** 타건 변주가 노트 id 에 걸려 있어
  // (`ROADMAP.md` S2-4) 음을 새로 만들면 세기가 미세하게 달라지고, 그러면
  // "따로 렌더한 합"과 "동시 렌더"가 애초에 다른 것을 비교하게 된다
  const fuzzProject = guitar('퍼즈', 52);
  const cleanProject = guitar('클린', 64);
  const both: Project = {
    ...fuzzProject,
    tracks: [fuzzProject.tracks[0]!, cleanProject.tracks[0]!],
  };

  const render = async (project: Project) =>
    renderProjectOffline(project, registry, {
      sampleRate: SAMPLE_RATE,
      rng: seededRng(),
      tailSec: 1,
      wasm: await engines(project.tracks.length),
    }).pcm;

  const fuzz = await render(fuzzProject);
  const clean = await render(cleanProject);
  const together = await render(both);

  // 따로 렌더해 합친 것과 동시 렌더가 같아야 한다
  let diff = 0;
  let reference = 0;
  for (let i = 0; i < together.length; i++) {
    const ideal = (fuzz[i] ?? 0) + (clean[i] ?? 0);
    diff += (together[i]! - ideal) ** 2;
    reference += ideal ** 2;
  }
  const error = Math.sqrt(diff / reference);
  assert.ok(error < 0.001, `트랙이 섞인다: 상대 오차 ${(error * 100).toFixed(2)}%`);
});

test('엔진이 트랙 수보다 적으면 조용히 섞지 않고 실패한다', async () => {
  const bytes = await readFile(wasmPath);
  const one = await WasmVoiceEngine.create(bytes, SAMPLE_RATE);

  const project = projectWithNotes('electric-guitar', [{ midi: 52, startBeat: 0 }]);
  const second = projectWithNotes('electric-guitar', [{ midi: 64, startBeat: 0 }]);
  project.tracks.push(second.tracks[0]!);

  assert.throws(
    () => renderProjectOffline(project, registry, { sampleRate: SAMPLE_RATE, wasm: one }),
    /트랙마다 하나씩/,
  );
});

test('같은 프로젝트는 같은 파형을 낸다 (결정론)', () => {
  // 내보내기와 미리듣기가 100% 일치해야 한다는 요구(plan.md 5-2)의 최소 조건
  const project = projectWithNotes('harp', [{ midi: 60 }, { midi: 64 }, { midi: 67 }]);
  const a = renderProjectOffline(project, registry, { sampleRate: SAMPLE_RATE, rng: seededRng(7) });
  const b = renderProjectOffline(project, registry, { sampleRate: SAMPLE_RATE, rng: seededRng(7) });
  assert.equal(a.pcm.length, b.pcm.length);
  for (let i = 0; i < a.pcm.length; i++) {
    if (a.pcm[i] !== b.pcm[i]) assert.fail(`샘플 ${i} 가 다르다: ${a.pcm[i]} ≠ ${b.pcm[i]}`);
  }
});

// ---------------------------------------------------------------------------
// 노트오프 배선 (`WORKPLAN.md` 2-1·2-2)
//
// 이 함수가 재생과 내보내기 양쪽에서 쓰인다. 갈라지면 "들은 것과 파일이 다르다"가
// 되므로 순수 함수로 뽑아 두고 여기서 잰다.
// ---------------------------------------------------------------------------

test('노트 길이가 프레임으로 넘어간다', () => {
  const { durationFrames, releaseMs } = noteOffFields({ releaseMs: 90 }, 0.5, 48000);
  assert.equal(durationFrames, 24000, '0.5초 = 24000프레임이어야 한다');
  assert.equal(releaseMs, 90);
});

test('letRing 이면 노트오프를 예약하지 않는다', () => {
  // 0 은 워크렛에서 "노트오프 없음" 이다 — 하프·차임벨처럼 떼도 울리는 악기
  const ring = noteOffFields({ letRing: 1, releaseMs: 120 }, 0.5, 48000);
  assert.equal(ring.durationFrames, 0);

  const damped = noteOffFields({ letRing: 0, releaseMs: 120 }, 0.5, 48000);
  assert.ok(damped.durationFrames > 0);
});

test('아주 짧은 음도 최소 1프레임을 받는다', () => {
  // 0 으로 내려가면 "노트오프 없음"으로 해석돼 **영원히 울린다**
  const { durationFrames } = noteOffFields({}, 1e-9, 48000);
  assert.equal(durationFrames, 1);
});

test('releaseMs 가 없거나 이상하면 기본값으로 떨어진다', () => {
  assert.equal(noteOffFields({}, 1, 48000).releaseMs, DEFAULT_RELEASE_MS);
  assert.equal(noteOffFields({ releaseMs: -5 }, 1, 48000).releaseMs, DEFAULT_RELEASE_MS);
  assert.equal(noteOffFields({ releaseMs: '느리게' }, 1, 48000).releaseMs, DEFAULT_RELEASE_MS);
});

test('악기 정의의 letRing 기본값이 보이스 타입과 맞는다', () => {
  // 신스가 letRing 이면 ADSR 이 Sustain 에서 멈춰 **음이 안 꺼진다**.
  // 드럼이 letRing 이 아니면 짧게 찍은 킥이 잘린다.
  const expected: Record<string, number> = {
    'acoustic-guitar': 0,
    'electric-guitar': 0,
    harp: 1,
    'synth-lead': 0,
    'synth-pad': 0,
    marimba: 1,
    'tubular-bell': 1,
    kick: 1,
    snare: 1,
  };
  for (const [id, letRing] of Object.entries(expected)) {
    const params = instrumentParams(resolveInstrument(id, registry), 'default', null);
    assert.equal(Number(params.letRing ?? 0), letRing, `${id} 의 letRing`);
  }
});

// --- 타건 변주 (ROADMAP.md S2-4) -------------------------------------------

test('같은 음을 반복해도 파형이 조금씩 다르다', async () => {
  // 완전히 똑같으면 하이햇 16분이 머신건이 된다
  const project = createEmptyProject('변주');
  project.tempo.bpm = 120;
  project.lengthBars = 1;
  const track = createTrack({ name: '하이햇', instrumentId: 'hihat' });
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ });
  for (let i = 0; i < 4; i++) {
    clip.notes.push(createNote({ startTick: i * PPQ, lengthTick: PPQ / 4, midi: 60 }));
  }
  track.clips.push(clip);
  project.tracks.push(track);

  const wasm = await WasmVoiceEngine.create(await readFile(wasmPath), 48000);
  const { pcm } = renderProjectOffline(project, createRegistry(), {
    sampleRate: 48000, rng: seededRng(), tailSec: 0.5, wasm,
  });

  // 각 타격의 앞부분을 잘라 서로 비교한다
  const beat = Math.round((60 / 120) * 48000);
  const hit = (i: number) => pcm.slice(i * beat, i * beat + 2000);
  const peak = (x: Float32Array) => Math.max(...[...x].map(Math.abs));
  const peaks = [0, 1, 2, 3].map((i) => peak(hit(i)));

  const spread = (Math.max(...peaks) - Math.min(...peaks)) / Math.max(...peaks);
  assert.ok(spread > 0.01, `네 타격의 세기가 사실상 같다 (편차 ${(spread * 100).toFixed(1)}%)`);
  assert.ok(spread < 0.5, `변주가 너무 크다 (편차 ${(spread * 100).toFixed(1)}%)`);
});

test('변주가 결정론적이다 — 두 번 렌더하면 같다', async () => {
  // **미리듣기 = 내보내기 = 공유본** (plan.md 5-2). 자유 난수를 쓰면 이게 깨진다
  const project = createEmptyProject('결정론');
  project.tempo.bpm = 120;
  project.lengthBars = 1;
  const track = createTrack({ name: '기타', instrumentId: 'acoustic-guitar' });
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ });
  clip.notes.push(createNote({ startTick: 0, lengthTick: PPQ, midi: 57 }));
  clip.notes.push(createNote({ startTick: PPQ, lengthTick: PPQ, midi: 57 }));
  track.clips.push(clip);
  project.tracks.push(track);

  const render = async () => {
    const wasm = await WasmVoiceEngine.create(await readFile(wasmPath), 48000);
    return renderProjectOffline(project, createRegistry(), {
      sampleRate: 48000, rng: seededRng(), tailSec: 0.5, wasm,
    }).pcm;
  };
  const a = await render();
  const b = await render();
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert.fail(`샘플 ${i} 가 다르다 — 변주가 재현되지 않는다`);
  }
});

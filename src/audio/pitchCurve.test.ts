/**
 * 음정 곡선이 **실제로 파형에 나타나는지** 검증한다.
 *
 * 원래 문제가 정확히 이것이었다: `pitchCurve` 가 스키마·편집 함수·스케줄러까지
 * 흐르는데 엔진에 글라이드·비브라토 코드가 없어서 **데이터에만 있고 소리에는
 * 없었다.** `plan.md` 5-1 이 Phase 1 에 넣은 항목이고 차별점 ①의 핵심이다.
 *
 * 그래서 데이터에 넣은 곡선을 렌더한 뒤 음정을 시간축으로 추적해 비교한다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { WasmVoiceEngine } from './voice/wasmEngine.ts';
import { measureCentsError, seededRng, trackPitchCents } from './analysis.ts';
import { renderProjectOffline } from './offlineRender.ts';
import { createClip, createEmptyProject, createNote, createTrack } from '../model/factory.ts';
import { pitchToHz } from '../model/pitch.ts';
import { PPQ } from '../model/time.ts';
import type { PitchCurve, Project } from '../model/project.ts';
import { createRegistry } from '../instruments/definitions.ts';
import { curveCentsAt, isCurveFlat } from '../model/curve.ts';

const FS = 48000;
const registry = createRegistry();
const wasmPath = fileURLToPath(new URL('../generated/dsp.wasm', import.meta.url));

async function core(): Promise<WasmVoiceEngine> {
  return WasmVoiceEngine.create(await readFile(wasmPath), FS);
}

/** 곡선이 붙은 음 하나짜리 프로젝트 */
function projectWithCurve(midi: number, curve: PitchCurve | null, sustainSec = 4): Project {
  const project = createEmptyProject('곡선 테스트');
  project.tempo.bpm = 60;
  project.lengthBars = 1;

  const track = createTrack({ name: '기타', instrumentId: 'electric-guitar' });
  track.toneParams = { sustainSec };
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ });
  const note = createNote({ startTick: 0, lengthTick: 4 * PPQ, midi });
  note.pitchCurve = curve;
  clip.notes.push(note);
  track.clips.push(clip);
  project.tracks.push(track);
  return project;
}

async function render(project: Project): Promise<{ pcm: Float32Array; targetHz: number }> {
  const wasm = await core();
  const { pcm } = renderProjectOffline(project, registry, {
    sampleRate: FS,
    rng: seededRng(),
    tailSec: 1,
    wasm,
  });
  const note = project.tracks[0]!.clips[0]!.notes[0]!;
  return { pcm, targetHz: pitchToHz(note.pitch, project.tuning) };
}

/** 특정 시각 근처의 센트 값 */
function centsAt(track: { timeSec: number; cents: number }[], seconds: number): number {
  let best = track[0]!;
  for (const point of track) {
    if (Math.abs(point.timeSec - seconds) < Math.abs(best.timeSec - seconds)) best = point;
  }
  return best.cents;
}

test('음정 추적기가 합성 신호에서 정확하다', () => {
  // 추적기가 틀리면 아래 결론이 전부 거짓말이 된다. 먼저 정답을 아는 신호로 검증
  const hz = 220;
  const n = Math.round(1.0 * FS);
  const x = new Float32Array(n);
  // 0.5초에 걸쳐 0 → +40센트로 선형 상승
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const cents = Math.min(40, (t / 0.5) * 40);
    phase += (2 * Math.PI * hz * Math.pow(2, cents / 1200)) / FS;
    x[i] = 0.8 * Math.sin(phase);
  }

  // **홉을 정수 주기와 비정수 주기 둘 다 본다.** 정수 주기에서는 참조 위상 항이
  // 우연히 사라져 버그가 숨는다 — 실제로 그걸로 한 번 속았다
  for (const hopPeriods of [1, 0.5, 0.37, 2]) {
    const tracked = trackPitchCents(x, hz, FS, { periodsPerWindow: 3, hopPeriods });
    assert.ok(tracked.length > 20, `홉 ${hopPeriods}: 추적점이 ${tracked.length} 개뿐이다`);
    assert.ok(
      tracked.every((p) => Number.isFinite(p.cents)),
      `홉 ${hopPeriods}: 유한하지 않은 값이 있다`,
    );
    for (const [at, expected, tolerance] of [[0.05, 4, 6], [0.25, 20, 4], [0.8, 40, 3]] as const) {
      const got = centsAt(tracked, at);
      assert.ok(
        Math.abs(got - expected) < tolerance,
        `홉 ${hopPeriods}, ${at}초: ${got.toFixed(1)} (기대 ${expected})`,
      );
    }
  }
});

test('곡선이 없으면 음정이 평평하다', async () => {
  const { pcm, targetHz } = await render(projectWithCurve(57, null));
  const tracked = trackPitchCents(pcm, targetHz, FS);
  const window = tracked.filter((p) => p.timeSec > 0.1 && p.timeSec < 1.5);
  const worst = Math.max(...window.map((p) => Math.abs(p.cents)));
  assert.ok(worst < 2, `평평해야 하는데 최대 ${worst.toFixed(2)} 센트 흔들린다`);
});

test('글라이드가 파형에 나타난다', async () => {
  // 시작 음정이 -50센트 아래에서 출발해 120ms 안에 제자리로 온다
  const curve: PitchCurve = {
    glide: { cents: -50, ms: 120 },
    vibrato: null,
    points: null,
  };
  const { pcm, targetHz } = await render(projectWithCurve(57, curve));
  const tracked = trackPitchCents(pcm, targetHz, FS, { periodsPerWindow: 3, hopPeriods: 1 });

  const early = centsAt(tracked, 0.012);
  const settled = centsAt(tracked, 0.5);

  assert.ok(early < -20, `시작이 아래에서 출발하지 않는다: ${early.toFixed(1)} 센트`);
  assert.ok(Math.abs(settled) < 2, `수렴하지 않는다: ${settled.toFixed(1)} 센트`);
  // 방향이 위로 향한다
  assert.ok(centsAt(tracked, 0.04) > early, '글라이드가 위로 가지 않는다');
});

test('글라이드 방향이 부호를 따른다', async () => {
  const up: PitchCurve = { glide: { cents: -40, ms: 100 }, vibrato: null, points: null };
  const down: PitchCurve = { glide: { cents: 40, ms: 100 }, vibrato: null, points: null };

  const a = await render(projectWithCurve(57, up));
  const b = await render(projectWithCurve(57, down));

  const aStart = centsAt(trackPitchCents(a.pcm, a.targetHz, FS, { periodsPerWindow: 3 }), 0.012);
  const bStart = centsAt(trackPitchCents(b.pcm, b.targetHz, FS, { periodsPerWindow: 3 }), 0.012);

  assert.ok(aStart < -15, `아래에서 시작해야 한다: ${aStart.toFixed(1)}`);
  assert.ok(bStart > 15, `위에서 시작해야 한다: ${bStart.toFixed(1)}`);
});

test('비브라토의 깊이와 속도가 지정값과 맞는다', async () => {
  const depth = 25;
  const rate = 5;
  const curve: PitchCurve = {
    glide: null,
    vibrato: { cents: depth, hz: rate, delayMs: 0 },
    points: null,
  };
  const { pcm, targetHz } = await render(projectWithCurve(57, curve));
  const tracked = trackPitchCents(pcm, targetHz, FS, { periodsPerWindow: 3, hopPeriods: 0.5 });

  const window = tracked.filter((p) => p.timeSec > 0.05 && p.timeSec < 1.2);
  assert.ok(window.length > 40, `추적점 부족: ${window.length}`);

  // 깊이 — 사인파의 진폭은 RMS×√2 로 잰다.
  // 피크-투-피크로 재면 추적기 잡음과 변조 계단(32샘플마다 갱신)의 오버슈트를
  // 같이 집어 30~40% 과대평가된다
  const rms = Math.sqrt(window.reduce((sum, p) => sum + p.cents * p.cents, 0) / window.length);
  const measured = rms * Math.SQRT2;
  assert.ok(
    Math.abs(measured - depth) < depth * 0.2,
    `깊이 ${measured.toFixed(1)} 센트 (지정 ${depth})`,
  );

  // 속도 — 0선을 지나는 횟수로 센다
  let crossings = 0;
  for (let i = 1; i < window.length; i++) {
    if (Math.sign(window[i]!.cents) !== Math.sign(window[i - 1]!.cents)) crossings++;
  }
  const span = window.at(-1)!.timeSec - window[0]!.timeSec;
  const measuredHz = crossings / (2 * span);
  assert.ok(
    Math.abs(measuredHz - rate) < 1.2,
    `속도 ${measuredHz.toFixed(2)} Hz (지정 ${rate})`,
  );
});

test('비브라토 지연이 지켜진다', async () => {
  const curve: PitchCurve = {
    glide: null,
    vibrato: { cents: 30, hz: 6, delayMs: 400 },
    points: null,
  };
  const { pcm, targetHz } = await render(projectWithCurve(57, curve));
  const tracked = trackPitchCents(pcm, targetHz, FS, { periodsPerWindow: 3, hopPeriods: 0.5 });

  const before = tracked.filter((p) => p.timeSec > 0.05 && p.timeSec < 0.35);
  const after = tracked.filter((p) => p.timeSec > 0.45 && p.timeSec < 1.0);

  const beforeSwing = Math.max(...before.map((p) => Math.abs(p.cents)));
  const afterSwing = Math.max(...after.map((p) => Math.abs(p.cents)));

  assert.ok(beforeSwing < 5, `지연 구간에서 이미 흔들린다: ${beforeSwing.toFixed(1)} 센트`);
  assert.ok(afterSwing > 15, `지연 후에 흔들리지 않는다: ${afterSwing.toFixed(1)} 센트`);
});

test('곡선이 있어도 평균 음정은 목표를 유지한다', async () => {
  // 비브라토가 걸렸다고 음이 전체적으로 올라가거나 내려가면 안 된다.
  // 딜레이 길이를 바꾸는 방식이라 편향이 생기기 쉬운 지점이다
  const curve: PitchCurve = {
    glide: null,
    vibrato: { cents: 30, hz: 5, delayMs: 0 },
    points: null,
  };
  const { pcm, targetHz } = await render(projectWithCurve(57, curve));
  const tracked = trackPitchCents(pcm, targetHz, FS, { periodsPerWindow: 3, hopPeriods: 0.5 });

  // 정수 주기만큼 잘라서 평균을 낸다 (1초 = 5주기)
  const window = tracked.filter((p) => p.timeSec > 0.1 && p.timeSec <= 1.1);
  const mean = window.reduce((sum, p) => sum + p.cents, 0) / window.length;
  assert.ok(Math.abs(mean) < 4, `평균이 ${mean.toFixed(2)} 센트 치우쳤다`);
});

test('곡선이 있어도 NaN·발산이 없다', async () => {
  const curve: PitchCurve = {
    glide: { cents: -50, ms: 20 },
    vibrato: { cents: 50, hz: 12, delayMs: 0 },
    points: null,
  };
  for (const midi of [28, 57, 88]) {
    const { pcm } = await render(projectWithCurve(midi, curve));
    assert.ok(pcm.every(Number.isFinite), `midi=${midi}: 유한값이 아닌 샘플`);
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak < 4, `midi=${midi}: 피크 ${peak.toFixed(2)}`);
    assert.ok(peak > 0.01, `midi=${midi}: 소리가 안 난다`);
  }
});

test('곡선을 끄면 검증된 올패스 경로의 정확도가 그대로다', async () => {
  // 곡선 경로는 보간기가 달라 정확도 특성이 다르다. 곡선이 없을 때는 반드시
  // 원래 경로를 써야 한다 — 제품 핵심 주장이 그 경로에 걸려 있다
  for (const midi of [40, 57, 76, 88]) {
    const { pcm, targetHz } = await render(projectWithCurve(midi, null));
    const err = measureCentsError(pcm, targetHz, FS);
    assert.ok(Math.abs(err) <= 1, `midi=${midi}: ${err.toFixed(3)} 센트`);
  }
});

// ---------------------------------------------------------------------------
// 화면과 소리가 갈라지지 않는가
//
// `model/curve.ts` 의 `curveCentsAt` 은 Rust `cents_at` 을 손으로 옮긴 것이고,
// **그래프를 그리는 데 쓰인다.** 두 구현이 갈라지면 사용자가 그린 모양과 들리는 것이
// 어긋나고, 그건 편집 도구로서 최악이다. 여기서 실제 파형과 대조해 못 갈라지게 묶는다.
// ---------------------------------------------------------------------------

test('그래프용 곡선 함수가 실제 파형의 음정과 일치한다', async () => {
  const curve: PitchCurve = {
    glide: { cents: -180, ms: 220 },
    vibrato: { cents: 35, hz: 5, delayMs: 300 },
    points: null,
  };
  const { pcm, targetHz } = await render(projectWithCurve(57, curve));
  const tracked = trackPitchCents(pcm, targetHz, FS, { periodsPerWindow: 3 });

  // 글라이드 초반은 변화가 빨라 추적기의 창(3주기)이 평균을 내므로 오차가 크다.
  // 곡선이 자리를 잡은 뒤부터 비교한다
  const checkpoints = [0.35, 0.45, 0.55, 0.7, 0.85];
  for (const at of checkpoints) {
    const measured = centsAt(tracked, at);
    const predicted = curveCentsAt(curve, at);
    assert.ok(
      Math.abs(measured - predicted) < 12,
      `t=${at}s: 그래프 ${predicted.toFixed(1)}¢ vs 파형 ${measured.toFixed(1)}¢ — `
        + 'TS 와 Rust 의 곡선 식이 갈라졌다',
    );
  }
});

test('평평 판정이 두 구현에서 같다', async () => {
  // TS 가 "평평하다"고 보는 곡선은 엔진도 평평하게 봐야 한다.
  // 어긋나면 화면에는 곡선이 그려지는데 소리는 안 변한다 (실제로 났던 종류의 버그)
  const flatByTs: PitchCurve = { glide: { cents: 40, ms: 0 }, vibrato: null, points: null };
  assert.equal(isCurveFlat(flatByTs), true);

  const plain = await render(projectWithCurve(57, null));
  const withFlat = await render(projectWithCurve(57, flatByTs));

  // 같은 경로를 타면 결정론적 렌더라 파형이 완전히 같아야 한다
  assert.equal(withFlat.pcm.length, plain.pcm.length);
  for (let i = 0; i < plain.pcm.length; i += 97) {
    if (withFlat.pcm[i] !== plain.pcm[i]) {
      assert.fail(`샘플 ${i} 가 다르다 — 평평 판정이 엔진과 어긋난다`);
    }
  }
});

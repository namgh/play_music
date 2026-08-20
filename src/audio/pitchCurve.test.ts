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
  // **편광은 하나로 둔다.** 여기서 보려는 것은 곡선 엔진이고, 2편광을 켜면 맥놀이가
  // 추적된 음정에 얹혀 "비브라토 속도"를 세는 영점 통과 횟수가 늘어난다 —
  // 곡선이 틀린 게 아니라 **측정이 다른 것을 같이 재는 것**이다.
  // 2편광 자체는 `voice.rs` 의 편광 테스트가 따로 본다
  track.toneParams = { sustainSec, polarizationMix: 0 };
  const clip = createClip({ startTick: 0, lengthTick: 4 * PPQ });
  const note = createNote({ startTick: 0, lengthTick: 4 * PPQ, midi });
  // **음 id 를 고정한다.** 줄의 타건 변주 시드가 `variationSeed(noteId)` 로 나오는데
  // (`offlineRender.ts`), `factory.ts` 의 id 는 `Math.random()` 이라 매번 다르다.
  // 그러면 실행마다 여기(擊)의 잡음이 달라져 추적된 음정이 흔들리고, 측정이
  // 간헐적으로 어긋난다 — **제품이 아니라 시험 입력이 비결정적이었던 것이다.**
  // (저장된 곡은 id 가 고정이라 언제 렌더해도 같다: 미리듣기 = 내보내기)
  note.id = `not_curve-test-${midi}`;
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

  // 속도 — 0선을 지나는 횟수로 센다.
  //
  // **부호만 보면 안 된다.** 0선 근처에서는 추적기 잡음이 부호를 몇 번씩 뒤집고,
  // 그걸 전부 세면 속도가 배로 나온다 (5Hz 를 11Hz 로 읽었다). 그래서 확실히
  // 위/아래에 있을 때만 상태를 바꾸는 히스테리시스를 둔다 — 잡음은 이 띠를
  // 넘지 못하고, 진짜 비브라토는 넘는다.
  const guard = depth * 0.25;
  let state = 0; // -1 | 0 | +1
  let crossings = 0;
  for (const p of window) {
    const next = p.cents > guard ? 1 : p.cents < -guard ? -1 : state;
    if (state !== 0 && next !== state) crossings++;
    state = next;
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

  // **같은 노트를 써야 한다.** 타건 변주가 노트 id 에 걸려 있어(`ROADMAP.md` S2-4)
  // 음을 새로 만들면 씨앗이 달라져 세기가 미세하게 달라진다 — 그건 의도한 동작이고,
  // 여기서 보려는 것은 "곡선 유무로 경로가 갈리는가"다
  const project = projectWithCurve(57, null);
  const plain = await render(project);
  const flatProject = projectWithCurve(57, flatByTs);
  flatProject.tracks[0]!.clips[0]!.notes[0]!.id = project.tracks[0]!.clips[0]!.notes[0]!.id;
  const withFlat = await render(flatProject);

  // 같은 경로를 타면 결정론적 렌더라 파형이 완전히 같아야 한다
  assert.equal(withFlat.pcm.length, plain.pcm.length);
  for (let i = 0; i < plain.pcm.length; i += 97) {
    if (withFlat.pcm[i] !== plain.pcm[i]) {
      assert.fail(`샘플 ${i} 가 다르다 — 평평 판정이 엔진과 어긋난다`);
    }
  }
});

// --- 자유곡선 (ROADMAP.md S1-4) --------------------------------------------

/**
 * 특정 시각의 센트 값 — **그 시각이 실제로 추적됐을 때만.**
 *
 * `centsAt` 은 가장 가까운 점을 돌려주는데, 음이 감쇠해 추적이 끊기면 **마지막 점을
 * 조용히 돌려준다.** 그러면 3.5초를 물었는데 2.1초 값을 받고도 테스트는 그걸 모른다
 * (실제로 이걸로 한 번 헛짚었다). 재려는 시각이 추적 범위 밖이면 실패시킨다.
 */
function centsAtStrict(track: { timeSec: number; cents: number }[], seconds: number): number {
  const nearest = track.reduce((best, p) => (
    Math.abs(p.timeSec - seconds) < Math.abs(best.timeSec - seconds) ? p : best
  ), track[0]!);
  assert.ok(
    Math.abs(nearest.timeSec - seconds) < 0.1,
    `${seconds}초를 재려는데 가장 가까운 추적점이 ${nearest.timeSec.toFixed(2)}초다 `
    + '— 음이 그 전에 감쇠했다. 측정 구간이 틀렸다',
  );
  return nearest.cents;
}

/** 자유곡선만 붙은 곡선 객체 */
function freeCurve(points: { tNorm: number; cents: number }[]): PitchCurve {
  return { glide: null, vibrato: null, points };
}

test('그린 자유곡선이 실제 파형의 음정으로 나온다', async () => {
  // 차별점 ①의 완성형. **데이터에만 있고 소리에 없으면** 이 기능은 존재하지 않는 것과 같다.
  // 4/4 60BPM 에 4박 = 4초짜리 음이다
  const curve = freeCurve([
    { tNorm: 0, cents: 0 },
    { tNorm: 0.5, cents: 200 }, // 온음 위로
    { tNorm: 1, cents: 0 },
  ]);
  // **서스테인을 길게 준다.** 기본값이면 2초쯤 음이 감쇠해 추적이 끊기고
  // 뒷부분을 아예 못 잰다
  const { pcm, targetHz } = await render(projectWithCurve(57, curve, 30));
  const tracked = trackPitchCents(pcm, targetHz, FS);

  // 4초 음이므로 0.5초 = tNorm 0.125 → 200 × (0.125/0.5) = 50센트
  for (const [at, expected] of [[0.5, 50], [2.0, 200], [3.5, 50]] as const) {
    const got = centsAtStrict(tracked, at);
    assert.ok(
      Math.abs(got - expected) < 20,
      `${at}초: ${got.toFixed(1)} 센트 (기대 ${expected})`,
    );
  }
});

test('화면 예측과 실제 음정이 자유곡선에서도 일치한다', async () => {
  // **화면·소리 불일치 방어선.** 그린 모양과 들리는 음정이 다르면 편집 도구로서 최악이다
  const durationSec = 4;
  const curve = freeCurve([
    { tNorm: 0, cents: -150 },
    { tNorm: 0.25, cents: 100 },
    { tNorm: 1, cents: 0 },
  ]);
  const { pcm, targetHz } = await render(projectWithCurve(57, curve, 30));
  const tracked = trackPitchCents(pcm, targetHz, FS);

  for (const at of [0.3, 1.0, 2.0, 3.0]) {
    const predicted = curveCentsAt(curve, at, durationSec);
    const measured = centsAtStrict(tracked, at);
    assert.ok(
      Math.abs(predicted - measured) < 25,
      `${at}초: 화면 ${predicted.toFixed(1)} vs 소리 ${measured.toFixed(1)} 센트`,
    );
  }
});

test('자유곡선이 글라이드·비브라토를 대신한다', async () => {
  // plan.md 5-4: "사용자가 그리면 points 가 우선". 섞이면 그린 모양과 달라진다
  const curve: PitchCurve = {
    glide: { cents: -300, ms: 100 },
    vibrato: { cents: 50, hz: 6, delayMs: 0 },
    points: [{ tNorm: 0, cents: 0 }, { tNorm: 1, cents: 0 }],
  };
  assert.ok(isCurveFlat(curve, 4), '전부 0인 자유곡선인데 평평하지 않다고 한다');

  const { pcm, targetHz } = await render(projectWithCurve(57, curve));
  const tracked = trackPitchCents(pcm, targetHz, FS);
  const window = tracked.filter((p) => p.timeSec > 0.3 && p.timeSec < 2);
  const worst = Math.max(...window.map((p) => Math.abs(p.cents)));
  assert.ok(worst < 15, `글라이드·비브라토가 새어 들어왔다 (최대 ${worst.toFixed(1)} 센트)`);
});

test('길이를 안 주면 자유곡선을 쓰지 않는다', () => {
  // 정규화 시간을 초로 되돌릴 수 없으므로 글라이드·비브라토로 떨어져야 한다.
  // 조용히 0 을 내면 "그렸는데 아무 일도 안 일어난다"가 된다
  const curve: PitchCurve = {
    glide: { cents: -24, ms: 60 },
    vibrato: null,
    points: [{ tNorm: 0, cents: 500 }],
  };
  assert.equal(curveCentsAt(curve, 0, 0), -24);
  assert.equal(curveCentsAt(curve, 0, 4), 500);
});

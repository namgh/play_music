/**
 * 데모 곡을 **끝까지** 만들어 본다 — 이 도구로 곡 하나를 완성할 수 있는가.
 *
 * `plan.md` 의 Phase 1 완료 조건이 "AI 없이 직접 작곡해서 곡 하나를 끝내고
 * 내보낼 수 있다"이다. 단위 테스트는 음 하나·트랙 하나를 보지만, 그 조건은
 * **여러 악기가 몇 분 동안 함께 우는 상태**에서만 확인된다.
 *
 * 그래서 시대가 다른 두 곡을 만든다. 편성·템포·구조가 달라야 도구의 다른 데가
 * 눌린다 — 느린 곡은 긴 음의 감쇠와 여백을, 빠른 곡은 촘촘한 리듬과 보이스 수를
 * 시험한다.
 *
 * 결과물은 두 가지다:
 *   out/<이름>.wav    들어 볼 수 있는 파일
 *   out/<이름>.json   앱의 "열기" 로 그대로 여는 프로젝트
 *
 * 실행: node --experimental-strip-types tools/demo-songs.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const R = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const { createClip, createEmptyProject, createNote, createTrack } = await import(R('../src/model/factory.ts'));
const { serializeProject } = await import(R('../src/model/persistence.ts'));
const { PPQ } = await import(R('../src/model/time.ts'));
const { loadAllInstruments } = await import(R('../src/instruments/definitions.ts'));
const { WasmVoiceEngine } = await import(R('../src/audio/voice/wasmEngine.ts'));
const { seededRng } = await import(R('../src/audio/analysis.ts'));
const { renderProjectOffline } = await import(R('../src/audio/offlineRender.ts'));
const { encodeWav, peakAmplitude } = await import(R('../src/audio/wav.ts'));
const { reportClipping } = await import(R('../src/audio/headroom.ts'));

const SAMPLE_RATE = 48000;
const BEAT = PPQ;
const BAR = 4 * PPQ;

// ---------------------------------------------------------------------------
// 작곡 도우미
//
// 음을 하나씩 손으로 찍으면 곡 하나가 수백 줄이 된다. 화성과 리듬은 **패턴**이라
// 패턴으로 적는 편이 읽기도 고치기도 쉽다.

/** 화음 = 근음 + 음정 간격. 자리바꿈은 옥타브를 더해 만든다 */
const CHORD = {
  min: [0, 3, 7], maj: [0, 4, 7], min7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  sus4: [0, 5, 7], dom7: [0, 4, 7, 10],
};
const chord = (root, quality, octaveShift = 0) =>
  CHORD[quality].map((i) => root + i + 12 * octaveShift);

/**
 * 트랙 하나를 만든다. 클립은 곡 전체를 덮는 하나로 둔다 — 데모의 목적은
 * 클립 편집이 아니라 **소리가 끝까지 나는지**다.
 */
function makeTrack(project, { name, instrumentId, gain = 0.8, pan = 0 }) {
  const track = createTrack({ name, instrumentId });
  track.gain = gain;
  track.pan = pan;
  const clip = createClip({ startTick: 0, lengthTick: project.lengthBars * BAR, label: name });
  track.clips.push(clip);
  project.tracks.push(track);
  return clip;
}

/**
 * 음을 놓는다. 위치와 길이는 **박** 단위(4분음표 = 1)로 적는다.
 *
 * 노트 id 를 결정적으로 붙인다 — 렌더러가 여기서 변주 씨앗을 뽑으므로
 * (`variationSeed`), 무작위면 돌릴 때마다 다른 파일이 나온다.
 */
function put(clip, tag, beat, lengthBeats, midi, velocity = 0.8) {
  const note = createNote({
    startTick: Math.round(beat * BEAT),
    lengthTick: Math.max(1, Math.round(lengthBeats * BEAT)),
    midi,
  });
  note.id = `not_${tag}-${clip.notes.length}`;
  note.velocity = velocity;
  clip.notes.push(note);
  return note;
}

/** 화음을 한 번에 — 아르페지오가 아니라 동시에 누르는 것 */
const putChord = (clip, tag, beat, len, midis, vel = 0.7) =>
  midis.forEach((m) => put(clip, tag, beat, len, m, vel));

/** 화음을 흩어 친다. `steps` 는 화음 안에서의 자리(0,1,2…) */
function arpeggio(clip, tag, startBeat, midis, steps, stepLen, vel = 0.62) {
  steps.forEach((s, i) => {
    const m = midis[s % midis.length] + 12 * Math.floor(s / midis.length);
    put(clip, tag, startBeat + i * stepLen, stepLen * 0.95, m, vel);
  });
}

// ---------------------------------------------------------------------------

/**
 * 1곡 — 2012년경 한국 미드템포 발라드형.
 *
 * 느리고 여백이 많다. **긴 음의 감쇠**와 소절 사이 빈 곳이 그대로 들리므로,
 * 줄 악기의 여운과 패드의 지속이 시험된다.
 */
function makeSlowSong() {
  const project = createEmptyProject('데모 1 — 새벽 두 시');
  project.tempo.bpm = 76;
  project.lengthBars = 32;
  project.key = { tonic: 'A', mode: 'minor' };

  // vi–IV–I–V. 한국 미드템포가 가장 오래 쓰는 자리다
  const A = 57, F = 53, C = 60, G = 55;
  const prog = [
    { root: A, q: 'min7' }, { root: F, q: 'maj7' },
    { root: C, q: 'maj' }, { root: G, q: 'dom7' },
  ];

  const rhodes = makeTrack(project, { name: '로즈', instrumentId: 'electric-piano-rhodes', gain: 0.62 });
  const guitar = makeTrack(project, { name: '기타', instrumentId: 'acoustic-guitar', gain: 0.5, pan: -0.35 });
  const pad = makeTrack(project, { name: '패드', instrumentId: 'synth-pad', gain: 0.3 });
  const bass = makeTrack(project, { name: '베이스', instrumentId: 'electric-bass', gain: 0.7 });
  const lead = makeTrack(project, { name: '리드', instrumentId: 'synth-lead', gain: 0.42, pan: 0.2 });
  const bell = makeTrack(project, { name: '글로켄', instrumentId: 'glockenspiel', gain: 0.3, pan: 0.45 });
  const kick = makeTrack(project, { name: '킥', instrumentId: 'kick', gain: 0.8 });
  const snare = makeTrack(project, { name: '스네어', instrumentId: 'snare', gain: 0.55 });
  const hat = makeTrack(project, { name: '하이햇', instrumentId: 'hihat', gain: 0.3, pan: 0.25 });

  // 구간마다 편성을 바꾼다 — 다 넣고 시작하면 후렴에서 더 갈 곳이 없다
  const SECTIONS = [
    { name: '인트로', bars: [0, 4], drums: false, full: false, melody: false },
    { name: '벌스1', bars: [4, 8], drums: 'soft', full: false, melody: false },
    { name: '프리', bars: [8, 12], drums: 'soft', full: false, melody: true },
    { name: '후렴1', bars: [12, 16], drums: 'full', full: true, melody: true },
    { name: '벌스2', bars: [16, 20], drums: 'soft', full: false, melody: false },
    { name: '후렴2', bars: [20, 24], drums: 'full', full: true, melody: true },
    { name: '브릿지', bars: [24, 28], drums: false, full: false, melody: true },
    { name: '후렴3', bars: [28, 32], drums: 'full', full: true, melody: true },
  ];

  // 후렴 선율 — 한 마디에 한 악구. 화음의 3음·5음을 짚는다
  const HOOK = [
    [[0, 1.5, 76], [1.5, 0.5, 74], [2, 2, 72]],
    [[0, 1.5, 72], [1.5, 0.5, 74], [2, 2, 69]],
    [[0, 1, 76], [1, 1, 79], [2, 2, 76]],
    [[0, 1.5, 74], [1.5, 0.5, 72], [2, 2, 74]],
  ];

  for (const section of SECTIONS) {
    for (let bar = section.bars[0]; bar < section.bars[1]; bar += 1) {
      const at = bar * 4;
      const step = prog[bar % prog.length];
      const notes = chord(step.root, step.q);
      const tag = `${section.name}-${bar}`;

      // 로즈 — 화음을 길게 누른다
      putChord(rhodes, `r${tag}`, at, 3.8, notes.map((m) => m + 12), section.full ? 0.62 : 0.48);

      // 기타 아르페지오 — 8분음표로 흩는다
      arpeggio(guitar, `g${tag}`, at, notes.map((m) => m + 12), [0, 1, 2, 3, 2, 1, 0, 1], 0.5,
        section.full ? 0.6 : 0.45);

      // 패드는 후렴에서만 — 넣고 빼는 것이 편성의 전부다
      if (section.full) putChord(pad, `p${tag}`, at, 4, notes.map((m) => m + 12), 0.4);

      // 베이스 — 근음, 후렴에서는 8분음표로 민다
      put(bass, `b${tag}`, at, 1.8, step.root - 12, 0.8);
      put(bass, `b${tag}`, at + 2, 1.8, step.root - 12, 0.72);
      if (section.full) put(bass, `b${tag}`, at + 3.5, 0.4, step.root - 12 + 7, 0.6);

      // 선율
      if (section.melody) {
        const phrase = HOOK[bar % HOOK.length];
        for (const [b, len, midi] of phrase) put(lead, `l${tag}`, at + b, len, midi, 0.55);
        if (section.full) put(bell, `e${tag}`, at, 1, phrase[0][2] + 12, 0.4);
      }

      // 드럼
      if (section.drums) {
        put(kick, `k${tag}`, at, 0.5, 36, 0.9);
        put(kick, `k${tag}`, at + 2.5, 0.5, 36, 0.75);
        put(snare, `s${tag}`, at + 1, 0.5, 38, section.drums === 'full' ? 0.8 : 0.55);
        put(snare, `s${tag}`, at + 3, 0.5, 38, section.drums === 'full' ? 0.8 : 0.55);
        const hats = section.drums === 'full' ? 8 : 4;
        for (let i = 0; i < hats; i += 1) {
          put(hat, `h${tag}`, at + (i * 4) / hats, 0.2, 42, i % 2 === 0 ? 0.5 : 0.32);
        }
      }
    }
  }
  return project;
}

/**
 * 2곡 — 최근 업템포 댄스팝.
 *
 * 빠르고 촘촘하다. **동시에 우는 보이스 수**와 짧은 음의 연속이 시험된다 —
 * 느린 곡과 정반대 지점이다.
 */
function makeFastSong() {
  const project = createEmptyProject('데모 2 — 네온 사인');
  project.tempo.bpm = 124;
  project.lengthBars = 32;
  project.key = { tonic: 'C', mode: 'major' };

  // I–V–vi–IV
  const prog = [
    { root: 60, q: 'maj' }, { root: 67, q: 'maj' },
    { root: 69, q: 'min' }, { root: 65, q: 'maj' },
  ];

  const saw = makeTrack(project, { name: '슈퍼소우', instrumentId: 'supersaw-lead', gain: 0.34, pan: 0 });
  const pluck = makeTrack(project, { name: '플럭', instrumentId: 'synth-pluck', gain: 0.42, pan: -0.3 });
  const marimba = makeTrack(project, { name: '마림바', instrumentId: 'marimba', gain: 0.4, pan: 0.35 });
  const pad = makeTrack(project, { name: '패드', instrumentId: 'synth-pad', gain: 0.26 });
  const sub = makeTrack(project, { name: '서브', instrumentId: 'sub-bass', gain: 0.62 });
  const bass = makeTrack(project, { name: '베이스', instrumentId: 'synth-bass', gain: 0.44 });
  const kick = makeTrack(project, { name: '킥', instrumentId: 'kick', gain: 0.85 });
  const clap = makeTrack(project, { name: '클랩', instrumentId: 'clap', gain: 0.5 });
  const hat = makeTrack(project, { name: '하이햇', instrumentId: 'hihat', gain: 0.26, pan: 0.2 });
  const open = makeTrack(project, { name: '오픈햇', instrumentId: 'hihat-open', gain: 0.22, pan: -0.2 });

  const SECTIONS = [
    { name: '인트로', bars: [0, 4], kick: false, hook: false, dense: false },
    { name: '벌스1', bars: [4, 8], kick: true, hook: false, dense: false },
    { name: '프리', bars: [8, 12], kick: true, hook: false, dense: true },
    { name: '훅1', bars: [12, 16], kick: true, hook: true, dense: true },
    { name: '벌스2', bars: [16, 20], kick: true, hook: false, dense: false },
    { name: '훅2', bars: [20, 24], kick: true, hook: true, dense: true },
    { name: '브릿지', bars: [24, 28], kick: false, hook: false, dense: false },
    { name: '훅3', bars: [28, 32], kick: true, hook: true, dense: true },
  ];

  // 훅 — 짧고 반복되는 것이 이 장르의 문법이다
  const HOOK = [
    [[0, 0.5, 72], [0.5, 0.5, 76], [1, 0.5, 79], [1.5, 0.5, 76], [2, 1.5, 72]],
    [[0, 0.5, 74], [0.5, 0.5, 79], [1, 1, 83], [2, 1.5, 79]],
    [[0, 0.5, 76], [0.5, 0.5, 81], [1, 0.5, 84], [1.5, 0.5, 81], [2, 1.5, 76]],
    [[0, 1, 74], [1, 1, 72], [2, 2, 67]],
  ];

  for (const section of SECTIONS) {
    for (let bar = section.bars[0]; bar < section.bars[1]; bar += 1) {
      const at = bar * 4;
      const step = prog[bar % prog.length];
      const notes = chord(step.root, step.q);
      const tag = `${section.name}-${bar}`;

      // 플럭 — 16분음표 아르페지오. 이 장르의 엔진이다
      arpeggio(pluck, `q${tag}`, at, notes, [0, 1, 2, 3, 2, 1, 2, 0], 0.5,
        section.dense ? 0.6 : 0.42);

      if (section.dense) putChord(pad, `p${tag}`, at, 4, notes.map((m) => m + 12), 0.36);

      // 베이스 — 서브는 근음을 길게, 신스 베이스는 8분음표로 민다
      put(sub, `u${tag}`, at, 3.9, step.root - 24, 0.85);
      for (let i = 0; i < 8; i += 1) {
        if (i % 2 === 1 && !section.dense) continue;
        put(bass, `b${tag}`, at + i * 0.5, 0.42, step.root - 12, i % 2 === 0 ? 0.6 : 0.4);
      }

      if (section.hook) {
        const phrase = HOOK[bar % HOOK.length];
        for (const [b, len, midi] of phrase) {
          put(saw, `w${tag}`, at + b, len, midi, 0.6);
          put(marimba, `m${tag}`, at + b, Math.min(len, 0.5), midi, 0.45);
        }
      }

      // 드럼 — 네 박 킥이 이 장르의 바닥이다
      if (section.kick) {
        for (let i = 0; i < 4; i += 1) put(kick, `k${tag}`, at + i, 0.4, 36, i === 0 ? 0.95 : 0.85);
        put(clap, `c${tag}`, at + 1, 0.3, 39, 0.7);
        put(clap, `c${tag}`, at + 3, 0.3, 39, 0.7);
      }
      const hats = section.dense ? 8 : 4;
      for (let i = 0; i < hats; i += 1) {
        put(hat, `h${tag}`, at + (i * 4) / hats, 0.15, 42, i % 2 === 0 ? 0.45 : 0.28);
      }
      if (section.dense) put(open, `o${tag}`, at + 3.5, 0.4, 46, 0.4);
    }
  }
  return project;
}

// ---------------------------------------------------------------------------

const registry = await loadAllInstruments();
const wasmBytes = await readFile(R('../src/generated/dsp.wasm'));
const outDir = R('../out');
mkdirSync(outDir, { recursive: true });

for (const build of [makeSlowSong, makeFastSong]) {
  const project = build();
  const noteCount = project.tracks.reduce(
    (sum, t) => sum + t.clips.reduce((s, c) => s + c.notes.length, 0), 0,
  );

  const engines = [];
  for (let i = 0; i < project.tracks.length; i += 1) {
    engines.push(await WasmVoiceEngine.create(wasmBytes, SAMPLE_RATE));
  }
  const started = process.hrtime.bigint();
  const { pcm } = renderProjectOffline(project, registry, {
    sampleRate: SAMPLE_RATE, rng: seededRng(), tailSec: 3, wasm: engines,
  });
  const renderMs = Number(process.hrtime.bigint() - started) / 1e6;

  // **넘치면 고쳐서 내보낸다.** 화면의 "마스터 내리기" 버튼과 같은 계산이다
  const peak = peakAmplitude([pcm]);
  const clip = reportClipping(peak, project.master.gain);
  if (clip) {
    project.master.gain = clip.suggestedGain;
    for (let i = 0; i < engines.length; i += 1) engines[i] = await WasmVoiceEngine.create(wasmBytes, SAMPLE_RATE);
  }
  const final = clip
    ? renderProjectOffline(project, registry, {
      sampleRate: SAMPLE_RATE, rng: seededRng(), tailSec: 3, wasm: engines,
    }).pcm
    : pcm;

  const finalPeak = peakAmplitude([final]);
  const seconds = final.length / SAMPLE_RATE;
  const safe = project.name.replace(/[^\w가-힣]+/g, '-');
  writeFileSync(`${outDir}/${safe}.wav`, encodeWav([final], { sampleRate: SAMPLE_RATE, bitDepth: 24 }));
  writeFileSync(`${outDir}/${safe}.json`, serializeProject(project));

  console.log(`${project.name}`);
  console.log(`  ${project.tempo.bpm}BPM · ${project.lengthBars}마디 · ${seconds.toFixed(1)}초`
    + ` · 트랙 ${project.tracks.length} · 음 ${noteCount}개`);
  console.log(`  피크 ${(20 * Math.log10(finalPeak)).toFixed(2)}dBFS`
    + (clip ? ` (마스터 ${clip.reductionDb.toFixed(1)}dB 내려 맞춤)` : ' (그대로)')
    + ` · 렌더 ${(renderMs / 1000).toFixed(1)}초 = 실시간의 ${(seconds / (renderMs / 1000)).toFixed(1)}배속`);
  console.log(`  out/${safe}.wav · out/${safe}.json`);
}

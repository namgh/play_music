/**
 * 데모 곡을 **끝까지** 만들어 본다 — 이 도구로 곡 하나를 완성할 수 있는가.
 *
 * `plan.md` 의 Phase 1 완료 조건이 "AI 없이 직접 작곡해서 곡 하나를 끝내고
 * 내보낼 수 있다"이다. 단위 테스트는 음 하나·트랙 하나를 보지만, 그 조건은
 * **여러 악기가 몇 분 동안 함께 우는 상태**에서만 확인된다.
 *
 * 시대와 장르를 벌려 다섯 곡을 만든다. 편성·템포·주법이 달라야 도구의 다른 데가
 * 눌린다 — 느린 발라드는 긴 음의 감쇠와 여백을, 댄스곡은 촘촘한 리듬과 보이스
 * 수를, 밴드 편성은 없는 악기(심벌·활 악기)를 드러낸다.
 *
 * **여기서 걸린 것들은 `SONGCRAFT.md` 에 적는다.** 곡을 만들어 보지 않으면
 * 안 보이는 종류의 부족함이라, 그게 이 스크립트의 진짜 산출물이다.
 *
 * 결과물:
 *   out/<이름>.wav    들어 볼 수 있는 파일 (이 경로는 **모노·이펙트 없음**)
 *   out/<이름>.json   앱의 "열기" 로 그대로 여는 프로젝트 (이펙트 포함)
 *
 * 실행: npm run demo
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
const { createEffect } = await import(R('../src/audio/effects.ts'));

/**
 * 표본율. **상용 음원과 견줄 때는 그쪽에 맞춰 뽑는다** — 상용 음원은 대개 44.1kHz 이고,
 * 비교 도구는 표본율이 다르면 멈춘다 (리샘플러 품질이 결과에 섞이지 않게 하려는 것이다).
 * 맞추는 방향은 **우리 쪽을 상대에 맞추는 것**이지 상대를 건드리는 것이 아니다.
 *
 *   npm run demo -- --rate 44100
 */
const rateArg = process.argv.indexOf('--rate');
const SAMPLE_RATE = rateArg >= 0 ? Number(process.argv[rateArg + 1]) : 48000;
const BEAT = PPQ;
const BAR = 4 * PPQ;
/**
 * 데모 길이. **32마디로 뽑았더니 한 곡에 수십 분이 걸렸다** — 목적이 "곡을 만들며
 * 부족한 것을 찾는 것"이지 긴 파일을 얻는 것이 아니므로 16마디로 줄인다.
 * 렌더가 왜 그렇게 느린지는 그 자체로 확인할 거리다 (`SONGCRAFT.md`).
 */
const LENGTH_BARS = 16;

// ---------------------------------------------------------------------------
// 작곡 도우미 — 화성과 리듬은 패턴이므로 패턴으로 적는다

const CHORD = {
  min: [0, 3, 7], maj: [0, 4, 7], min7: [0, 3, 7, 10], maj7: [0, 4, 7, 11],
  dom7: [0, 4, 7, 10], sus4: [0, 5, 7], min9: [0, 3, 7, 10, 14], add9: [0, 4, 7, 14],
};
const chord = (root, quality) => CHORD[quality].map((i) => root + i);

function makeTrack(project, { name, instrumentId, gain = 0.8, pan = 0, effects = [] }) {
  const track = createTrack({ name, instrumentId });
  track.gain = gain;
  track.pan = pan;
  track.effects = effects;
  const clip = createClip({ startTick: 0, lengthTick: project.lengthBars * BAR, label: name });
  track.clips.push(clip);
  project.tracks.push(track);
  return clip;
}

/** 위치·길이는 **박** 단위(4분음표 = 1). id 는 결정적이어야 한다 (변주 씨앗) */
function put(clip, beat, lengthBeats, midi, velocity = 0.8) {
  const note = createNote({
    startTick: Math.round(beat * BEAT),
    lengthTick: Math.max(1, Math.round(lengthBeats * BEAT)),
    midi,
  });
  note.id = `not_${clip.id.slice(4, 10)}-${clip.notes.length}`;
  note.velocity = velocity;
  clip.notes.push(note);
}

const putChord = (clip, beat, len, midis, vel = 0.7) =>
  midis.forEach((m) => put(clip, beat, len, m, vel));

function arpeggio(clip, startBeat, midis, steps, stepLen, vel = 0.6) {
  steps.forEach((s, i) => {
    const m = midis[s % midis.length] + 12 * Math.floor(s / midis.length);
    put(clip, startBeat + i * stepLen, stepLen * 0.92, m, vel);
  });
}

/** 구간을 돌며 마디마다 콜백. `at` 은 박, `step` 은 그 마디의 화음 */
function sections(list, prog, write) {
  for (const section of list) {
    for (let bar = section.bars[0]; bar < section.bars[1]; bar += 1) {
      write({ ...section, bar, at: bar * 4, step: prog[bar % prog.length] });
    }
  }
}

const reverb = (mix) => { const e = createEffect('reverb'); e.params.mix = mix; return e; };
const comp = (threshold, ratio) => {
  const e = createEffect('compressor');
  e.params.thresholdDb = threshold;
  e.params.ratio = ratio;
  return e;
};

// ---------------------------------------------------------------------------
// 1 — 2000년대 발라드. 느리고 여백이 많다. 긴 음의 감쇠와 지속이 시험된다

function ballad() {
  const p = createEmptyProject('데모 1 — 발라드 (2000년대)');
  p.tempo.bpm = 68;
  p.lengthBars = LENGTH_BARS;
  p.key = { tonic: 'D', mode: 'minor' };

  const prog = [
    { root: 62, q: 'min' }, { root: 57, q: 'min7' },
    { root: 58, q: 'maj7' }, { root: 65, q: 'maj' },
  ];
  const piano = makeTrack(p, { name: '피아노', instrumentId: 'acoustic-piano', gain: 0.6, effects: [reverb(0.22)] });
  const guitar = makeTrack(p, { name: '기타', instrumentId: 'classical-guitar', gain: 0.42, pan: -0.35 });
  const strings = makeTrack(p, { name: '현악(패드 대용)', instrumentId: 'synth-pad', gain: 0.26, effects: [reverb(0.35)] });
  const bass = makeTrack(p, { name: '베이스', instrumentId: 'double-bass-pizz', gain: 0.6 });
  const bell = makeTrack(p, { name: '벨', instrumentId: 'glockenspiel', gain: 0.22, pan: 0.4, effects: [reverb(0.4)] });
  const kick = makeTrack(p, { name: '킥', instrumentId: 'kick', gain: 0.62 });
  const snare = makeTrack(p, { name: '스네어', instrumentId: 'snare', gain: 0.4, effects: [reverb(0.25)] });

  sections([
    { name: '인트로', bars: [0, 2], drums: false, full: false, mel: false },
    { name: '벌스1', bars: [2, 6], drums: false, full: false, mel: false },
    { name: '프리', bars: [6, 8], drums: true, full: false, mel: true },
    { name: '후렴1', bars: [8, 11], drums: true, full: true, mel: true },
    { name: '간주', bars: [11, 12], drums: false, full: false, mel: true },
    { name: '후렴2', bars: [12, 15], drums: true, full: true, mel: true },
    { name: '아웃트로', bars: [15, 16], drums: false, full: false, mel: false },
  ], prog, ({ at, step, drums, full, mel }) => {
    const c = chord(step.root, step.q);
    putChord(piano, at, 3.7, c.map((m) => m + 12), full ? 0.6 : 0.44);
    arpeggio(guitar, at, c.map((m) => m + 12), [0, 1, 2, 1, 2, 3, 2, 1], 0.5, full ? 0.5 : 0.36);
    if (full || mel) putChord(strings, at, 4, c.map((m) => m + 12), full ? 0.42 : 0.28);
    put(bass, at, 2.4, step.root - 12, 0.72);
    put(bass, at + 2.5, 1.3, step.root - 12, 0.6);
    if (mel) {
      const phrase = [[0, 1.5, 74], [1.5, 0.5, 72], [2, 2, 69]];
      for (const [b, l, m] of phrase) put(bell, at + b, l, m + 12, 0.34);
    }
    if (drums) {
      put(kick, at, 0.5, 36, 0.8);
      put(kick, at + 2.5, 0.5, 36, 0.6);
      put(snare, at + 2, 0.5, 38, full ? 0.7 : 0.45);
    }
  });
  return p;
}

// 2 — 2010년대 미드템포 R&B. 서브베이스와 여백, 스네어의 자리가 핵심이다

function midtempoRnb() {
  const p = createEmptyProject('데모 2 — 미드템포 R&B (2010년대)');
  p.tempo.bpm = 92;
  p.lengthBars = LENGTH_BARS;
  p.key = { tonic: 'F', mode: 'minor' };
  p.swing = 0.15;

  const prog = [
    { root: 65, q: 'min9' }, { root: 63, q: 'maj7' },
    { root: 68, q: 'min7' }, { root: 61, q: 'maj7' },
  ];
  const rhodes = makeTrack(p, { name: '로즈', instrumentId: 'electric-piano-rhodes', gain: 0.52, effects: [reverb(0.18)] });
  const pluck = makeTrack(p, { name: '플럭', instrumentId: 'synth-pluck', gain: 0.3, pan: 0.3 });
  const sub = makeTrack(p, { name: '서브', instrumentId: 'sub-bass', gain: 0.62 });
  const pad = makeTrack(p, { name: '패드', instrumentId: 'synth-pad', gain: 0.2 });
  const lead = makeTrack(p, { name: '리드', instrumentId: 'synth-lead', gain: 0.3, pan: -0.2 });
  const kick = makeTrack(p, { name: '킥', instrumentId: 'kick', gain: 0.82 });
  const snare = makeTrack(p, { name: '스네어', instrumentId: 'snare', gain: 0.6, effects: [reverb(0.2)] });
  const hat = makeTrack(p, { name: '하이햇', instrumentId: 'hihat', gain: 0.24, pan: 0.25 });

  sections([
    { name: '인트로', bars: [0, 2], beat: false, mel: false, dense: false },
    { name: '벌스1', bars: [2, 6], beat: true, mel: false, dense: false },
    { name: '훅1', bars: [6, 9], beat: true, mel: true, dense: true },
    { name: '벌스2', bars: [9, 12], beat: true, mel: false, dense: false },
    { name: '훅2', bars: [12, 15], beat: true, mel: true, dense: true },
    { name: '아웃트로', bars: [15, 16], beat: false, mel: false, dense: false },
  ], prog, ({ at, step, beat, mel, dense }) => {
    const c = chord(step.root, step.q);
    putChord(rhodes, at, 2.2, c.map((m) => m + 12), dense ? 0.55 : 0.42);
    putChord(rhodes, at + 2.5, 1.2, c.map((m) => m + 12), 0.34);
    if (dense) arpeggio(pluck, at, c, [0, 2, 1, 3, 2, 0], 0.5, 0.4);
    if (dense) putChord(pad, at, 4, c.map((m) => m + 12), 0.3);
    put(sub, at, 1.8, step.root - 24, 0.85);
    put(sub, at + 2.75, 1.1, step.root - 24, 0.7);
    if (mel) for (const [b, l, m] of [[0, 1, 77], [1, 0.5, 75], [1.5, 2, 72]]) put(lead, at + b, l, m, 0.42);
    if (beat) {
      put(kick, at, 0.4, 36, 0.9);
      put(kick, at + 1.75, 0.4, 36, 0.7);
      put(kick, at + 2.5, 0.4, 36, 0.8);
      put(snare, at + 1, 0.4, 38, 0.75);
      put(snare, at + 3, 0.4, 38, 0.75);
      for (let i = 0; i < 8; i += 1) put(hat, at + i * 0.5, 0.15, 42, i % 2 ? 0.24 : 0.4);
    }
  });
  return p;
}

// 3 — 최근 업템포 댄스. 촘촘한 리듬과 동시 보이스 수가 시험된다

function dancePop() {
  const p = createEmptyProject('데모 3 — 업템포 댄스 (최근)');
  p.tempo.bpm = 128;
  p.lengthBars = LENGTH_BARS;
  p.key = { tonic: 'A', mode: 'minor' };

  const prog = [
    { root: 57, q: 'min' }, { root: 65, q: 'maj' },
    { root: 60, q: 'maj' }, { root: 67, q: 'maj' },
  ];
  const saw = makeTrack(p, { name: '슈퍼소우', instrumentId: 'supersaw-lead', gain: 0.3 });
  const pluck = makeTrack(p, { name: '플럭', instrumentId: 'synth-pluck', gain: 0.36, pan: -0.3 });
  const bell = makeTrack(p, { name: '벨', instrumentId: 'glockenspiel', gain: 0.24, pan: 0.35 });
  const pad = makeTrack(p, { name: '패드', instrumentId: 'synth-pad', gain: 0.2 });
  const sub = makeTrack(p, { name: '서브', instrumentId: 'sub-bass', gain: 0.6 });
  const bass = makeTrack(p, { name: '신스 베이스', instrumentId: 'synth-bass', gain: 0.36 });
  const kick = makeTrack(p, { name: '킥', instrumentId: 'kick', gain: 0.85 });
  const clap = makeTrack(p, { name: '클랩', instrumentId: 'clap', gain: 0.46, effects: [reverb(0.18)] });
  const hat = makeTrack(p, { name: '하이햇', instrumentId: 'hihat', gain: 0.22, pan: 0.2 });
  const open = makeTrack(p, { name: '오픈햇', instrumentId: 'hihat-open', gain: 0.2, pan: -0.2 });

  const HOOK = [
    [[0, 0.5, 69], [0.5, 0.5, 72], [1, 0.5, 76], [1.5, 0.5, 72], [2, 1.5, 69]],
    [[0, 0.5, 72], [0.5, 0.5, 77], [1, 1, 81], [2, 1.5, 77]],
    [[0, 0.5, 76], [0.5, 0.5, 79], [1, 0.5, 84], [1.5, 0.5, 79], [2, 1.5, 76]],
    [[0, 1, 74], [1, 1, 71], [2, 2, 67]],
  ];

  sections([
    { name: '인트로', bars: [0, 2], four: false, hook: false, dense: false },
    { name: '벌스1', bars: [2, 5], four: true, hook: false, dense: false },
    { name: '프리', bars: [5, 6], four: true, hook: false, dense: true },
    { name: '드롭1', bars: [6, 9], four: true, hook: true, dense: true },
    { name: '벌스2', bars: [9, 11], four: true, hook: false, dense: false },
    { name: '드롭2', bars: [11, 14], four: true, hook: true, dense: true },
    { name: '브릿지', bars: [14, 15], four: false, hook: false, dense: false },
    { name: '아웃트로', bars: [15, 16], four: true, hook: true, dense: true },
  ], prog, ({ at, step, bar, four, hook, dense }) => {
    const c = chord(step.root, step.q);
    arpeggio(pluck, at, c, [0, 1, 2, 1, 2, 0, 1, 2], 0.5, dense ? 0.55 : 0.38);
    if (dense) putChord(pad, at, 4, c.map((m) => m + 12), 0.3);
    put(sub, at, 3.9, step.root - 24, 0.85);
    for (let i = 0; i < 8; i += 1) {
      if (i % 2 && !dense) continue;
      put(bass, at + i * 0.5, 0.4, step.root - 12, i % 2 ? 0.34 : 0.5);
    }
    if (hook) {
      for (const [b, l, m] of HOOK[bar % 4]) {
        put(saw, at + b, l, m, 0.55);
        put(bell, at + b, Math.min(l, 0.5), m + 12, 0.3);
      }
    }
    if (four) {
      for (let i = 0; i < 4; i += 1) put(kick, at + i, 0.35, 36, i ? 0.85 : 0.95);
      put(clap, at + 1, 0.3, 39, 0.7);
      put(clap, at + 3, 0.3, 39, 0.7);
    }
    const hats = dense ? 8 : 4;
    for (let i = 0; i < hats; i += 1) put(hat, at + (i * 4) / hats, 0.12, 42, i % 2 ? 0.24 : 0.4);
    if (dense) put(open, at + 3.5, 0.4, 46, 0.35);
  });
  return p;
}

// 4 — 팝 록 밴드. **없는 악기가 가장 크게 드러나는 편성이다** (심벌·앰프)

function popRock() {
  const p = createEmptyProject('데모 4 — 팝 록 (밴드 편성)');
  p.tempo.bpm = 138;
  p.lengthBars = LENGTH_BARS;
  p.key = { tonic: 'G', mode: 'major' };

  const prog = [
    { root: 67, q: 'maj' }, { root: 62, q: 'maj' },
    { root: 64, q: 'min' }, { root: 60, q: 'maj' },
  ];
  const rhythm = makeTrack(p, { name: '리듬 기타', instrumentId: 'electric-guitar-lp', gain: 0.4, pan: -0.45 });
  const rhythm2 = makeTrack(p, { name: '리듬 기타 2', instrumentId: 'electric-guitar', gain: 0.36, pan: 0.45 });
  const lead = makeTrack(p, { name: '리드 기타', instrumentId: 'electric-guitar', gain: 0.34, pan: 0.15, effects: [reverb(0.2)] });
  const organ = makeTrack(p, { name: '오르간', instrumentId: 'synth-organ', gain: 0.22 });
  const bass = makeTrack(p, { name: '베이스', instrumentId: 'electric-bass', gain: 0.62 });
  const kick = makeTrack(p, { name: '킥', instrumentId: 'kick', gain: 0.8, effects: [comp(-16, 4)] });
  const snare = makeTrack(p, { name: '스네어', instrumentId: 'snare', gain: 0.62, effects: [reverb(0.22), comp(-14, 4)] });
  const hat = makeTrack(p, { name: '하이햇', instrumentId: 'hihat', gain: 0.26, pan: 0.3 });
  // **크래시 심벌이 없다.** 오픈햇으로 대신한다 — 구간이 바뀌는 자리를 표시는 한다
  const crash = makeTrack(p, { name: '크래시(오픈햇 대용)', instrumentId: 'hihat-open', gain: 0.3 });
  const tom = makeTrack(p, { name: '탐', instrumentId: 'tom', gain: 0.4 });

  sections([
    { name: '인트로', bars: [0, 2], drums: false, big: false, solo: false },
    { name: '벌스1', bars: [2, 6], drums: true, big: false, solo: false },
    { name: '후렴1', bars: [6, 9], drums: true, big: true, solo: false },
    { name: '벌스2', bars: [9, 12], drums: true, big: false, solo: false },
    { name: '기타 솔로', bars: [12, 14], drums: true, big: true, solo: true },
    { name: '후렴2', bars: [14, 16], drums: true, big: true, solo: false },
  ], prog, ({ at, step, bar, drums, big, solo }) => {
    const c = chord(step.root, step.q);
    // 8분음표 백킹 — 두 대를 좌우로 벌린다 (더블 트래킹 흉내)
    for (let i = 0; i < 8; i += 1) {
      const v = big ? (i % 2 ? 0.42 : 0.58) : (i % 2 ? 0.3 : 0.42);
      putChord(rhythm, at + i * 0.5, 0.45, [c[0], c[1] ?? c[0], c[2] ?? c[0]], v);
      putChord(rhythm2, at + i * 0.5, 0.45, [c[0] + 12, c[2] ?? c[0]], v * 0.9);
    }
    if (big) putChord(organ, at, 4, c.map((m) => m + 12), 0.3);
    for (let i = 0; i < 4; i += 1) put(bass, at + i, 0.9, step.root - 24, i ? 0.7 : 0.85);
    if (solo) {
      const line = [[0, 0.5, 79], [0.5, 0.5, 83], [1, 0.5, 86], [1.5, 0.5, 83], [2, 1, 79], [3, 1, 81]];
      for (const [b, l, m] of line) put(lead, at + b, l, m, 0.55);
    }
    if (drums) {
      put(kick, at, 0.4, 36, 0.92);
      put(kick, at + 2, 0.4, 36, 0.85);
      if (big) put(kick, at + 2.75, 0.35, 36, 0.7);
      put(snare, at + 1, 0.4, 38, 0.8);
      put(snare, at + 3, 0.4, 38, 0.8);
      for (let i = 0; i < 8; i += 1) put(hat, at + i * 0.5, 0.15, 42, i % 2 ? 0.26 : 0.42);
      // 구간 첫 마디에 심벌 자리
      if (bar % 4 === 0 && big) put(crash, at, 1.2, 46, 0.55);
      // 필인
      if (bar % 8 === 7) {
        for (let i = 0; i < 4; i += 1) put(tom, at + 3 + i * 0.25, 0.2, 45 + i * 2, 0.6);
      }
    }
  });
  return p;
}

// 5 — 재즈/보사노바. 스윙과 주법이 시험된다. 라이드·브러시가 없다

function jazzBossa() {
  const p = createEmptyProject('데모 5 — 재즈 보사노바');
  p.tempo.bpm = 124;
  p.lengthBars = LENGTH_BARS;
  p.key = { tonic: 'F', mode: 'major' };
  p.swing = 0.32;

  const prog = [
    { root: 65, q: 'maj7' }, { root: 60, q: 'dom7' },
    { root: 62, q: 'min7' }, { root: 67, q: 'min7' },
  ];
  const guitar = makeTrack(p, { name: '재즈 기타', instrumentId: 'archtop-jazz-guitar', gain: 0.46, pan: -0.25 });
  const rhodes = makeTrack(p, { name: '로즈', instrumentId: 'electric-piano-rhodes', gain: 0.34, pan: 0.25, effects: [reverb(0.16)] });
  const bass = makeTrack(p, { name: '더블베이스', instrumentId: 'double-bass-pizz', gain: 0.62 });
  const vibes = makeTrack(p, { name: '비브라폰', instrumentId: 'vibraphone', gain: 0.3, pan: 0.3, effects: [reverb(0.25)] });
  // **라이드 심벌·브러시 스네어가 없다.** 하이햇과 림샷으로 근사한다
  const ride = makeTrack(p, { name: '라이드(하이햇 대용)', instrumentId: 'hihat', gain: 0.22, pan: 0.2 });
  const rim = makeTrack(p, { name: '림샷', instrumentId: 'rimshot', gain: 0.3 });
  const shaker = makeTrack(p, { name: '셰이커', instrumentId: 'shaker', gain: 0.2, pan: -0.3 });

  sections([
    { name: '헤드1', bars: [0, 4], mel: true, comp: true },
    { name: '헤드2', bars: [4, 8], mel: true, comp: true },
    { name: '솔로', bars: [8, 12], mel: false, comp: true },
    { name: '헤드3', bars: [12, 16], mel: true, comp: true },
  ], prog, ({ at, step, bar, mel }) => {
    const c = chord(step.root, step.q);
    // 보사 컴핑 — 당김음이 이 장르의 문법이다
    putChord(guitar, at + 0.5, 0.9, c.map((m) => m + 12), 0.5);
    putChord(guitar, at + 2, 0.6, c.map((m) => m + 12), 0.42);
    putChord(guitar, at + 3.25, 0.7, c.map((m) => m + 12), 0.46);
    putChord(rhodes, at + 1.5, 1.2, c.map((m) => m + 12), 0.3);
    // 걷는 베이스
    const walk = [step.root - 24, step.root - 24 + 7, step.root - 24 + 5, step.root - 24 + 3];
    walk.forEach((m, i) => put(bass, at + i, 0.9, m, i ? 0.62 : 0.75));
    if (mel) {
      const line = [[0, 1.5, 77], [1.5, 0.5, 76], [2, 1, 72], [3, 1, 74]];
      for (const [b, l, m] of line) put(vibes, at + b, l, m, 0.4);
    }
    for (let i = 0; i < 4; i += 1) {
      put(ride, at + i, 0.12, 42, i % 2 ? 0.26 : 0.4);
      put(ride, at + i + 0.66, 0.1, 42, 0.2);
    }
    put(rim, at + 1.5, 0.15, 37, 0.4);
    put(rim, at + 3.5, 0.15, 37, 0.4);
    for (let i = 0; i < 8; i += 1) put(shaker, at + i * 0.5, 0.1, 70, i % 2 ? 0.18 : 0.28);
    if (bar % 8 === 7) put(rim, at + 3.75, 0.15, 37, 0.5);
  });
  return p;
}

// ---------------------------------------------------------------------------

const registry = await loadAllInstruments();
const wasmBytes = await readFile(R('../src/generated/dsp.wasm'));
const outDir = R('../out');
mkdirSync(outDir, { recursive: true });

const SONGS = [ballad, midtempoRnb, dancePop, popRock, jazzBossa];

for (const build of SONGS) {
  const project = build();
  const notes = project.tracks.reduce(
    (s, t) => s + t.clips.reduce((a, c) => a + c.notes.length, 0), 0,
  );
  const withEffects = project.tracks.filter((t) => t.effects.length > 0).length;

  const engines = async () => {
    const list = [];
    for (let i = 0; i < project.tracks.length; i += 1) {
      list.push(await WasmVoiceEngine.create(wasmBytes, SAMPLE_RATE));
    }
    return list;
  };
  const render = async () => renderProjectOffline(project, registry, {
    sampleRate: SAMPLE_RATE, rng: seededRng(), tailSec: 3, wasm: await engines(),
  }).pcm;

  process.stdout.write(`${project.name} 렌더 중…\n`);
  const started = process.hrtime.bigint();
  let pcm = await render();
  const renderSec = Number(process.hrtime.bigint() - started) / 1e9;

  // 넘치면 화면의 "마스터 내리기" 와 같은 계산으로 맞춘 뒤 다시 뽑는다
  const clip = reportClipping(peakAmplitude([pcm]), project.master.gain);
  if (clip) {
    project.master.gain = clip.suggestedGain;
    pcm = await render();
  }

  const peak = peakAmplitude([pcm]);
  const seconds = pcm.length / SAMPLE_RATE;
  const safe = project.name.replace(/[^\w가-힣]+/g, '-')
    + (SAMPLE_RATE === 48000 ? '' : `-${Math.round(SAMPLE_RATE / 1000)}k`);
  writeFileSync(`${outDir}/${safe}.wav`, encodeWav([pcm], { sampleRate: SAMPLE_RATE, bitDepth: 24 }));
  writeFileSync(`${outDir}/${safe}.json`, serializeProject(project));

  console.log(project.name);
  console.log(`  ${project.tempo.bpm}BPM · ${project.lengthBars}마디 · ${seconds.toFixed(1)}초`
    + ` · 트랙 ${project.tracks.length} · 음 ${notes}개 · 이펙트 건 트랙 ${withEffects}개`);
  console.log(`  피크 ${(20 * Math.log10(peak)).toFixed(2)}dBFS`
    + (clip ? ` (마스터 ${clip.reductionDb.toFixed(1)}dB 내림)` : ' (그대로)')
    + ` · 렌더 ${renderSec.toFixed(1)}초 = 실시간의 ${(seconds / renderSec).toFixed(1)}배속`);
}

/**
 * 데모 6 — **80년대 펑크 팝** (마이클 잭슨 "빌리 진" 계열).
 *
 * ## 왜 하필 이 곡인가
 *
 * 앞의 다섯 곡(`SONGCRAFT.md`)은 장르를 벌려 **폭**을 봤다. 이번은 반대로,
 * **잘 알려진 한 곡이 요구하는 것을 이 도구가 다 내주는가**를 본다.
 * 기준점이 유명하면 부족한 곳이 인상이 아니라 이름으로 나온다 —
 * "뭔가 심심하다" 가 아니라 "게이트 스네어가 없다" 로.
 *
 * 이 편곡이 도구에 요구하는 것은 대략 이렇다:
 *
 *   - 4/4 킥이 처음부터 끝까지 쉬지 않는다 → 저역 헤드룸이 계속 눌린다
 *   - 스네어가 **짧게 끊긴 큰 잔향**을 쓴다 (게이트 리버브) → 게이트가 필요
 *   - 베이스가 곡 전체를 끌고 간다 → 베이스 음색과 저역 분리가 그대로 드러난다
 *   - 16분 하이햇이 쉬지 않는다 → 미세한 세기·타이밍 변화가 없으면 기계가 된다
 *   - 뮤트 기타가 16분 뒷박을 친다 → 주법(뮤트)이 필요
 *   - 편성이 거의 안 변한다 → **오토메이션 없이는 곡이 전개되지 않는다**
 *
 * ## 표절이 아니다
 *
 * 원곡의 음을 옮겨 적지 않았다. 베이스 리프·멜로디·화성 진행은 **같은 어법으로
 * 새로 썼다** (F#단조, 117BPM, 당김음 베이스 오스티나토). 목적이 "저 곡을 복제하는
 * 것"이 아니라 **"저런 곡을 만들려 할 때 이 도구의 어디가 막히는가"** 이기 때문에,
 * 어법만 같으면 목적은 그대로 달성된다. 원곡(1982)은 아직 저작권이 살아 있다.
 *
 * ## 산출물
 *
 *   out/데모-6-....wav        모노·이펙트 없음 (Node 렌더 경로의 한계)
 *   out/데모-6-....json       앱에서 열면 스테레오·이펙트 포함으로 들린다
 *   out/stems-데모-6/*.wav    트랙별 스템 — 어느 트랙이 문제인지 재려고
 *
 * 실행: node --experimental-strip-types tools/song-billiejean.mjs
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
const { integratedLufs, truePeakDbfs } = await import(R('../src/audio/quality.ts'));
const { resolveInstrument } = await import(R('../src/instruments/resolve.ts'));
const { applySidechainDuck, setVolumeAutomation } = await import(R('../src/editor/edits.ts'));

const rateArg = process.argv.indexOf('--rate');
const SAMPLE_RATE = rateArg >= 0 ? Number(process.argv[rateArg + 1]) : 48000;
const STEMS = process.argv.includes('--stems');
/**
 * `--balance` — **게인 스테이징을 자동으로 다시 잡고 다시 렌더한다.**
 *
 * 진단을 증명하려고 만든 것이다. 첫 렌더에서 베이스 스템이 −10.5 LUFS, 하이햇이
 * −46 LUFS 로 **35dB** 벌어져 있었다. 악기 자체는 고역이 충분한데(하이햇 스템은
 * 자기 중역 대비 +36dB) 믹스에서 묻혀서 곡 전체가 어두워진 것이다.
 *
 * 트랙마다 목표 라우드니스를 주고 스템을 재서 게인을 역산한다. 이게 통하면
 * "엔진이 못 내는 소리"가 아니라 **"기본 게인이 악기마다 안 맞춰져 있다"** 가 된다.
 */
const BALANCE = process.argv.includes('--balance');

/** 역할별 목표 라우드니스(LUFS). 보통의 팝 믹스에서 각 요소가 앉는 자리 */
const TARGET_LUFS = {
  '킥': -20, '스네어 (게이트 흉내)': -22, '하이햇': -30, '오픈햇': -32,
  '셰이커': -34, '탐 (필인)': -28, '크래시 (오픈햇 대용)': -30,
  '신스 베이스': -19, '서브': -24, '뮤트 기타': -26, '로즈': -28,
  '패드': -27, '리드 (보컬 대용)': -20,
};
const BEAT = PPQ;
const BAR = 4 * PPQ;
const BARS = 24;

/**
 * **막힌 것을 코드에서 바로 적는다.** 나중에 기억으로 복원하면 빠뜨린다 —
 * 대용품을 고르는 그 순간이 부족함이 드러나는 순간이다.
 */
const GAPS = [];
const gap = (what, wanted, used) => { GAPS.push({ what, wanted, used }); };

// ---------------------------------------------------------------------------
// 화성 — F#단조. 벌스는 한 화음 벰프, 후렴만 움직인다 (이 어법의 전형)

const F1 = 30; // F#1
const CHORD = { min: [0, 3, 7], min7: [0, 3, 7, 10], maj: [0, 4, 7], maj7: [0, 4, 7, 11] };
const chord = (root, q) => CHORD[q].map((i) => root + i);

/** 벌스: F#m 한 화음. 후렴: F#m – Bm7 – D – E */
const VERSE = [{ root: F1, q: 'min', hi: 54 }];
const CHORUS = [
  { root: F1, q: 'min', hi: 54 },
  { root: F1 + 5, q: 'min7', hi: 59 },
  { root: F1 + 8, q: 'maj', hi: 62 },
  { root: F1 + 10, q: 'maj', hi: 64 },
];

/**
 * 베이스 오스티나토 — 8분 기반에 당김음.
 * `[박, 길이, 근음으로부터의 반음, 세기]`. 이 어법의 뼈대는 **쉬지 않는 8분**과
 * 마디 끝의 옥타브 도약이다.
 */
const BASS_RIFF = [
  [0.0, 0.42, 0, 0.95], [0.5, 0.42, 0, 0.70],
  [1.0, 0.42, 12, 0.82], [1.5, 0.42, 0, 0.68],
  [2.0, 0.42, 3, 0.88], [2.5, 0.42, 0, 0.70],
  [3.0, 0.42, 7, 0.84], [3.75, 0.30, 10, 0.78],
];

/** 후렴 보컬 대용 리드 — F#단조 5음계 */
const HOOK = [
  [[0, 0.75, 66], [0.75, 0.5, 69], [1.5, 1.0, 73], [3.0, 1.0, 71]],
  [[0, 0.5, 69], [0.5, 0.5, 71], [1.0, 1.5, 66], [3.0, 0.75, 64]],
  [[0, 0.75, 62], [0.75, 0.75, 66], [1.5, 1.5, 69], [3.25, 0.75, 71]],
  [[0, 0.5, 71], [0.5, 0.5, 73], [1.0, 2.0, 76], [3.5, 0.5, 73]],
];

// ---------------------------------------------------------------------------

function makeTrack(project, { name, instrumentId, toneId, gain = 0.34, pan = 0, effects = [] }) {
  const track = createTrack({ name, instrumentId, toneId });
  track.gain = gain;
  track.pan = pan;
  track.effects = effects;
  const clip = createClip({ startTick: 0, lengthTick: project.lengthBars * BAR, label: name });
  track.clips.push(clip);
  project.tracks.push(track);
  return clip;
}

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

/** `makeTrack` 이 클립을 돌려주므로, 트랙 id 가 필요할 땐 이걸로 거슬러 올라간다 */
const trackOf = (project, clip) => project.tracks.find((t) => t.clips.includes(clip));

const reverb = (mix, decaySec, dampingHz) => {
  const e = createEffect('reverb');
  e.params.mix = mix;
  if (decaySec !== undefined) e.params.decaySec = decaySec;
  if (dampingHz !== undefined) e.params.dampingHz = dampingHz;
  return e;
};
const comp = (thresholdDb, ratio, attackMs, releaseMs) => {
  const e = createEffect('compressor');
  e.params.thresholdDb = thresholdDb;
  e.params.ratio = ratio;
  if (attackMs !== undefined) e.params.attackMs = attackMs;
  if (releaseMs !== undefined) e.params.releaseMs = releaseMs;
  return e;
};
const eq = (lowGainDb, midGainDb, highGainDb, midHz = 1000) => {
  const e = createEffect('eq');
  e.params.lowGainDb = lowGainDb;
  e.params.midGainDb = midGainDb;
  e.params.highGainDb = highGainDb;
  e.params.midHz = midHz;
  return e;
};

// ---------------------------------------------------------------------------

function build() {
  let p = createEmptyProject('데모 6 — 80년대 펑크 팝');
  p.tempo.bpm = 117;
  p.lengthBars = BARS;
  p.key = { tonic: 'F#', mode: 'minor' };

  // --- 리듬 -------------------------------------------------------------
  const kick = makeTrack(p, { name: '킥', instrumentId: 'kick', gain: 0.85, effects: [comp(-14, 4, 2, 120)] });

  // 게이트 리버브: 잔향을 크게 걸고 **짧게 끊는** 것이 이 시대 스네어의 정체다.
  // 끊는 것(게이트)이 없어 decay 를 짧게 잡는 것으로만 흉내 낸다 — 꼬리가 부드럽게
  // 사라져서 그 "퍽!" 하고 잘리는 느낌이 안 난다
  gap('게이트 스네어', '노이즈 게이트 (잔향을 크게 걸고 짧게 끊기)', '리버브 decaySec 0.35 로 근사');
  const snare = makeTrack(p, {
    name: '스네어 (게이트 흉내)', instrumentId: 'snare', gain: 0.62,
    effects: [reverb(0.42, 0.35, 6000), comp(-12, 6, 1, 90)],
  });

  const hat = makeTrack(p, { name: '하이햇', instrumentId: 'hihat', toneId: '짧게', gain: 0.24, pan: 0.22 });
  const open = makeTrack(p, { name: '오픈햇', instrumentId: 'hihat-open', gain: 0.2, pan: -0.18 });
  const shaker = makeTrack(p, { name: '셰이커', instrumentId: 'shaker', gain: 0.16, pan: -0.3 });
  const tom = makeTrack(p, { name: '탐 (필인)', instrumentId: 'tom', gain: 0.42 });

  gap('크래시 심벌', '구간이 바뀌는 자리의 크래시', 'hihat-open 으로 대용 (SONGCRAFT 2번과 같은 문제)');
  const crash = makeTrack(p, { name: '크래시 (오픈햇 대용)', instrumentId: 'hihat-open', gain: 0.26 });

  // --- 저음 -------------------------------------------------------------
  const bass = makeTrack(p, {
    name: '신스 베이스', instrumentId: 'synth-bass', gain: 0.55,
    effects: [comp(-18, 3, 12, 140), eq(2, 1.5, -2, 700)],
  });
  const sub = makeTrack(p, { name: '서브', instrumentId: 'sub-bass', gain: 0.3 });

  // --- 화성 -------------------------------------------------------------
  gap('뮤트 기타 (팜뮤트)', '16분 뒷박을 짧게 긁는 주법', '음 길이를 0.1박으로 줄여 흉내 — 톤은 그대로라 계속 같은 소리');
  const gtr = makeTrack(p, {
    name: '뮤트 기타', instrumentId: 'electric-guitar', toneId: '클린', gain: 0.3, pan: -0.42,
    effects: [eq(-4, 2, 1, 1600)],
  });
  const rhodes = makeTrack(p, {
    name: '로즈', instrumentId: 'electric-piano-rhodes', gain: 0.26, pan: 0.35,
    effects: [reverb(0.16, 1.4, 4000)],
  });
  const pad = makeTrack(p, { name: '패드', instrumentId: 'synth-pad', gain: 0.16, effects: [reverb(0.3, 2.4, 3000)] });

  gap('보컬', '리드 보컬 — 이 곡의 주인공', 'synth-lead 로 대용. 보컬 없이 "그 곡 같다" 는 성립하지 않는다');
  const lead = makeTrack(p, {
    name: '리드 (보컬 대용)', instrumentId: 'synth-lead', gain: 0.28, pan: 0.1,
    effects: [reverb(0.24, 1.8, 5000)],
  });

  gap('딜레이', '리드·기타에 거는 8분 딜레이 — 이 시대 사운드의 기본', '없음. 리버브로만 공간을 만듦');

  // -----------------------------------------------------------------------
  // 구간. **편성이 거의 안 변하는 곡**이라 오토메이션 부재가 특히 크게 걸린다

  const SECTIONS = [
    { name: '인트로',   bars: [0, 2],   prog: VERSE,  bass: false, gtr: false, chord: false, hook: false, big: false },
    { name: '인트로2',  bars: [2, 4],   prog: VERSE,  bass: true,  gtr: false, chord: false, hook: false, big: false },
    { name: '벌스1',    bars: [4, 8],   prog: VERSE,  bass: true,  gtr: true,  chord: false, hook: false, big: false },
    { name: '후렴1',    bars: [8, 12],  prog: CHORUS, bass: true,  gtr: true,  chord: true,  hook: true,  big: true },
    { name: '벌스2',    bars: [12, 16], prog: VERSE,  bass: true,  gtr: true,  chord: true,  hook: false, big: false },
    { name: '후렴2',    bars: [16, 20], prog: CHORUS, bass: true,  gtr: true,  chord: true,  hook: true,  big: true },
    { name: '브릿지',   bars: [20, 22], prog: CHORUS, bass: true,  gtr: true,  chord: true,  hook: false, big: false },
    { name: '아웃트로', bars: [22, 24], prog: CHORUS, bass: true,  gtr: true,  chord: true,  hook: true,  big: true },
  ];

  for (const s of SECTIONS) {
    for (let bar = s.bars[0]; bar < s.bars[1]; bar += 1) {
      const at = bar * 4;
      const step = s.prog[(bar - s.bars[0]) % s.prog.length];
      const c = chord(step.hi, step.q);

      // 킥 — 4/4. 쉬지 않는다
      for (let i = 0; i < 4; i += 1) put(kick, at + i, 0.35, 36, i === 0 ? 0.95 : 0.86);
      // 후렴에서만 당김 킥 하나를 더해 밀도를 올린다 (오토메이션 대신 쓰는 수단)
      if (s.big) put(kick, at + 3.5, 0.3, 36, 0.66);

      // 스네어 — 2·4
      put(snare, at + 1, 0.4, 38, 0.82);
      put(snare, at + 3, 0.4, 38, 0.84);

      // 16분 하이햇. **세기를 4단으로 흔든다** — 안 그러면 기계가 된다
      for (let i = 0; i < 16; i += 1) {
        const accent = i % 4 === 0 ? 0.42 : i % 2 === 0 ? 0.28 : 0.2;
        put(hat, at + i * 0.25, 0.1, 42, accent * (s.big ? 1.15 : 1));
      }
      if (s.big) put(open, at + 3.75, 0.3, 46, 0.32);
      for (let i = 0; i < 8; i += 1) put(shaker, at + i * 0.5, 0.1, 70, i % 2 ? 0.16 : 0.26);

      // 구간 첫 마디 크래시
      if (bar === s.bars[0] && s.big) put(crash, at, 1.4, 46, 0.5);
      // 8마디마다 탐 필인
      if (bar % 8 === 7) {
        for (let i = 0; i < 4; i += 1) put(tom, at + 3 + i * 0.25, 0.2, 45 + i * 2, 0.55 + i * 0.06);
      }

      // 베이스 — 곡을 끌고 가는 축
      if (s.bass) {
        for (const [b, l, semi, v] of BASS_RIFF) put(bass, at + b, l, step.root + semi, v);
        // 서브는 근음만 길게 받친다. 리프를 그대로 겹치면 저역이 뭉갠다.
        //
        // **한 옥타브 아래(`step.root - 12`)로 찍었다가 되돌렸다.** F#1 의 한 옥타브
        // 아래는 MIDI 18 = 23Hz 로, `sub-bass` 음역 하한(21) 밖이고 사람이 못 듣는다.
        // 게다가 이 악기는 `synthSubLevel: 1` 이라 거기서 또 한 옥타브를 더 내린다.
        // 들리지도 않으면서 헤드룸만 먹었다 — 그런데 **도구는 아무 말도 안 했다**
        // (`SONGCRAFT.md` C 항)
        put(sub, at, 3.6, step.root, 0.7);
      }

      // 뮤트 기타 — 16분 뒷박만
      if (s.gtr) {
        for (let i = 0; i < 8; i += 1) {
          const beat = at + i * 0.5 + 0.25;
          putChord(gtr, beat, 0.1, [c[0], c[1] ?? c[0]], i % 2 ? 0.34 : 0.44);
        }
      }

      // 화성 — 로즈 스탭 + 패드
      if (s.chord) {
        putChord(rhodes, at + 0.5, 0.4, c.map((m) => m + 12), 0.46);
        putChord(rhodes, at + 2.5, 0.4, c.map((m) => m + 12), 0.4);
        putChord(pad, at, 4, c.map((m) => m + 12), s.big ? 0.4 : 0.28);
      }

      // 훅
      if (s.hook) {
        for (const [b, l, m] of HOOK[(bar - s.bars[0]) % HOOK.length]) put(lead, at + b, l, m, 0.5);
      }
    }
  }

  // --- 오토메이션 — 킥에 맞춘 덕킹 + 아웃트로 페이드 -------------------------
  //
  // `ROADMAP.md` 항목 2. 킥 노트온마다 미리 계산한 볼륨 곡선을 베이스·서브·패드에
  // 굳힌다 — 재생 중 오디오를 분석하는 컴프레서가 아니라서 결과가 항상 같다.
  const kickId = trackOf(p, kick).id;
  p = applySidechainDuck(p, kickId, trackOf(p, bass).id, { depth: 0.35, attackMs: 15, releaseMs: 130 });
  p = applySidechainDuck(p, kickId, trackOf(p, sub).id, { depth: 0.45, attackMs: 15, releaseMs: 160 });
  p = applySidechainDuck(p, kickId, trackOf(p, pad).id, { depth: 0.5, attackMs: 20, releaseMs: 220 });

  // 아웃트로(22~24마디)에 걸쳐 서서히 뺀다. 덕킹이 이미 걸린 세 트랙은 여기서
  // 안 건드린다 — 오토메이션 레인 하나가 target 하나만 표현하므로, 지금은
  // 트랙 하나에 페이드와 덕킹을 같이 얹는 것을 다음 스코프로 미룬다
  const outroStartTick = 22 * 4 * PPQ;
  const songEndTick = BARS * 4 * PPQ;
  for (const c of [kick, snare, hat, open, shaker, tom, crash, gtr, rhodes, lead]) {
    p = setVolumeAutomation(p, trackOf(p, c).id, [
      { tick: outroStartTick, value: 1 },
      { tick: songEndTick, value: 0.12 },
    ]);
  }

  return p;
}

// ---------------------------------------------------------------------------

const registry = await loadAllInstruments();
const wasmBytes = await readFile(R('../src/generated/dsp.wasm'));
const outDir = R('../out');
mkdirSync(outDir, { recursive: true });

const project = build();
const noteCount = project.tracks.reduce(
  (s, t) => s + t.clips.reduce((a, c) => a + c.notes.length, 0), 0,
);

// **작곡 검산 — 음역을 벗어난 음이 있는가.**
// 서브 트랙이 MIDI 18(≈23Hz) 을 치고 있었다. sub-bass 음역 하한은 21 인데
// 아무도 막지 않았고 경고도 없었다. 앱에도 이 검사가 없다
{
  const bad = [];
  for (const track of project.tracks) {
    const inst = resolveInstrument(track.instrumentId, registry);
    const lo = inst?.range?.low, hi = inst?.range?.high;
    if (lo === undefined || hi === undefined) continue;
    for (const c of track.clips) {
      for (const n of c.notes) {
        const m = n.pitch.midi;
        if (m < lo || m > hi) bad.push({ track: track.name, midi: m, lo, hi });
      }
    }
  }
  if (bad.length > 0) {
    const byTrack = new Map();
    for (const b of bad) byTrack.set(b.track, { ...b, n: (byTrack.get(b.track)?.n ?? 0) + 1 });
    console.log('\x1b[33m음역 벗어난 음\x1b[0m');
    for (const [t, b] of byTrack) console.log(`  ${t}: ${b.n}개 (예: MIDI ${b.midi}, 음역 ${b.lo}~${b.hi})`);
    console.log();
  }
}

const engines = async (n) => {
  const list = [];
  for (let i = 0; i < n; i += 1) list.push(await WasmVoiceEngine.create(wasmBytes, SAMPLE_RATE));
  return list;
};
const render = async (proj) => renderProjectOffline(proj, registry, {
  sampleRate: SAMPLE_RATE, rng: seededRng(), tailSec: 3,
  wasm: await engines(proj.tracks.length),
}).pcm;

process.stdout.write(`${project.name} — ${project.tempo.bpm}BPM · ${BARS}마디 · `
  + `트랙 ${project.tracks.length} · 음 ${noteCount}개\n렌더 중…\n`);

const started = process.hrtime.bigint();
let pcm = await render(project);
const renderSec = Number(process.hrtime.bigint() - started) / 1e9;

const clip = reportClipping(peakAmplitude([pcm]), project.master.gain);
if (clip) {
  project.master.gain = clip.suggestedGain;
  pcm = await render(project);
}

const seconds = pcm.length / SAMPLE_RATE;
const safe = project.name.replace(/[^\w가-힣]+/g, '-');
writeFileSync(`${outDir}/${safe}.wav`, encodeWav([pcm], { sampleRate: SAMPLE_RATE, bitDepth: 24 }));
writeFileSync(`${outDir}/${safe}.json`, serializeProject(project));

console.log(`\n${seconds.toFixed(1)}초 · 렌더 ${renderSec.toFixed(1)}초 (실시간의 ${(seconds / renderSec).toFixed(1)}배속)`);
console.log(`피크 ${(20 * Math.log10(peakAmplitude([pcm]))).toFixed(2)}dBFS`
  + ` · 트루피크 ${truePeakDbfs(pcm).toFixed(2)}dBTP`
  + ` · ${integratedLufs([pcm], SAMPLE_RATE).toFixed(1)} LUFS`
  + (clip ? ` (마스터 ${clip.reductionDb.toFixed(1)}dB 내림)` : ' (그대로)'));

// --- 트랙별 스템 — 어느 트랙이 어디를 차지하는지 -----------------------------
if (STEMS) {
  const stemDir = `${outDir}/stems-${safe}`;
  mkdirSync(stemDir, { recursive: true });
  console.log('\n트랙별 스템');
  for (const track of project.tracks) {
    const solo = { ...project, tracks: [track], master: { ...project.master, gain: 1 } };
    const s = await render(solo);
    const name = track.name.replace(/[^\w가-힣]+/g, '-');
    writeFileSync(`${stemDir}/${name}.wav`, encodeWav([s], { sampleRate: SAMPLE_RATE, bitDepth: 24 }));
    console.log(`  ${track.name.padEnd(20)} 피크 ${(20 * Math.log10(peakAmplitude([s]))).toFixed(1).padStart(6)}dBFS`
      + ` · ${integratedLufs([s], SAMPLE_RATE).toFixed(1).padStart(6)} LUFS`);
  }
  console.log(`  → ${stemDir}/`);
}

// --- 게인 스테이징을 다시 잡아 본다 -----------------------------------------
//
// **진단을 증명하려는 것이다.** 원인이 "엔진이 어두운 소리를 낸다" 인지
// "게인이 안 맞아 밝은 것들이 묻힌 것" 인지 여기서 갈린다
if (BALANCE) {
  console.log('\n\x1b[1m게인 스테이징 재조정\x1b[0m — 스템을 재서 목표 라우드니스로 역산');
  const tuned = { ...project, tracks: project.tracks.map((t) => ({ ...t })), master: { ...project.master, gain: 1 } };
  console.log('  트랙                   측정 LUFS → 목표    게인 변화');
  for (const track of tuned.tracks) {
    const target = TARGET_LUFS[track.name];
    if (target === undefined) continue;
    const solo = { ...tuned, tracks: [track], master: { ...tuned.master, gain: 1 } };
    const measured = integratedLufs([await render(solo)], SAMPLE_RATE);
    if (!Number.isFinite(measured)) continue;
    const before = track.gain;
    // 라우드니스는 게인에 비례하므로 dB 차이를 그대로 게인 비로 옮긴다
    track.gain = Math.min(4, before * 10 ** ((target - measured) / 20));
    console.log(`  ${track.name.padEnd(22)}${measured.toFixed(1).padStart(6)} → ${String(target).padStart(4)}`
      + `    ${before.toFixed(2)} → ${track.gain.toFixed(2)}`
      + `  (${((20 * Math.log10(track.gain / before)) >= 0 ? '+' : '')}${(20 * Math.log10(track.gain / before)).toFixed(1)}dB)`);
  }

  let tpcm = await render(tuned);
  const tclip = reportClipping(peakAmplitude([tpcm]), tuned.master.gain);
  if (tclip) {
    tuned.master.gain = tclip.suggestedGain;
    tpcm = await render(tuned);
  }
  tuned.name = `${project.name} (밸런스 조정)`;
  const tsafe = tuned.name.replace(/[^\w가-힣]+/g, '-');
  writeFileSync(`${outDir}/${tsafe}.wav`, encodeWav([tpcm], { sampleRate: SAMPLE_RATE, bitDepth: 24 }));
  writeFileSync(`${outDir}/${tsafe}.json`, serializeProject(tuned));
  console.log(`\n  조정 후: 피크 ${(20 * Math.log10(peakAmplitude([tpcm]))).toFixed(2)}dBFS`
    + ` · ${integratedLufs([tpcm], SAMPLE_RATE).toFixed(1)} LUFS`
    + (tclip ? ` (마스터 ${tclip.reductionDb.toFixed(1)}dB 내림)` : ' \x1b[32m(마스터 손 안 댐)\x1b[0m'));
  console.log(`  → ${outDir}/${tsafe}.wav`);
}

// --- 만들면서 막힌 것 -------------------------------------------------------
console.log(`\n\x1b[1m이 곡을 만들면서 막힌 것 ${GAPS.length}가지\x1b[0m`);
for (const g of GAPS) {
  console.log(`  \x1b[1m${g.what}\x1b[0m`);
  console.log(`    필요: ${g.wanted}`);
  console.log(`    대신: ${g.used}`);
}
console.log();

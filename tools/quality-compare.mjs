/**
 * A/B 비교 — **우리 소리와 다른 앱 소리를 같은 자로 잰다.**
 *
 *     node --experimental-strip-types tools/quality-compare.mjs 우리.wav 그쪽.wav
 *     ... --label-a "RESONA" --label-b "Logic Pro"
 *     ... --hz 440            # 조성 악기면 기본파를 알려 주면 음정·THD 도 잰다
 *     ... --blind out/        # 라우드니스를 맞춰 무작위 이름으로 뽑는다 (청취용)
 *
 * ## 이 도구가 지키는 것 하나
 *
 * **먼저 라우드니스를 맞춘다.** 0.5dB 만 커도 사람은 "음질이 낫다"고 답한다.
 * 라우드니스를 안 맞춘 비교는 음질이 아니라 음량을 비교한 것이고, 그렇게 나온
 * 결론은 전부 버려야 한다. 그래서 여기서는 **맞추기 전 값과 맞춘 뒤 값을 모두**
 * 보여 준다 — 얼마나 맞췄는지가 그 자체로 정보다.
 *
 * ## 여기서 답하는 것 / 답하지 않는 것
 *
 * 답한다: 어느 쪽이 더 깨끗한가(THD+N·잡음), 더 큰가(LUFS), 더 밝은가(무게중심),
 *         더 빠른가(어택), 클리핑 위험이 있는가(트루 피크), 음정이 맞는가.
 * 답하지 않는다: **어느 쪽이 더 진짜 같은가.** 그건 귀로만 판정된다
 *         (`sound.md` 11-3). `--blind` 가 그 청취를 준비해 준다.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { argv } from 'node:process';

import { decodeWav } from '../src/audio/wav.ts';
import {
  attackMs,
  dbfs,
  integratedLufs,
  matchLoudness,
  octaveBands,
  preciseCentsError,
  rms,
  spectralCentroidHz,
  stereoCorrelation,
  thdPlusN,
  truePeakDbfs,
} from '../src/audio/quality.ts';
import { encodeWav } from '../src/audio/wav.ts';

const positional = [];
const args = new Map();
for (let i = 2; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    args.set(argv[i].slice(2), argv[i + 1] ?? true);
    i += 1;
  } else positional.push(argv[i]);
}

if (positional.length < 2) {
  console.error('사용법: quality-compare.mjs A.wav B.wav [--label-a 이름] [--label-b 이름] [--hz 440]');
  process.exit(1);
}

const labelA = args.get('label-a') ?? 'A';
const labelB = args.get('label-b') ?? 'B';
const fundamentalHz = args.get('hz') ? Number(args.get('hz')) : null;
const TARGET_LUFS = Number(args.get('lufs') ?? -18);

async function load(path) {
  const { channels, sampleRate } = decodeWav(await readFile(path));
  return { channels, sampleRate, path };
}

const a = await load(positional[0]);
const b = await load(positional[1]);

if (a.sampleRate !== b.sampleRate) {
  // **리샘플링을 몰래 하지 않는다.** 리샘플러의 품질이 비교 결과에 섞여 들어가고,
  // 그러면 무엇을 재고 있는지 알 수 없게 된다
  console.error(
    `표본율이 다르다: ${labelA}=${a.sampleRate}Hz, ${labelB}=${b.sampleRate}Hz\n` +
      '같은 표본율로 다시 내보내 주세요. 여기서 변환하면 리샘플러 품질이 결과에 섞인다.',
  );
  process.exit(1);
}

const FS = a.sampleRate;
const mono = (ch) => (ch.length === 1 ? ch[0] : Float32Array.from(ch[0], (v, i) => (v + ch[1][i]) / 2));

function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i += 1) p = Math.max(p, Math.abs(x[i]));
  return p;
}

function measure(file, matched) {
  const m = mono(matched);
  const head = m.subarray(0, Math.min(m.length, FS));
  return {
    seconds: m.length / FS,
    channels: file.channels.length,
    peakDbfs: dbfs(peakOf(m)),
    truePeakDbtp: truePeakDbfs(head),
    rmsDbfs: dbfs(rms(m)),
    lufsRaw: integratedLufs(file.channels, FS),
    lufs: integratedLufs(matched, FS),
    centroidHz: spectralCentroidHz(m, FS),
    attackMs: attackMs(m, FS),
    stereoCorr: file.channels.length > 1 ? stereoCorrelation(file.channels[0], file.channels[1]) : 1,
    centsError: fundamentalHz ? preciseCentsError(m, fundamentalHz, FS) : null,
    thdPlusNDb: fundamentalHz ? thdPlusN(head, fundamentalHz, FS).thdPlusNDb : null,
    bands: octaveBands(m, FS),
  };
}

// **정합이 먼저다.** 여기서 어긋나면 아래 숫자 전부가 음량 비교가 된다
const ma = matchLoudness(a.channels, TARGET_LUFS, FS);
const mb = matchLoudness(b.channels, TARGET_LUFS, FS);
const ra = measure(a, ma.channels);
const rb = measure(b, mb.channels);

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 1) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(d)).padStart(11);

console.log('');
console.log(`A = ${labelA}  (${a.path})`);
console.log(`B = ${labelB}  (${b.path})`);
console.log(`표본율 ${FS}Hz · 라우드니스 ${TARGET_LUFS} LUFS 로 정합`);
console.log('='.repeat(72));

// 정합에 얼마나 들었는지 먼저 — 20dB 를 키웠다면 애초에 성립 안 하는 비교였다
console.log(
  pad('원래 라우드니스', 22) + num(ra.lufsRaw) + num(rb.lufsRaw) + '   LUFS',
);
console.log(
  pad('정합에 쓴 이득', 22) + num(ma.gainDb) + num(mb.gainDb) + '   dB',
);
if (Math.abs(ma.gainDb - mb.gainDb) > 12) {
  console.log('  ⚠ 두 파일의 원래 음량 차이가 12dB 를 넘는다 — 녹음 조건부터 다르다는 뜻이다');
}
console.log('-'.repeat(72));

const rows = [
  ['길이(초)', ra.seconds, rb.seconds, 2, ''],
  ['채널', ra.channels, rb.channels, 0, ''],
  ['피크', ra.peakDbfs, rb.peakDbfs, 1, 'dBFS'],
  ['트루 피크', ra.truePeakDbtp, rb.truePeakDbtp, 2, 'dBTP  (권장 -1 이하)'],
  ['RMS', ra.rmsDbfs, rb.rmsDbfs, 1, 'dBFS'],
  ['어택', ra.attackMs, rb.attackMs, 1, 'ms  (10%→90%)'],
  ['스펙트럼 무게중심', ra.centroidHz, rb.centroidHz, 0, 'Hz  (밝기)'],
  ['스테레오 상관', ra.stereoCorr, rb.stereoCorr, 3, '  (1=모노, 음수=모노에서 사라짐)'],
];
if (fundamentalHz) {
  rows.push(['음정 오차', ra.centsError, rb.centsError, 3, '센트  (기준 ±1)']);
  rows.push(['THD+N', ra.thdPlusNDb, rb.thdPlusNDb, 1, 'dB  (낮을수록 깨끗)']);
}

for (const [name, va, vb, digits, unit] of rows) {
  console.log(pad(name, 22) + num(va, digits) + num(vb, digits) + '   ' + unit);
}

// --- 음색 차이 ---------------------------------------------------------------

console.log('');
console.log('옥타브 밴드 차이 (B − A, 양수면 B 가 그 대역이 더 많다)');
console.log('-'.repeat(72));
for (let i = 0; i < ra.bands.length; i += 1) {
  const diff = rb.bands[i].db - ra.bands[i].db;
  const width = Math.max(-24, Math.min(24, diff));
  const bar =
    width >= 0
      ? ' '.repeat(24) + '█'.repeat(Math.round(width))
      : ' '.repeat(24 - Math.round(-width)) + '█'.repeat(Math.round(-width));
  console.log(`${String(ra.bands[i].centerHz).padStart(6)}Hz ${diff.toFixed(1).padStart(7)}dB ${bar}`);
}

// --- 판정 --------------------------------------------------------------------

console.log('');
console.log('숫자가 말해 주는 것');
console.log('-'.repeat(72));
const notes = [];
if (fundamentalHz) {
  if (Math.abs(ra.centsError) < Math.abs(rb.centsError) - 0.5) {
    notes.push(`음정은 ${labelA} 가 더 정확하다 (${ra.centsError.toFixed(2)} vs ${rb.centsError.toFixed(2)}센트)`);
  } else if (Math.abs(rb.centsError) < Math.abs(ra.centsError) - 0.5) {
    notes.push(`음정은 ${labelB} 가 더 정확하다 (${rb.centsError.toFixed(2)} vs ${ra.centsError.toFixed(2)}센트)`);
  } else {
    notes.push('음정 정확도는 사실상 같다');
  }
}
const brighter = ra.centroidHz > rb.centroidHz ? labelA : labelB;
const ratio = Math.max(ra.centroidHz, rb.centroidHz) / Math.max(1, Math.min(ra.centroidHz, rb.centroidHz));
if (ratio > 1.15) notes.push(`${brighter} 가 더 밝다 (무게중심 ${ratio.toFixed(2)}배)`);
else notes.push('밝기는 비슷하다');

for (const r of [[labelA, ra], [labelB, rb]]) {
  if (r[1].truePeakDbtp > -1) {
    notes.push(`⚠ ${r[0]} 는 트루 피크가 ${r[1].truePeakDbtp.toFixed(2)}dBTP — mp3/AAC 변환에서 깎인다`);
  }
  if (r[1].stereoCorr < 0) {
    notes.push(`⚠ ${r[0]} 는 스테레오 상관이 음수 — 모노로 합치면 소리가 지워진다`);
  }
}
for (const n of notes) console.log(`  · ${n}`);

console.log('');
console.log('※ 여기까지가 숫자로 답할 수 있는 부분이다.');
console.log('  **어느 쪽이 더 진짜 같은가는 답하지 않는다** — 그건 귀로만 판정된다.');
console.log('  `--blind out/` 로 라우드니스를 맞춰 무작위 이름으로 뽑을 수 있다.');

// --- 블라인드 청취 준비 -------------------------------------------------------

if (typeof args.get('blind') === 'string') {
  const dir = args.get('blind');
  await mkdir(dir, { recursive: true });

  // **파일명으로 정답을 알 수 없어야 한다.** 어느 쪽이 우리 것인지 알면
  // 그 시점에 블라인드가 아니고, 그러면 결과는 선입견을 잰 것이다
  const coin = Math.random() < 0.5;
  const names = ['sample-1.wav', 'sample-2.wav'];
  const files = coin
    ? [{ n: names[0], m: ma, l: labelA }, { n: names[1], m: mb, l: labelB }]
    : [{ n: names[0], m: mb, l: labelB }, { n: names[1], m: ma, l: labelA }];

  for (const f of files) {
    await writeFile(`${dir}/${f.n}`, encodeWav(f.m.channels, { sampleRate: FS, bitDepth: 24 }));
  }
  // 정답은 따로. 듣기 전에 열어 보지 않도록 파일을 나눈다
  await writeFile(
    `${dir}/ANSWER.txt`,
    files.map((f) => `${f.n} = ${f.l} (정합 이득 ${f.m.gainDb.toFixed(2)}dB)`).join('\n') + '\n',
  );

  console.log('');
  console.log(`블라인드 파일을 ${dir} 에 뽑았다:`);
  console.log(`  ${names.join(', ')}  — 라우드니스 ${TARGET_LUFS} LUFS 로 정합됨`);
  console.log('  ANSWER.txt 는 **다 듣고 나서** 열어라.');
}

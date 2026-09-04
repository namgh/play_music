/**
 * 저음이 실제로 들어 있는가 — **귀 대신 숫자로.**
 *
 * "우퍼가 울리나" 는 두 개의 다른 질문이다. 이 도구는 둘을 나눈다.
 *
 *   1. **뻗침(extension)** — 가장 낮은 곳에 에너지가 있는가.
 *      서브베이스가 30Hz 를 내는데 20Hz 에서 잘려 있으면 큰 스피커에서만
 *      들리는 성분이 아예 없다는 뜻이다.
 *   2. **균형(balance)** — 저음이 중음 대비 얼마나 큰가.
 *      뻗침이 있어도 −30dB 로 묻혀 있으면 "베이스가 없다" 로 들린다.
 *
 * `octaveBands` 는 중심 31.25Hz 가 최하단이라 서브 영역이 한 칸에 뭉친다.
 * 여기서는 그 아래를 3분할해 **어디서 잘리는지**가 보이게 한다.
 *
 *     node --experimental-strip-types tools/lowend.mjs out/*.wav
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';

import { decodeWav } from '../src/audio/wav.ts';
import { spectrum, binToHz, dbfs, integratedLufs } from '../src/audio/quality.ts';

/**
 * 밴드 경계. 저역은 좁게, 고역은 옥타브로.
 * 20Hz 아래는 사람이 못 듣고 스피커도 못 내므로 자른다.
 */
const BANDS = [
  { name: '20–31', lo: 20, hi: 31.5, tag: '초저역 (큰 우퍼만)' },
  { name: '31–45', lo: 31.5, hi: 45, tag: '서브 (가슴으로 느낌)' },
  { name: '45–63', lo: 45, hi: 63, tag: '서브 (킥의 몸통)' },
  { name: '63–90', lo: 63, hi: 90, tag: '베이스 기음' },
  { name: '90–125', lo: 90, hi: 125, tag: '베이스 상단' },
  { name: '125–250', lo: 125, hi: 250, tag: '저중역 (따뜻함)' },
  { name: '250–500', lo: 250, hi: 500, tag: '중역 하단' },
  { name: '500–1k', lo: 500, hi: 1000, tag: '중역' },
  { name: '1k–2k', lo: 1000, hi: 2000, tag: '중고역 (존재감)' },
  { name: '2k–4k', lo: 2000, hi: 4000, tag: '선명도' },
  { name: '4k–8k', lo: 4000, hi: 8000, tag: '공기감' },
  { name: '8k–16k', lo: 8000, hi: 16000, tag: '최고역' },
];

/**
 * 파일 전체를 한 번에 FFT 하면 창이 너무 길어 순간의 저음이 평균에 묻힌다.
 * 겹치는 프레임으로 나눠 **파워를 누적**한다 (평균 스펙트럼).
 */
function averageBandPower(x, sampleRate) {
  const size = 16384;
  const hop = size / 2;
  const power = new Float64Array(BANDS.length);
  let frames = 0;
  for (let start = 0; start + size <= x.length; start += hop) {
    const mag = spectrum(x.subarray(start, start + size), size);
    for (let k = 1; k < mag.length; k += 1) {
      const hz = binToHz(k, sampleRate, size);
      const b = BANDS.findIndex((band) => hz >= band.lo && hz < band.hi);
      if (b >= 0) power[b] += mag[k] * mag[k];
    }
    frames += 1;
  }
  if (frames === 0) return BANDS.map(() => -Infinity);
  return Array.from(power, (p) => 10 * Math.log10(Math.max(p / frames, 1e-30)));
}

const bar = (db, peak) => {
  // 피크 밴드 대비 −60dB 까지를 40칸에 그린다
  const n = Math.max(0, Math.min(40, Math.round(((db - peak + 60) / 60) * 40)));
  return '█'.repeat(n) + '·'.repeat(40 - n);
};

const files = argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('사용법: node --experimental-strip-types tools/lowend.mjs <wav...>');
  process.exit(1);
}

for (const file of files) {
  const bytes = await readFile(file);
  const { channels, sampleRate } = decodeWav(new Uint8Array(bytes));
  // 모노 합으로 본다 — 저음은 대개 가운데에 있고, 밴드 균형은 합에서 판정한다
  const mono = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < mono.length; i += 1) mono[i] += ch[i] / channels.length;

  const db = averageBandPower(mono, sampleRate);
  const peak = Math.max(...db);
  const mid = db[BANDS.findIndex((b) => b.name === '500–1k')];

  const name = file.split('/').pop();
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  console.log(`  ${(mono.length / sampleRate).toFixed(1)}초 · ${channels.length}채널 · ${sampleRate}Hz`
    + ` · ${integratedLufs(channels, sampleRate).toFixed(1)} LUFS`);
  console.log('  밴드         중역대비   그래프');
  for (let i = 0; i < BANDS.length; i += 1) {
    const rel = db[i] - mid;
    const flag = BANDS[i].hi <= 125 && rel < -25 ? ' ← 비었음' : '';
    console.log(`  ${BANDS[i].name.padEnd(9)} ${rel >= 0 ? '+' : ''}${rel.toFixed(1).padStart(6)}dB  `
      + `${bar(db[i], peak)} ${BANDS[i].tag}${flag}`);
  }

  // 뻗침 — 중역 대비 −20dB 이상 나오는 가장 낮은 밴드
  const lowest = BANDS.find((b, i) => db[i] - mid > -20);
  console.log(`  \x1b[1m뻗침\x1b[0m: 중역 −20dB 안에 드는 가장 낮은 밴드 = ${lowest ? lowest.name : '없음'} Hz`);
}
console.log();

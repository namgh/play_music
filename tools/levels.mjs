/**
 * 악기별 출력 레벨 — **같은 세기로 쳤을 때 악기마다 얼마나 큰가.**
 *
 * ## 왜 재는가
 *
 * 데모 곡 여섯 개 중 셋이 마스터를 6~7dB 내려야 했다 (`SONGCRAFT.md` 8번).
 * "트랙을 많이 쓰면 넘친다" 로 읽었는데, 스템을 떠 보니 **베이스 트랙 하나가
 * 단독으로 +4.8dBFS** 였다. 트랙 수의 문제가 아니라 **악기마다 기본 음량이
 * 제각각인 문제**다.
 *
 * 악기가 데이터인 이상(`CLAUDE.md` 확정 6번) 음량 정규화도 데이터여야 한다.
 * 지금은 그 값이 없어서, 사용자가 악기를 바꿀 때마다 페이더를 다시 잡아야 한다.
 *
 * ## 무엇을 재는가
 *
 * 트랙 게인 1.0, 세기 0.8, 중간 음역에서 음 하나. **피크와 LUFS 를 같이** 본다 —
 * 피크는 클리핑을, LUFS 는 사람이 느끼는 크기를 말한다. 둘이 다르게 움직이면
 * (드럼처럼) 정규화 기준을 무엇으로 잡을지가 갈린다.
 *
 *     node --experimental-strip-types tools/levels.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { WasmVoiceEngine } from '../src/audio/voice/wasmEngine.ts';
import { loadAllInstruments, playableInstrumentIds } from '../src/instruments/definitions.ts';
import { instrumentParams, resolveInstrument } from '../src/instruments/resolve.ts';
import { VOICE_KIND_INDEX } from '../src/instruments/types.ts';
import { integratedLufs } from '../src/audio/quality.ts';

const FS = 48000;
const BLOCK = 128;
const SECONDS = 2.5;
const VELOCITY = 0.8;

const registry = await loadAllInstruments();
const wasmPath = fileURLToPath(new URL('../src/generated/dsp.wasm', import.meta.url));
const wasm = await WasmVoiceEngine.create(await readFile(wasmPath), FS);
const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** 그 악기의 음역 한가운데. 음역 밖에서 재면 악기 탓이 아닌 값이 나온다 */
function midMidi(instrument) {
  const low = instrument.range?.low ?? 36;
  const high = instrument.range?.high ?? 84;
  return Math.round((low + high) / 2);
}

function renderNote(instrumentId) {
  const instrument = resolveInstrument(instrumentId, registry);
  const params = {
    ...instrumentParams(instrument, 'default', null),
    voiceKind: VOICE_KIND_INDEX[instrument.voice] ?? 0,
  };
  wasm.allOff();
  wasm.noteOn(midiToHz(midMidi(instrument)), VELOCITY, params, instrument.baseLevel);
  const total = Math.round(SECONDS * FS);
  const out = new Float32Array(total);
  const scratch = new Float32Array(BLOCK);
  for (let at = 0; at < total; at += BLOCK) {
    const frames = Math.min(BLOCK, total - at);
    scratch.fill(0);
    wasm.process(scratch, frames);
    out.set(scratch.subarray(0, frames), at);
  }
  return { pcm: out, category: instrument.category ?? '?', midi: midMidi(instrument) };
}

const rows = [];
for (const id of playableInstrumentIds(registry)) {
  let r;
  try {
    r = renderNote(id);
  } catch (e) {
    rows.push({ id, error: String(e.message ?? e) });
    continue;
  }
  let peak = 0;
  for (let i = 0; i < r.pcm.length; i += 1) peak = Math.max(peak, Math.abs(r.pcm[i]));
  rows.push({
    id,
    category: r.category,
    midi: r.midi,
    peakDb: 20 * Math.log10(Math.max(peak, 1e-9)),
    lufs: integratedLufs([r.pcm], FS),
  });
}

const ok = rows.filter((r) => !r.error);
ok.sort((a, b) => b.peakDb - a.peakDb);

console.log(`\n악기 ${ok.length}개 · 세기 ${VELOCITY} · 트랙 게인 1.0 · 각 악기 음역 중앙\n`);
console.log('  악기                  분류        음   피크dBFS    LUFS  판정');
for (const r of ok) {
  const verdict = r.peakDb > 0 ? '\x1b[31m클리핑\x1b[0m'
    : r.peakDb > -6 ? '\x1b[33m매우 큼\x1b[0m'
      : r.peakDb < -30 ? '\x1b[36m매우 작음\x1b[0m' : '';
  console.log(`  ${r.id.padEnd(22)}${String(r.category).padEnd(10)}${String(r.midi).padStart(4)}`
    + `${r.peakDb.toFixed(1).padStart(9)}${r.lufs.toFixed(1).padStart(9)}  ${verdict}`);
}
for (const r of rows.filter((x) => x.error)) console.log(`  ${r.id.padEnd(22)}\x1b[31m${r.error}\x1b[0m`);

const peaks = ok.map((r) => r.peakDb);
const lufs = ok.map((r) => r.lufs).filter((v) => Number.isFinite(v));
console.log(`\n  피크 범위 ${Math.min(...peaks).toFixed(1)} ~ ${Math.max(...peaks).toFixed(1)} dBFS`
  + `  \x1b[1m(퍼짐 ${(Math.max(...peaks) - Math.min(...peaks)).toFixed(1)}dB)\x1b[0m`);
console.log(`  LUFS 범위 ${Math.min(...lufs).toFixed(1)} ~ ${Math.max(...lufs).toFixed(1)}`
  + `  \x1b[1m(퍼짐 ${(Math.max(...lufs) - Math.min(...lufs)).toFixed(1)}dB)\x1b[0m`);
console.log(`  0dBFS 를 넘는 악기: ${ok.filter((r) => r.peakDb > 0).length}개\n`);

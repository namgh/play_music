/**
 * 예제 곡 — 열자마자 고칠 수 있는 상태여야 한다: 악기는 카탈로그에 있고, 음은 클립 안에,
 * 멜로디는 조 안에, 가사는 멜로디에, 합친 소리는 잘리지 않는다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { INSTRUMENT_CATALOG, loadAllInstruments } from '../instruments/definitions.ts';
import { WasmVoiceEngine } from '../audio/voice/wasmEngine.ts';
import { renderProjectOffline } from '../audio/offlineRender.ts';
import { peakAmplitude } from '../audio/wav.ts';
import { seededRng } from '../audio/analysis.ts';
import { roundTrip } from './persistence.ts';
import { isInScale } from './pitch.ts';
import { projectLengthTicks } from './factory.ts';
import { DEMO_SONGS, midiOf } from './songs.ts';

test('음이름 읽기', () => {
  assert.equal(midiOf('C4'), 60);
  assert.equal(midiOf('F#5'), 78);
  assert.equal(midiOf('A4'), 69);
});

for (const song of DEMO_SONGS) {
  test(`${song.name} — 구조: 악기·클립·조·가사`, () => {
    const p = song.build();
    assert.equal(p.tempo.bpm, song.bpm);
    assert.equal(p.lengthBars, song.bars);
    assert.deepEqual(p.key, song.key);
    const length = projectLengthTicks(p);
    const sections = p.sections ?? [];
    assert.equal(sections.reduce((n, s) => n + s.lengthTick, 0), length, '구간이 곡 전체를 덮는다');
    assert.ok((p.chords ?? []).length >= 8);
    for (const track of p.tracks) {
      assert.ok(INSTRUMENT_CATALOG.some((e) => e.id === track.instrumentId && !e.abstract), track.instrumentId);
      assert.ok(track.clips.length > 0, `${track.name}: 클립이 없다`);
      const drum = INSTRUMENT_CATALOG.find((e) => e.id === track.instrumentId)!.family === 'drum';
      for (const clip of track.clips) {
        assert.ok(sections.some((s) => s.startTick === clip.startTick && s.lengthTick === clip.lengthTick), '클립은 구간 하나와 겹친다');
        assert.equal(clip.origin, 'ai');
        for (const note of clip.notes) {
          assert.ok(note.startTick >= 0 && note.startTick + note.lengthTick <= clip.lengthTick, `${track.name}: 음이 클립 밖`);
          assert.ok(note.velocity > 0 && note.velocity <= 1);
          if (!drum) assert.ok(isInScale(note.pitch.midi, p.key), `${track.name}: ${note.pitch.midi} 는 조 밖`);
        }
      }
    }
    const melody = p.tracks[0]!;
    const sung = melody.clips.flatMap((c) => c.notes).filter((n) => n.lyric);
    assert.ok(sung.length >= 40, `가사 ${sung.length}자`);
    // 저장했다 다시 열어도 같다
    assert.deepEqual(roundTrip(p), p);
  });

  test(`${song.name} — 합친 소리가 잘리지 않는다`, async () => {
    const p = song.build();
    const registry = await loadAllInstruments();
    const bytes = await readFile(fileURLToPath(new URL('../generated/dsp.wasm', import.meta.url)));
    const engines = await Promise.all(p.tracks.map(() => WasmVoiceEngine.create(bytes, 48000)));
    const { pcm } = renderProjectOffline(p, registry, { sampleRate: 48000, rng: seededRng(), tailSec: 1, wasm: engines });
    const peak = peakAmplitude([pcm]);
    console.log(`   ${song.name}: 피크 ${(20 * Math.log10(peak)).toFixed(1)}dBFS`);
    assert.ok(peak <= 0.94, `피크 ${peak.toFixed(3)} — 잘린다`);
    assert.ok(peak > 0.25, `피크 ${peak.toFixed(3)} — 너무 작다`);
  });
}

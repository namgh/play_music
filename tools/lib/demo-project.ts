/**
 * 화면 시안·점검용 데모 곡 — "비 오는 새벽" (v5 시안 02 의 곡).
 *
 * 화면은 빈 곡에서 볼 게 없다. 트랙 다섯 개, 구간·마커·코드가 다 있는 곡을
 * **같은 코드로 매번 똑같이** 만들어 캡처가 결정적이게 한다 (무작위 없음 —
 * id 만 매번 다르고 화면에는 안 보인다).
 */

import { createClip, createEmptyProject, createNote, createTrack } from '../../src/model/factory.ts';
import { PPQ } from '../../src/model/time.ts';
import type { Project } from '../../src/model/project.ts';
import { addChord, addMarker, addSection } from '../../src/editor/arrangement.ts';

const BAR = 4 * PPQ;
const E8 = PPQ / 2;

/** 마디별 코드 (Am F C G 진행 두 번 + 브리지) */
const PROGRESSION: [string, 'min' | 'maj', number[]][] = [
  ['A', 'min', [57, 60, 64]], ['F', 'maj', [53, 57, 60]], ['C', 'maj', [55, 60, 64]], ['G', 'maj', [55, 59, 62]],
];

export function demoProject(bars = 16): Project {
  let project = createEmptyProject('비 오는 새벽');
  project.tempo.bpm = 92;
  project.key = { tonic: 'A', mode: 'minor' };
  project.lengthBars = bars;

  const kick = createTrack({ name: '킥', instrumentId: 'kick', color: 'j6' });
  const snare = createTrack({ name: '스네어', instrumentId: 'snare', color: 'j6' });
  const bass = createTrack({ name: '베이스', instrumentId: 'electric-bass', color: 'j2' });
  const guitar = createTrack({ name: '어쿠스틱 기타', instrumentId: 'acoustic-guitar', color: 'j1' });
  const keys = createTrack({ name: '로즈', instrumentId: 'electric-piano-rhodes', color: 'j3' });
  const pad = createTrack({ name: '패드', instrumentId: 'synth-pad', color: 'j4' });

  const clip = (track: typeof kick, fromBar: number, toBar: number, label: string, fill: (c: ReturnType<typeof createClip>, bar: number, chord: number[]) => void) => {
    const c = createClip({ startTick: fromBar * BAR, lengthTick: (toBar - fromBar) * BAR, label });
    for (let bar = fromBar; bar < toBar; bar++) fill(c, (bar - fromBar) * BAR, PROGRESSION[bar % 4]![2]);
    track.clips.push(c);
  };

  for (const [from, to, n] of [[0, 8, 1], [8, 16, 2]] as const) {
    clip(kick, from, to, `킥 ${n}`, (c, at) => {
      for (const beat of [0, 2.5, 3]) c.notes.push(createNote({ startTick: at + beat * PPQ, lengthTick: E8, midi: 36, velocity: beat === 0 ? 0.95 : 0.75 }));
    });
    clip(snare, from, to, `스네어 ${n}`, (c, at) => {
      for (const beat of [1, 3]) c.notes.push(createNote({ startTick: at + beat * PPQ, lengthTick: E8, midi: 38, velocity: 0.8 }));
    });
    clip(bass, from, to, `베이스 ${n}`, (c, at, chord) => {
      const root = chord[0]! - 24 + (chord[0]! < 55 ? 12 : 0);
      for (const [beat, off] of [[0, 0], [1.5, 0], [2, 7], [3, 12]] as const) {
        c.notes.push(createNote({ startTick: at + beat * PPQ, lengthTick: E8 * 1.5, midi: root + off, velocity: 0.8 }));
      }
    });
  }
  clip(guitar, 4, 16, '어쿠스틱', (c, at, chord) => {
    for (let i = 0; i < 8; i++) c.notes.push(createNote({ startTick: at + i * E8, lengthTick: E8, midi: chord[i % 3]! + 12, velocity: i % 2 ? 0.55 : 0.75 }));
  });
  clip(keys, 0, 16, '로즈', (c, at, chord) => {
    for (const midi of chord) c.notes.push(createNote({ startTick: at, lengthTick: BAR - E8, midi, velocity: 0.6 }));
  });
  clip(pad, 8, 16, '패드', (c, at, chord) => {
    c.notes.push(createNote({ startTick: at, lengthTick: BAR, midi: chord[0]! + 12, velocity: 0.5 }));
  });

  project.tracks.push(kick, snare, bass, guitar, keys, pad);

  project = addSection(project, { startTick: 0, lengthTick: 4 * BAR, name: '인트로' }).project;
  project = addSection(project, { startTick: 4 * BAR, lengthTick: 4 * BAR, name: '벌스' }).project;
  project = addSection(project, { startTick: 8 * BAR, lengthTick: 4 * BAR, name: '코러스' }).project;
  project = addSection(project, { startTick: 12 * BAR, lengthTick: 4 * BAR, name: '브리지' }).project;
  project = addMarker(project, 6 * BAR, '기타 들어옴').project;
  project = addMarker(project, 11 * BAR + 2 * PPQ, '필인').project;
  for (let bar = 0; bar < bars; bar++) {
    const [root, quality] = PROGRESSION[bar % 4]!;
    project = addChord(project, { tick: bar * BAR, root, quality }).project;
  }
  return project;
}

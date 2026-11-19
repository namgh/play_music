/**
 * 곡 구조 편집 · 박자 지도 · 코드 분석 회귀 테스트 (`LOGIC_PARITY.md` 1-4·1-11).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClip, createEmptyProject, createNote, createTrack, projectLengthTicks } from '../model/factory.ts';
import { barLines, barStartTick, beatsBetween, positionAt, signatureAtBar } from '../model/meter.ts';
import { analyzeChords, chordLabel, chordPitchClasses, guessChord, transposeChord } from '../model/chords.ts';
import { roundTrip } from '../model/persistence.ts';
import { PPQ } from '../model/time.ts';
import type { Project } from '../model/project.ts';
import { collectBeatEvents, collectNoteEvents } from '../audio/scheduler.ts';
import { setVolumeAutomation, updateTrack } from './edits.ts';
import {
  addChord, addMarker, addSection, adjacentMarkerTick, copyRange, deleteMarker, deleteSection, duplicateSection,
  insertTime, keyAt, moveSection, removeSectionMarker, removeTime, replaceChords, setKeyChange, setSignatureChange,
  swapSectionWithNeighbor, tapTempo, transposeChords, updateMarker, updateSection,
} from './arrangement.ts';

const BAR = 4 * PPQ;

/** 마디마다 클립 하나, 클립마다 그 마디 번호를 음높이로 가진 음 하나 — 위치를 음으로 읽을 수 있다 */
function song(bars = 4): Project {
  const project = createEmptyProject('구조 테스트');
  project.lengthBars = bars;
  const track = createTrack({ name: '피아노', instrumentId: 'acoustic-guitar' });
  for (let bar = 0; bar < bars; bar++) {
    const clip = createClip({ startTick: bar * BAR, lengthTick: BAR, label: `C${bar}` });
    clip.notes.push(createNote({ startTick: 0, lengthTick: PPQ, midi: 60 + bar }));
    track.clips.push(clip);
  }
  project.tracks.push(track);
  return project;
}

/** 곡 기준 시작 위치 → 음높이. 순서를 읽기 쉽게 */
function layout(project: Project): string {
  return project.tracks[0]!.clips
    .flatMap((c) => c.notes.map((n) => ({ at: (c.startTick + n.startTick) / BAR, midi: n.pitch.midi - 60 })))
    .sort((a, b) => a.at - b.at)
    .map((x) => `${x.at}:${x.midi}`)
    .join(' ');
}

// --- 박자 지도 ------------------------------------------------------------------

test('박자 변화가 없으면 예전 계산과 같다', () => {
  const p = song();
  assert.equal(barStartTick(p, 3), 3 * BAR);
  assert.deepEqual(positionAt(p, 3 * BAR + PPQ + 5), { bar: 3, beat: 1, tickInBeat: 5, barTick: 3 * BAR, timeSignature: { num: 4, den: 4 } });
  assert.equal(projectLengthTicks(p), 4 * BAR);
});

test('3/4 로 바뀌면 그 뒤 마디가 짧아진다', () => {
  const p = setSignatureChange(song(), 2, { num: 3, den: 4 });
  assert.deepEqual(signatureAtBar(p, 1), { num: 4, den: 4 });
  assert.deepEqual(signatureAtBar(p, 2), { num: 3, den: 4 });
  assert.equal(barStartTick(p, 2), 2 * BAR);
  assert.equal(barStartTick(p, 3), 2 * BAR + 3 * PPQ);
  assert.equal(positionAt(p, 2 * BAR + 3 * PPQ).bar, 3);
  assert.equal(projectLengthTicks(p), 2 * BAR + 2 * 3 * PPQ);
  const lines = barLines(p, 4);
  assert.deepEqual(lines.map((l) => [l.tick, l.changed]), [[0, false], [BAR, false], [2 * BAR, true], [2 * BAR + 3 * PPQ, false]]);
});

test('6/8 은 8분음표가 한 박이고 메트로놈 강박이 마디 첫 박에 온다', () => {
  const p = setSignatureChange(song(), 1, { num: 6, den: 8 });
  const beats = beatsBetween(p, BAR, BAR + 3 * PPQ);
  assert.equal(beats.length, 6);
  assert.deepEqual(beats.map((b) => b.accent), [true, false, false, false, false, false]);
  const clicks = collectBeatEvents(p, 0, BAR + 3 * PPQ + 1);
  assert.equal(clicks.filter((c) => c.accent).length, 3, '0·4/4 한 마디·6/8 두 마디의 첫 박');
});

test('구간 중간에서 시작해도 박을 놓치지 않는다', () => {
  const p = setSignatureChange(song(), 1, { num: 3, den: 4 });
  const beats = beatsBetween(p, PPQ * 3 + 1, BAR + 2 * PPQ);
  assert.deepEqual(beats.map((b) => b.tick), [BAR, BAR + PPQ]);
});

test('박자 변화 지우기 · 0번 마디는 곡 박자를 바꾼다', () => {
  let p = setSignatureChange(song(), 2, { num: 7, den: 8 });
  p = setSignatureChange(p, 2, null);
  assert.deepEqual(p.signatureChanges, []);
  p = setSignatureChange(p, 0, { num: 3, den: 4 });
  assert.deepEqual(p.timeSignature, { num: 3, den: 4 });
  assert.throws(() => setSignatureChange(p, 0, null));
});

// --- 마커 -------------------------------------------------------------------

test('마커 추가·이름·이동·삭제, 이전/다음 찾기', () => {
  let p = song();
  const a = addMarker(p, 2 * BAR, '후렴');
  p = a.project;
  const b = addMarker(p, BAR);
  p = b.project;
  assert.deepEqual(p.markers!.map((m) => m.name), ['마커 2', '후렴'], '틱 순서로 정렬');
  p = updateMarker(p, b.markerId, { name: '  ' });
  assert.equal(p.markers![0]!.name, '마커 2', '빈 이름으로 지우지 않는다');
  p = updateMarker(p, b.markerId, { tick: 3 * BAR, name: '끝' });
  assert.deepEqual(p.markers!.map((m) => m.name), ['후렴', '끝']);
  assert.equal(adjacentMarkerTick(p, 0, 1), 2 * BAR);
  assert.equal(adjacentMarkerTick(p, 2 * BAR, 1), 3 * BAR);
  assert.equal(adjacentMarkerTick(p, 3 * BAR, 1), null);
  assert.equal(adjacentMarkerTick(p, 3 * BAR, -1), 2 * BAR);
  p = deleteMarker(p, a.markerId);
  assert.deepEqual(p.markers!.map((m) => m.name), ['끝']);
});

// --- 구간 -------------------------------------------------------------------

test('구간은 겹치지 않는다', () => {
  let p = addSection(song(), { startTick: 0, lengthTick: 2 * BAR, name: '벌스' }).project;
  assert.throws(() => addSection(p, { startTick: BAR, lengthTick: BAR }), /겹친다/);
  const chorus = addSection(p, { startTick: 2 * BAR, lengthTick: 2 * BAR });
  p = chorus.project;
  assert.throws(() => updateSection(p, chorus.sectionId, { startTick: BAR }), /겹친다/);
  assert.equal(p.sections![1]!.name, '벌스', '기본 이름은 순서대로');
});

test('구간 복제 — 바로 뒤에 끼우고 뒤는 밀린다', () => {
  let p = song(4);
  const verse = addSection(p, { startTick: BAR, lengthTick: BAR, name: '벌스' });
  p = verse.project;
  p = addMarker(p, BAR + PPQ, '여기').project;
  p = addChord(p, { tick: BAR, root: 'A', quality: 'min' }).project;
  const { project: next, sectionId } = duplicateSection(p, verse.sectionId);

  assert.equal(layout(next), '0:0 1:1 2:1 3:2 4:3');
  assert.equal(next.lengthBars, 5);
  assert.deepEqual(next.sections!.map((s) => [s.name, s.startTick / BAR]), [['벌스', 1], ['벌스', 2]]);
  assert.notEqual(sectionId, verse.sectionId);
  assert.deepEqual(next.markers!.map((m) => m.tick), [BAR + PPQ, 2 * BAR + PPQ]);
  assert.deepEqual(next.chords!.map((c) => c.tick), [BAR, 2 * BAR]);
  const ids = next.tracks[0]!.clips.flatMap((c) => [c.id, ...c.notes.map((n) => n.id)]);
  assert.equal(new Set(ids).size, ids.length, '복제본이 새 id 를 받는다');
});

test('구간 삭제 — 안의 음악째 지우고 당긴다', () => {
  let p = song(4);
  const s = addSection(p, { startTick: BAR, lengthTick: 2 * BAR, name: '가운데' });
  p = setVolumeAutomation(s.project, p.tracks[0]!.id, [{ tick: 0, value: 1 }, { tick: BAR + 10, value: 0.5 }, { tick: 3 * BAR + 10, value: 0.2 }]);
  const next = deleteSection(p, s.sectionId);
  assert.equal(layout(next), '0:0 1:3');
  assert.deepEqual(next.sections, []);
  assert.deepEqual(next.tracks[0]!.automation[0]!.points.map((pt) => pt.tick), [0, BAR + 10]);
});

test('구간 이동 — 앞뒤 어느 쪽으로든, 다른 구간을 덮지 않는다', () => {
  let p = song(4);
  const a = addSection(p, { startTick: 0, lengthTick: BAR, name: 'A' });
  const b = addSection(a.project, { startTick: BAR, lengthTick: BAR, name: 'B' });
  const c = addSection(b.project, { startTick: 2 * BAR, lengthTick: 2 * BAR, name: 'C' });
  p = c.project;

  const back = moveSection(p, a.sectionId, 4 * BAR);
  assert.equal(layout(back), '0:1 1:2 2:3 3:0');
  assert.deepEqual(back.sections!.map((s) => s.name), ['B', 'C', 'A']);
  assert.equal(back.sections!.find((s) => s.name === 'A')!.id, a.sectionId, '이동은 id 를 유지한다');

  const forward = moveSection(p, c.sectionId, 0);
  assert.equal(layout(forward), '0:2 1:3 2:0 3:1');

  const swapped = swapSectionWithNeighbor(p, b.sectionId, -1);
  assert.deepEqual(swapped.sections!.map((s) => s.name), ['B', 'A', 'C']);
  assert.equal(layout(swapped), '0:1 1:0 2:2 3:3');
  assert.throws(() => swapSectionWithNeighbor(p, a.sectionId, -1), /앞에 구간이 없다/);
  assert.equal(moveSection(p, b.sectionId, BAR + 10), p, '제자리면 그대로');
});

test('구간 표시만 지우면 음악은 남는다', () => {
  const s = addSection(song(), { startTick: 0, lengthTick: BAR });
  const next = removeSectionMarker(s.project, s.sectionId);
  assert.equal(layout(next), layout(song()));
  assert.deepEqual(next.sections, []);
});

// --- 시간 넣기·빼기 ---------------------------------------------------------------

test('시간 넣기 — 걸친 클립은 나뉘고 뒤가 밀린다, 템포 변화도', () => {
  let p = song(2);
  p = { ...p, tempo: { bpm: 100, changes: [{ tick: BAR, bpm: 140 }] } };
  const next = insertTime(p, PPQ / 2, BAR);
  // 첫 음(0~PPQ)은 경계에 걸쳐 왼쪽 조각에 남는다 — 클립만 나뉜다
  assert.equal(layout(next), '0:0 2:1');
  assert.equal(next.tracks[0]!.clips.length, 3);
  assert.deepEqual(next.tempo.changes, [{ tick: 2 * BAR, bpm: 140 }]);
  assert.equal(next.lengthBars, 3);
});

test('시간 빼기 — 안의 것은 사라지고 걸친 구간은 줄어든다', () => {
  let p = song(4);
  p = addSection(p, { startTick: 0, lengthTick: 2 * BAR, name: '긴 구간' }).project;
  p = addMarker(p, BAR + 1).project;
  const next = removeTime(p, BAR, 2 * BAR);
  assert.equal(layout(next), '0:0 1:2 2:3');
  assert.deepEqual(next.sections!.map((s) => [s.startTick, s.lengthTick]), [[0, BAR]]);
  assert.deepEqual(next.markers, []);
});

test('범위 복사는 원본을 바꾸지 않는다', () => {
  const p = song(2);
  const snapshot = JSON.stringify(p);
  copyRange(p, PPQ / 2, BAR + PPQ / 2);
  insertTime(p, BAR, BAR);
  removeTime(p, 0, BAR);
  assert.equal(JSON.stringify(p), snapshot);
});

// --- 코드 -------------------------------------------------------------------

test('코드 표기와 구성음', () => {
  assert.equal(chordLabel({ root: 'A', quality: 'min7', bass: null }), 'Am7');
  assert.equal(chordLabel({ root: 'C', quality: 'maj', bass: 'E' }), 'C/E');
  assert.deepEqual(chordPitchClasses({ root: 'G', quality: '7' }), [7, 11, 2, 5]);
  assert.deepEqual(transposeChord({ root: 'A', bass: 'C#' }, 3), { root: 'C', bass: 'E' });
});

test('코드 알아내기 — 3화음·7화음·전위', () => {
  const w = (pcs: Record<number, number>) => Array.from({ length: 12 }, (_, i) => pcs[i] ?? 0);
  assert.deepEqual(guessChord(w({ 0: 1, 4: 1, 7: 1 }), 0), { root: 'C', quality: 'maj', bass: null, score: 1 });
  assert.equal(guessChord(w({ 9: 1, 0: 1, 4: 1 }), 9)!.quality, 'min');
  assert.equal(guessChord(w({ 7: 1, 11: 1, 2: 1, 5: 1 }), 7)!.quality, '7');
  const inv = guessChord(w({ 0: 1, 4: 1, 7: 1 }), 4)!;
  assert.deepEqual([inv.root, inv.bass], ['C', 'E']);
  assert.equal(guessChord(w({}), null), null);
});

test('음표에서 코드 진행 — 같은 코드는 묶고 뮤트한 클립은 뺀다', () => {
  const p = createEmptyProject('진행');
  const track = createTrack({ name: '피아노', instrumentId: 'acoustic-guitar' });
  const chords = [[60, 64, 67], [60, 64, 67], [57, 60, 64], [53, 57, 60]];
  chords.forEach((pcs, bar) => {
    const clip = createClip({ startTick: bar * BAR, lengthTick: BAR });
    for (const midi of pcs) clip.notes.push(createNote({ startTick: 0, lengthTick: BAR, midi }));
    track.clips.push(clip);
  });
  p.tracks.push(track);

  const found = analyzeChords(p, { stepTick: BAR, toTick: 4 * BAR });
  assert.deepEqual(found.map((c) => [c.tick / BAR, chordLabel(c)]), [[0, 'C'], [2, 'Am'], [3, 'F']]);

  track.clips[3]!.muted = true;
  assert.deepEqual(analyzeChords(p, { stepTick: BAR, toTick: 4 * BAR }).map((c) => chordLabel(c)), ['C', 'Am']);

  const replaced = replaceChords(p, found, { fromTick: 0, toTick: 4 * BAR });
  assert.equal(replaced.chords!.length, 3);
  assert.deepEqual(transposeChords(replaced, 2).chords!.map((c) => chordLabel(c)), ['D', 'Bm', 'G']);
});

test('같은 자리에 코드를 다시 놓으면 바꾼다', () => {
  let p = addChord(song(), { tick: 0, root: 'C', quality: 'maj' }).project;
  p = addChord(p, { tick: 0, root: 'D', quality: 'min' }).project;
  assert.deepEqual(p.chords!.map((c) => chordLabel(c)), ['Dm']);
});

// --- 조성·탭 템포 ------------------------------------------------------------------

test('조성 변화와 그 자리의 조성', () => {
  let p = setKeyChange(song(), 0, { tonic: 'C', mode: 'major' });
  p = setKeyChange(p, 2 * BAR, { tonic: 'A', mode: 'minor' });
  assert.equal(keyAt(p, BAR)!.tonic, 'C');
  assert.equal(keyAt(p, 2 * BAR)!.tonic, 'A');
  p = setKeyChange(p, 2 * BAR, null);
  assert.equal(keyAt(p, 3 * BAR)!.tonic, 'C');
});

test('탭 템포 — 중앙값, 2초 쉬면 새로 센다', () => {
  assert.equal(tapTempo([0]), null);
  assert.equal(tapTempo([0, 500, 1000, 1500]), 120);
  assert.equal(tapTempo([0, 500, 1000, 1700, 2200]), 120, '한 번 늦은 탭은 중앙값이 거른다');
  assert.equal(tapTempo([0, 300, 5000, 5600, 6200]), 100, '오래 쉰 앞의 탭은 버린다');
});

// --- 클립 뮤트·저장 ----------------------------------------------------------------

test('뮤트한 클립은 재생되지 않는다', () => {
  const p = song(2);
  p.tracks[0]!.clips[0]!.muted = true;
  const events = collectNoteEvents(p, 0, 2 * BAR);
  assert.deepEqual(events.map((e) => e.note.pitch.midi), [61]);
});

test('글로벌 트랙·템포 변화·스윙·클립 뮤트가 저장 왕복에서 살아남는다', () => {
  let p = song(4);
  p = { ...p, swing: 0.33, tempo: { bpm: 90, changes: [{ tick: 2 * BAR, bpm: 120 }] } };
  p = addMarker(p, BAR, '후렴').project;
  p = addSection(p, { startTick: 0, lengthTick: 2 * BAR, name: '벌스' }).project;
  p = addChord(p, { tick: 0, root: 'F#', quality: 'm7b5', bass: 'C' }).project;
  p = setSignatureChange(p, 3, { num: 5, den: 8 });
  p = setKeyChange(p, BAR, { tonic: 'E', mode: 'minor' });
  p = updateTrack(p, p.tracks[0]!.id, { gain: 0.5 });
  p.tracks[0]!.clips[1]!.muted = true;
  p.tracks[0]!.clips[1]!.color = 'j4';
  assert.deepEqual(roundTrip(p), p);
});

test('옛 파일(새 필드 없음)은 그대로 읽힌다', () => {
  const old = song(2);
  const back = roundTrip(old);
  assert.equal('markers' in back, false, '없던 키를 빈 배열로 만들지 않는다');
  assert.equal('swing' in back, false);
  assert.deepEqual(back, old);
});

// --- 카운트인 ---------------------------------------------------------------------

test('카운트인 — 시작 자리의 박자·템포로 한 마디', async () => {
  const { countInClicks, countInSeconds } = await import('../audio/scheduler.ts');
  let p = song(4);
  p = { ...p, tempo: { bpm: 120 } };
  assert.equal(countInSeconds(p, 0, 1), 2, '120BPM 4/4 한 마디 = 2초');
  assert.equal(countInSeconds(p, 0, 0), 0);
  p = setSignatureChange(p, 2, { num: 3, den: 4 });
  assert.equal(countInSeconds(p, 2 * BAR, 1), 1.5, '3/4 마디에서 시작하면 세 박');
  const clicks = countInClicks(p, 2 * BAR, 1.5);
  assert.deepEqual(clicks.map((c) => c.accent), [true, false, false]);
  assert.deepEqual(clicks.map((c) => c.atSec), [0, 0.5, 1]);
});

test('카운트인 동안 음은 곡 시작 뒤로 밀리고 박은 메트로놈 꺼져도 울린다', async () => {
  const { LookaheadScheduler: Scheduler } = await import('../audio/scheduler.ts');
  let now = 10;
  const notes: number[] = [];
  const clicks: number[] = [];
  const host = {
    now: () => now,
    scheduleNote: (_e: unknown, at: number) => { notes.push(at); },
    scheduleClick: (_c: unknown, at: number) => { clicks.push(at); },
  };
  const s = new Scheduler(host as never, { lookaheadSec: 0.2 });
  const p = { ...song(2), tempo: { bpm: 120 } };
  s.start(p, 0, 2);
  assert.deepEqual(clicks, [10, 10.5, 11, 11.5]);
  assert.equal(notes.length, 0, '카운트인 중에는 아직 음을 예약하지 않는다');
  assert.equal(s.positionTicks(), 0);
  now = 11.9;
  s.pump();
  assert.equal(notes[0], 12, '첫 음은 카운트인이 끝나는 순간');
});

test('템포 트랙 — 범위와 지점 옮기기', async () => {
  const { tempoRange, moveTempoChange } = await import('./arrangement.ts');
  const p = createEmptyProject('t');
  p.tempo = { bpm: 100, changes: [{ tick: 1920, bpm: 140 }] };
  assert.deepEqual(tempoRange(p), { min: 90, max: 150 });
  const moved = moveTempoChange(p, 1920, 3840, 132.34);
  assert.deepEqual(moved.tempo.changes, [{ tick: 3840, bpm: 132.3 }]);
  assert.equal(moveTempoChange(p, 0, 999, 96).tempo.bpm, 96);
});

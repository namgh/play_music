import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_SONGS } from '../model/songs.ts';
import { PPQ, ticksToSeconds } from '../model/time.ts';
import { roundTrip } from '../model/persistence.ts';
import { applyAiCommands, buildContext, describeCommand, describeTarget, parseAiReply, resolveTarget } from './edits.ts';

const song = () => DEMO_SONGS.find((s) => s.id === 'first-snow-night')!.build();
const melody = (p: ReturnType<typeof song>) => p.tracks[0]!;
const chorus = (p: ReturnType<typeof song>) => melody(p).clips.find((c) => c.label === '코러스')!;
const notesOf = (p: ReturnType<typeof song>, clipId: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!.notes;

test('대상 — 고른 음이 있으면 그것만, 없으면 클립 전체. 오디오 클립·없는 클립은 대상이 아니다', () => {
  const p = song(); const c = chorus(p);
  assert.equal(resolveTarget(p, null, []), null);
  const all = resolveTarget(p, c.id, [])!;
  assert.equal(all.noteIds.length, c.notes.length);
  assert.equal(all.partial, false);
  const some = resolveTarget(p, c.id, [c.notes[0]!.id, c.notes[1]!.id, 'not_other' as never])!;
  assert.deepEqual(some.noteIds, [c.notes[0]!.id, c.notes[1]!.id]);
  assert.equal(some.partial, true);
  assert.match(describeTarget(p, all), /코러스 · .* · 36음 · 17–24마디/);
});

test('맥락 — 음표와 코드만 나간다 (곡 id·에셋·계정 같은 것은 없다)', () => {
  const p = song(); const t = resolveTarget(p, chorus(p).id, [])!;
  const ctx = buildContext(p, t) as { song: { bpm: number; key: string }; target: { notes: unknown[]; chords: { chord: string }[]; fromBar: number } };
  assert.equal(ctx.song.bpm, 124);
  assert.equal(ctx.song.key, 'C major');
  assert.equal(ctx.target.notes.length, 36);
  assert.equal(ctx.target.fromBar, 17);
  assert.ok(ctx.target.chords.length >= 4);
  const text = JSON.stringify(ctx);
  assert.ok(!text.includes(p.id) && !text.includes('assetId') && !/not_|clp_|trk_/.test(text));
});

test('반음 올리기 — 고른 음만 오르고, 조에 맞추면 조 밖 음이 없다. 다른 음은 그대로', () => {
  const p = song(); const c = chorus(p);
  const ids = c.notes.slice(0, 5).map((n) => n.id);
  const t = resolveTarget(p, c.id, ids)!;
  const out = applyAiCommands(p, t, [{ type: 'transpose', semitones: 2, snapToKey: false }]).project;
  const after = notesOf(out, c.id);
  c.notes.forEach((n, i) => assert.equal(after[i]!.pitch.midi, n.pitch.midi + (i < 5 ? 2 : 0)));

  const snapped = applyAiCommands(p, resolveTarget(p, c.id, [])!, [{ type: 'transpose', semitones: 1, snapToKey: true }]).project;
  const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);
  for (const n of notesOf(snapped, c.id)) assert.ok(C_MAJOR.has(n.pitch.midi % 12), `조 밖: ${n.pitch.midi}`);
  // 원래 곡은 그대로다
  assert.equal(chorus(p).notes[0]!.pitch.midi, c.notes[0]!.pitch.midi);
});

test('템포 — 구간만 바꾸면 그 구간이 빨라지고, 끝난 뒤는 원래 템포로 돌아온다', () => {
  const p = song(); const c = chorus(p);
  const out = applyAiCommands(p, resolveTarget(p, c.id, [])!, [{ type: 'tempo', bpm: 132, scope: 'range' }]).project;
  assert.equal(out.tempo.bpm, 124);
  assert.deepEqual(out.tempo.changes, [{ tick: c.startTick, bpm: 132 }, { tick: c.startTick + c.lengthTick, bpm: 124 }]);
  const span = (q: typeof p) => ticksToSeconds(c.startTick + c.lengthTick, q.tempo) - ticksToSeconds(c.startTick, q.tempo);
  assert.ok(Math.abs(span(out) - span(p) * 124 / 132) < 1e-6);
  // 구간 앞은 그대로
  assert.equal(ticksToSeconds(c.startTick, out.tempo), ticksToSeconds(c.startTick, p.tempo));

  const whole = applyAiCommands(p, resolveTarget(p, c.id, [])!, [{ type: 'tempo', bpm: 100, scope: 'song' }]).project;
  assert.equal(whole.tempo.bpm, 100);
  assert.equal((whole.tempo.changes ?? []).length, 0);
});

test('세기·길이·밀기·박자 맞추기 — 값이 범위를 넘지 않고 클립 밖으로 나가지 않는다', () => {
  const p = song(); const c = chorus(p); const t = resolveTarget(p, c.id, [])!;
  const loud = notesOf(applyAiCommands(p, t, [{ type: 'velocity', factor: 3 }]).project, c.id);
  assert.ok(loud.every((n) => n.velocity <= 1 && n.velocity > 0));
  const short = notesOf(applyAiCommands(p, t, [{ type: 'length', factor: 0.5 }]).project, c.id);
  short.forEach((n, i) => assert.equal(n.lengthTick, Math.max(PPQ / 32, Math.round(c.notes[i]!.lengthTick * 0.5))));
  const late = notesOf(applyAiCommands(p, t, [{ type: 'shift', beats: 1000 }]).project, c.id);
  assert.ok(late.every((n) => n.startTick < c.lengthTick));
  const grid = notesOf(applyAiCommands(p, t, [{ type: 'humanize', amount: 1 }, { type: 'quantize', grid: '1/16' }]).project, c.id);
  assert.ok(grid.every((n) => n.startTick % (PPQ / 4) === 0));
});

test('새로 쓰기 — 고른 음이 새 음으로 바뀌고, AI 가 만든 음으로 표시되고, 클립 밖 음은 버린다', () => {
  const p = song(); const c = chorus(p);
  const keep = c.notes.slice(10).map((n) => n.id);
  const t = resolveTarget(p, c.id, c.notes.slice(0, 10).map((n) => n.id))!;
  const { project: out, target } = applyAiCommands(p, t, [{ type: 'replace', notes: [
    { beat: 0, length: 0.5, midi: 72, velocity: 0.9 }, { beat: 1.5, length: 1, midi: 76, velocity: 0.7 }, { beat: 9999, length: 1, midi: 60, velocity: 0.5 },
  ] }]);
  const after = notesOf(out, c.id);
  assert.equal(after.length, c.notes.length - 10 + 2);
  assert.deepEqual(after.filter((n) => keep.includes(n.id)).length, keep.length);
  const fresh = after.filter((n) => target.noteIds.includes(n.id));
  assert.deepEqual(fresh.map((n) => [n.startTick, n.pitch.midi, n.origin]), [[0, 72, 'ai'], [Math.round(1.5 * PPQ), 76, 'ai']]);
  // 저장했다 열어도 같은 곡이다
  assert.deepEqual(roundTrip(out), out);
});

test('답 검사 — 모르는 명령·이상한 값은 버리고 센 뒤 돌려준다. 던지지 않는다', () => {
  const r = parseAiReply({ reply: '올립니다', options: ['a', 3, ''], commands: [
    { type: 'transpose', semitones: 2.4, snapToKey: true }, { type: 'transpose', semitones: 0 }, { type: 'rm -rf' },
    { type: 'tempo', bpm: 9999 }, { type: 'velocity', factor: -1 }, { type: 'quantize', grid: '1/7' }, null, 'x',
    { type: 'replace', notes: [{ beat: 0, length: 1, midi: 200 }, { beat: -1, length: 1, midi: 60 }] },
  ] });
  assert.deepEqual(r.commands, [
    { type: 'transpose', semitones: 2, snapToKey: true }, { type: 'tempo', bpm: 300, scope: 'range' },
    { type: 'replace', notes: [{ beat: 0, length: 1, midi: 127, velocity: 0.8 }] },
  ]);
  assert.equal(r.dropped, 6);
  assert.deepEqual(r.options, ['a']);
  assert.deepEqual(parseAiReply(null), { reply: '', options: [], commands: [], dropped: 0 });
  assert.deepEqual(parseAiReply('<html>'), { reply: '', options: [], commands: [], dropped: 0 });
});

test('사람 말로 — 적용 전에 보여 줄 문구', () => {
  const p = song();
  assert.deepEqual(describeCommand({ type: 'transpose', semitones: 2, snapToKey: true }, p), { big: '+2 반음', text: '조에 맞게 옮깁니다' });
  assert.deepEqual(describeCommand({ type: 'transpose', semitones: -12, snapToKey: false }, p), { big: '−12 반음', text: '1옥타브 아래로' });
  assert.equal(describeCommand({ type: 'tempo', bpm: 132, scope: 'range' }, p).big, '124 → 132');
});

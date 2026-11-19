/**
 * 믹서 — 버스·출력·센드·VCA·그룹 (`LOGIC_PARITY.md` 1-8).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyProject, createTrack } from '../model/factory.ts';
import { vcaScale } from '../model/project.ts';
import type { Project } from '../model/project.ts';
import { roundTrip } from '../model/persistence.ts';
import {
  addBus, addGroup, addVca, assignGroup, assignVca, deleteBus, deleteGroup, deleteVca, setGroupedFlag, setGroupedGain,
  setSend, setTrackOutput, sumToNewBus, updateBus, updateVca,
} from './mixer.ts';

function mix(): Project {
  const p = createEmptyProject('믹스');
  for (const [name, gain] of [['킥', 0.8], ['스네어', 0.4], ['보컬', 0.6]] as const) {
    const t = createTrack({ name, instrumentId: 'kick' });
    t.gain = gain;
    p.tracks.push(t);
  }
  return p;
}
const ids = (p: Project) => p.tracks.map((t) => t.id);

test('버스 만들기·출력·센드, 지우면 참조도 정리', () => {
  let p = mix();
  const verb = addBus(p, '리버브');
  p = updateBus(verb.project, verb.busId, { gain: 0.7 });
  const [kick, snare] = ids(p);
  p = setTrackOutput(p, kick!, verb.busId);
  p = setSend(p, snare!, verb.busId, 0.3);
  p = setSend(p, snare!, verb.busId, 1.4);
  assert.equal(p.tracks[0]!.output, verb.busId);
  assert.deepEqual(p.tracks[1]!.sends, [{ busId: verb.busId, level: 1 }]);
  assert.deepEqual(roundTrip(p), p);

  const cleaned = deleteBus(p, verb.busId);
  assert.equal('output' in cleaned.tracks[0]!, false);
  assert.equal('sends' in cleaned.tracks[1]!, false);
  assert.deepEqual(cleaned.buses, []);
  assert.equal('sends' in setSend(p, snare!, verb.busId, null).tracks[1]!, false);
  assert.throws(() => setSend(mix(), kick!, 'bus_x', 0.5));
});

test('합 스택 — 새 버스로 출력을 모은다', () => {
  const p = mix();
  const [kick, snare] = ids(p);
  const { project, busId } = sumToNewBus(p, [kick!, snare!], '드럼 버스');
  assert.deepEqual(project.tracks.map((t) => t.output ?? 'master'), [busId, busId, 'master']);
  assert.equal(project.buses![0]!.name, '드럼 버스');
});

test('VCA — 묶인 트랙 게인에 곱해지고 뮤트면 0', () => {
  let p = mix();
  const v = addVca(p, '드럼');
  p = assignVca(v.project, ids(p)[0]!, v.vcaId);
  p = updateVca(p, v.vcaId, { gain: 0.5 });
  assert.equal(vcaScale(p, p.tracks[0]!), 0.5);
  assert.equal(vcaScale(p, p.tracks[1]!), 1);
  assert.equal(vcaScale(updateVca(p, v.vcaId, { mute: true }), p.tracks[0]!), 0);
  assert.deepEqual(roundTrip(p), p);
  assert.equal('vcaId' in deleteVca(p, v.vcaId).tracks[0]!, false);
});

test('그룹 — 볼륨은 비율로, 뮤트는 함께', () => {
  let p = mix();
  const g = addGroup(p, '드럼');
  const [kick, snare, vocal] = ids(p);
  p = assignGroup(assignGroup(g.project, kick!, g.groupId), snare!, g.groupId);
  p = setGroupedGain(p, kick!, 0.4); // 킥 0.8 → 0.4 : 반으로
  assert.deepEqual(p.tracks.map((t) => t.gain), [0.4, 0.2, 0.6]);
  p = setGroupedFlag(p, snare!, 'mute', true);
  assert.deepEqual(p.tracks.map((t) => t.mute), [true, true, false]);
  p = setGroupedGain(p, vocal!, 0.9);
  assert.deepEqual(p.tracks.map((t) => t.gain), [0.4, 0.2, 0.9], '그룹 밖은 혼자 움직인다');
  assert.deepEqual(roundTrip(p), p);
  assert.ok(deleteGroup(p, g.groupId).tracks.every((t) => !('groupId' in t)));
});

test('프리 페이더 센드 — 켜고 끄고, 저장해도 남는다', async () => {
  const { setSendPre } = await import('./mixer.ts');
  const { roundTrip } = await import('../model/persistence.ts');
  const { addBus, setSend } = await import('./mixer.ts');
  const { createEmptyProject, createTrack } = await import('../model/factory.ts');
  let p = createEmptyProject('s');
  const t = createTrack({ name: 'a', instrumentId: 'kick' });
  p.tracks.push(t);
  const made = addBus(p);
  p = setSend(made.project, t.id, made.busId, 0.5);
  p = setSendPre(p, t.id, made.busId, true);
  assert.equal(p.tracks[0]!.sends![0]!.pre, true);
  assert.equal(roundTrip(p).tracks[0]!.sends![0]!.pre, true);
  p = setSendPre(p, t.id, made.busId, false);
  assert.equal('pre' in p.tracks[0]!.sends![0]!, false);
});

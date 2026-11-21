import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, passwordProblem, songsRemaining, type Workspace } from './me.ts';

test('용량 표시', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(250 * 1024 * 1024), '250 MB');
  assert.equal(formatBytes(1.25 * 1024 ** 3), '1.3 GB');
});

test('새 비밀번호 — 길이와 두 칸 일치', () => {
  assert.match(passwordProblem('short', 'short')!, /10자/);
  assert.match(passwordProblem('longenough1', 'longenough2')!, /다릅니다/);
  assert.equal(passwordProblem('longenough1', 'longenough1'), null);
});

test('남은 곡 수 — null 은 무제한', () => {
  const ws = { limits: { songs_total: 5 }, usage: { songs_total: 2 } } as unknown as Workspace;
  assert.equal(songsRemaining(ws), 3);
  assert.equal(songsRemaining({ ...ws, limits: { songs_total: null } }), null);
});

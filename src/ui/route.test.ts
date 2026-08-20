import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRoute } from './route.ts';

test('편집기가 기본이다', () => {
  assert.deepEqual(parseRoute('/'), { name: 'editor' });
  assert.deepEqual(parseRoute('/무슨주소든'), { name: 'editor' });
});

test('메일 링크 세 개가 도착한다', () => {
  // 이 셋이 서버가 메일로 보내는 주소다 (`server/.../mail.py`).
  // 여기가 틀리면 확인 메일과 비밀번호 재설정이 통째로 죽는다
  assert.deepEqual(parseRoute('/verify', '?token=abc'), { name: 'verify', token: 'abc' });
  assert.deepEqual(parseRoute('/reset', '?token=xyz'), { name: 'reset', token: 'xyz' });
  assert.deepEqual(parseRoute('/invite', '?token=inv'), { name: 'invite', token: 'inv' });
});

test('토큰이 없으면 편집기로 보낸다', () => {
  // 실패한 것은 사용자가 아니라 링크다. 메일 앱이 URL 을 자르는 일은 흔하다
  assert.deepEqual(parseRoute('/verify'), { name: 'editor' });
  assert.deepEqual(parseRoute('/reset', '?token='), { name: 'editor' });
  assert.deepEqual(parseRoute('/invite', '?token=%20%20'), { name: 'editor' });
});

test('끝의 슬래시는 무시한다', () => {
  assert.deepEqual(parseRoute('/login/'), { name: 'login' });
  assert.deepEqual(parseRoute('/verify/', '?token=t'), { name: 'verify', token: 't' });
});

test('토큰의 공백을 다듬는다', () => {
  // 메일 클라이언트가 줄바꿈을 넣는 경우가 있다
  assert.deepEqual(parseRoute('/verify', '?token=%20abc%20'), { name: 'verify', token: 'abc' });
});

test('다른 질의 인자가 섞여도 토큰을 찾는다', () => {
  assert.deepEqual(parseRoute('/reset', '?utm=mail&token=t2'), { name: 'reset', token: 't2' });
});

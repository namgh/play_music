import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCommand, toCommands, type MenuAction } from './commands.ts';

test('명령 찾기 — 띄어쓰기 없이, 글자 순서대로', () => {
  assert.equal(matchCommand('', '무엇이든'), true);
  assert.equal(matchCommand('나누', '나누기 (커서에서)'), true);
  assert.equal(matchCommand('바운스인', '바운스 인 플레이스'), true);
  assert.equal(matchCommand('바플', '바운스 인 플레이스'), true, '건너뛴 글자');
  assert.equal(matchCommand('플바', '바운스 인 플레이스'), false, '순서가 다르면 아니다');
  assert.equal(matchCommand('QUANT', 'quantize'), true);
});

test('메뉴 동작을 명령으로 편다 — 고르는 항목은 하나씩, 실행이 없는 것은 뺀다', () => {
  let ran = '';
  const actions: MenuAction[] = [
    { id: 'a', label: '나누기', hint: '⌘T', run: () => { ran = 'a'; } },
    { id: 'c', label: '색', disabled: true, options: [{ label: '1', run: () => { ran = 'c1'; } }, { label: '2', run: () => { ran = 'c2'; } }] },
    { id: 'x', label: '실행 없음' },
  ];
  const cmds = toCommands('클립', actions);
  assert.deepEqual(cmds.map((c) => c.label), ['나누기', '색: 1', '색: 2']);
  assert.equal(cmds[0]!.hint, '⌘T');
  assert.equal(cmds[1]!.disabled, true);
  assert.equal(cmds[0]!.section, '클립');
  cmds[2]!.run();
  assert.equal(ran, 'c2');
});

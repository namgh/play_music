/**
 * MIDI 메시지 해석 (`LOGIC_PARITY.md` 1-16).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMidi } from './midiInput.ts';

test('노트온·노트오프(세기 0 노트온 포함)·CC·피치벤드', () => {
  assert.deepEqual(parseMidi([0x90, 60, 127]), { kind: 'noteOn', channel: 0, midi: 60, velocity: 1 });
  assert.deepEqual(parseMidi([0x93, 64, 0]), { kind: 'noteOff', channel: 3, midi: 64 });
  assert.deepEqual(parseMidi([0x80, 64, 40]), { kind: 'noteOff', channel: 0, midi: 64 });
  assert.deepEqual(parseMidi([0xb0, 1, 127]), { kind: 'cc', channel: 0, controller: 1, value: 1 });
  assert.deepEqual(parseMidi([0xe0, 0, 64]), { kind: 'pitchBend', channel: 0, value: 0 });
  assert.equal(parseMidi([0xf8]), null, '클럭 같은 시스템 메시지는 무시');
});

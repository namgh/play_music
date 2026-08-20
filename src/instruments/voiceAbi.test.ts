/**
 * 보이스 종류 ABI — **TS 와 Rust 가 같은 순서를 보고 있는가.**
 *
 * 이게 어긋나면 증상이 아주 나쁘다. 중간에 하나를 끼워 넣으면 뒤의 인덱스가 전부
 * 밀려서 **모든 악기가 엉뚱한 엔진으로 울리는데**, 개수는 그대로고 컴파일도 되고
 * 기존 테스트도 통과한다. 소리를 들어야만 안다.
 *
 * 예전에는 이걸 `types.ts` 의 주석 한 줄로만 약속했다. 지금은 이름과 순서를 함께
 * 해싱해 **wasm 을 열 때** 대조하고, 여기서 그 대조가 진짜 작동하는지 본다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { WasmVoiceEngine } from '../audio/voice/wasmEngine.ts';
import {
  VOICE_KIND_INDEX,
  VOICE_KIND_ORDER,
  voiceKindAbiHash,
  voiceKindIndex,
  type VoiceType,
} from './types.ts';

const wasmPath = fileURLToPath(new URL('../generated/dsp.wasm', import.meta.url));
const bytes = await readFile(wasmPath);

test('인덱스는 0부터 빈틈없이 이어진다', () => {
  // 구멍이 있으면 Rust 의 `from_index` 가 그 자리에서 None 을 돌려주고,
  // 그 보이스는 소리가 안 난다
  const sorted = Object.values(VOICE_KIND_INDEX).sort((a, b) => a - b);
  assert.deepEqual(sorted, sorted.map((_, i) => i), `인덱스에 구멍이 있다: ${sorted}`);
});

test('wasm 과 JS 의 보이스 개수가 같다', async () => {
  const engine = await WasmVoiceEngine.create(bytes, 48000);
  const exports = (engine as unknown as { exports: Record<string, () => number> }).exports;
  assert.equal(exports.voice_kind_count!(), VOICE_KIND_ORDER.length);
});

test('wasm 과 JS 의 ABI 해시가 같다 — 이름과 순서까지', async () => {
  const engine = await WasmVoiceEngine.create(bytes, 48000);
  const exports = (engine as unknown as { exports: Record<string, () => number> }).exports;
  assert.equal(
    exports.voice_kind_abi_hash!() >>> 0,
    voiceKindAbiHash(),
    `보이스 이름·순서가 어긋났다. JS: ${VOICE_KIND_ORDER.join(', ')}`,
  );
});

test('순서가 바뀌면 해시가 달라진다 — 대조가 실제로 잡는다', () => {
  // **개수가 같아도 틀릴 수 있다.** 이 시험이 없으면 "개수만 세는" 약한 대조를
  // 해 두고 안전하다고 착각하게 된다
  const real = voiceKindAbiHash();

  const fnv = (names: string[]) => {
    let h = 0x811c9dc5;
    for (const n of names) {
      for (const b of new TextEncoder().encode(n)) {
        h ^= b;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      h ^= 0x7c;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };

  assert.equal(fnv([...VOICE_KIND_ORDER]), real, '같은 순서면 같아야 한다');

  const swapped = [...VOICE_KIND_ORDER];
  [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
  assert.notEqual(fnv(swapped), real, '두 개만 바꿔도 달라져야 한다');

  const inserted = [VOICE_KIND_ORDER[0]!, 'granular', ...VOICE_KIND_ORDER.slice(1)];
  assert.notEqual(fnv(inserted), real, '중간에 끼워 넣으면 달라져야 한다');

  const renamed = ['waveguide_string', ...VOICE_KIND_ORDER.slice(1)];
  assert.notEqual(fnv(renamed), real, '이름만 바뀌어도 달라져야 한다');
});

test('모르는 보이스 타입은 조용히 0번이 되지 않는다', () => {
  // 예전에는 `?? 0` 이라 **줄 소리**로 울렸다. 새 보이스를 만들고 표에 안 적으면
  // "왜 신스가 기타 소리지"를 한참 헤매게 된다
  assert.throws(
    () => voiceKindIndex('granular' as VoiceType),
    /보이스 타입을 모른다/,
    '모르는 타입이면 던져야 한다',
  );
});

test('실제로 쓰는 보이스는 전부 표에 있다', async () => {
  // **원본 정의가 아니라 해석된 것을 본다.** `voice` 는 계열에서 상속되므로,
  // 정의 그대로 보면 대부분 `undefined` 다 (여기서 한 번 속았다)
  const { createRegistry } = await import('./definitions.ts');
  const { resolveInstrument } = await import('./resolve.ts');
  const registry = createRegistry();

  const missing: string[] = [];
  for (const id of registry.keys()) {
    const voice = resolveInstrument(id, registry).voice;
    if (VOICE_KIND_INDEX[voice] === undefined) missing.push(`${id}: ${voice}`);
  }
  assert.deepEqual(missing, [], '악기가 표에 없는 보이스를 쓴다');
  assert.ok(registry.size > 20, `악기가 너무 적다 (${registry.size}) — 레지스트리를 잘못 읽었다`);
});

test('모르는 인덱스가 들어와도 소리를 내지 않는다', async () => {
  // Rust 는 예전에 `_ => Percussion` 으로 떨어뜨렸다 — 어긋나도 드럼이 울려서
  // 아무도 몰랐다. 지금은 안 울리고 센다
  const engine = await WasmVoiceEngine.create(bytes, 48000);
  const exports = (engine as unknown as {
    exports: Record<string, (...a: number[]) => number>;
  }).exports;

  const before = exports.unknown_voice_kind_count!();
  engine.noteOn(440, 1, { voiceKind: 99 }, 1, undefined, 1);
  assert.equal(
    exports.unknown_voice_kind_count!(),
    before + 1,
    '모르는 보이스 종류가 세어져야 한다',
  );

  const out = new Float32Array(128);
  engine.process(out, 128);
  assert.ok(
    out.every((s) => s === 0),
    '모르는 종류인데 소리가 났다 — 조용히 다른 엔진으로 떨어진 것이다',
  );
});

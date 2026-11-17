/**
 * 워크렛의 'rust-fx' 프로세서 — 실제 `public/ks-worklet.js` 를 `node:vm` 에 올리고 실제 fx.wasm 으로 돌린다.
 * 브라우저 밖에서 잡을 수 있는 배선 실수(메모리 뷰가 떨어져 나감, 파라미터 순서, 통과 처리)를 여기서 잡는다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { createEffect, resolveEffectParams } from './effects.ts';
import { RUST_KIND } from './rustEffects.ts';
import { rustParamValues } from './fxRuntime.ts';

const source = readFileSync(new URL('../../public/ks-worklet.js', import.meta.url), 'utf8');
const bytes = readFileSync(new URL('../generated/fx.wasm', import.meta.url));

interface FxProcessor {
  fx: unknown;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

function load() {
  const registered = new Map<string, new (o: unknown) => FxProcessor>();
  const messages: unknown[] = [];
  const context: Record<string, unknown> = {
    sampleRate: 48000,
    currentFrame: 0,
    WebAssembly,
    registerProcessor: (name: string, ctor: new (o: unknown) => FxProcessor) => registered.set(name, ctor),
    AudioWorkletProcessor: class { port = { postMessage: (m: unknown) => messages.push(m), onmessage: null }; },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { Ctor: registered.get('rust-fx')!, messages };
}

const paramsFor = (values: number[]) => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`p${i}`, new Float32Array([values[i] ?? 0])]));

test('rust-fx — 첫 노드가 바이트로 컴파일하고, 다음 노드는 캐시를 쓴다', () => {
  const { Ctor, messages } = load();
  const values = rustParamValues('gate', { ...resolveEffectParams(createEffect('gate')), thresholdDb: -30 });
  const first = new Ctor({ processorOptions: { kind: RUST_KIND.gate, params: values, latency: 0, bytes } });
  const second = new Ctor({ processorOptions: { kind: RUST_KIND.gate, params: values, latency: 0 } });
  assert.ok(first.fx && second.fx, JSON.stringify(messages));
  // 작은 소리 → 게이트가 닫는다
  const quiet = Float32Array.from({ length: 128 }, (_, i) => 0.003 * Math.sin(i / 5));
  let out: Float32Array[] = [new Float32Array(128), new Float32Array(128)];
  for (let b = 0; b < 200; b++) {
    out = [new Float32Array(128), new Float32Array(128)];
    second.process([[quiet, quiet]], [out], paramsFor(values));
  }
  assert.ok(Math.max(...out[0]!.map(Math.abs)) < 0.0002);
  assert.equal(messages.length, 0);
});

test('rust-fx — 선언 지연이 틀리면 알린다, 모르는 번호는 통과', () => {
  const { Ctor, messages } = load();
  const values = rustParamValues('spacedesigner', resolveEffectParams(createEffect('spacedesigner')));
  new Ctor({ processorOptions: { kind: RUST_KIND.spacedesigner, params: values, latency: 5, bytes } });
  assert.match(JSON.stringify(messages), /지연 불일치/);
  const bad = new Ctor({ processorOptions: { kind: 999, params: [], latency: 0 } });
  const x = Float32Array.from({ length: 128 }, (_, i) => i / 128);
  const out = [new Float32Array(128), new Float32Array(128)];
  bad.process([[x, x]], [out], paramsFor([]));
  assert.deepEqual(Array.from(out[0]!), Array.from(x), '실패하면 통과');
});

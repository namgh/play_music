/**
 * M0 스파이크 — AudioWorkletProcessor 껍데기
 *
 * DSP는 전부 ks-string.js 에 있고 여기는 보이스 풀과 메시지 처리만 한다.
 * 이렇게 나눠 둬야 같은 DSP를 노드 테스트(test-pitch.mjs)에서 그대로 돌릴 수 있다.
 *
 * M1에서는 이 자리에 Rust→WASM 모듈이 들어간다. 그때는 워크렛 스코프에 fetch가
 * 없다는 제약 때문에 wasm 바이트를 메인 스레드에서 받아 postMessage 로 넘겨야 한다.
 */

import { KSString, DEFAULT_PARAMS } from './ks-string.js';

const VOICE_COUNT = 12;
const OUTPUT_GAIN = 0.22; // 6줄 스트럼에서 클리핑 안 나는 선

class KSStringProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = Array.from({ length: VOICE_COUNT }, () => new KSString(sampleRate));
    this.rr = 0;
    this.params = { ...DEFAULT_PARAMS };

    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'params':
          Object.assign(this.params, data.params);
          break;
        case 'pluck':
          this.pluck(data.freq, data.velocity ?? 1);
          break;
        case 'allOff':
          for (const v of this.voices) v.reset();
          break;
      }
    };
  }

  pluck(freq, velocity) {
    // 쉬는 보이스 우선, 없으면 가장 오래된 것을 뺏는다 (보이스 스틸링)
    let voice = this.voices.find((v) => !v.active);
    if (!voice) {
      voice = this.voices[this.rr];
      this.rr = (this.rr + 1) % VOICE_COUNT;
    }
    voice.setParams(this.params);
    voice.pluck(freq, velocity);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const mono = out[0];
    mono.fill(0);

    for (const v of this.voices) v.process(mono, mono.length);
    for (let i = 0; i < mono.length; i++) mono[i] *= OUTPUT_GAIN;

    // 여기에 tanh 같은 소프트 리미터를 넣지 않는다 — 비선형 단계는 오버샘플링이
    // 전제이고(sound.md 6-1), 오버샘플링 없는 비선형은 에일리어싱을 만든다.
    // 클리핑은 게인으로 피한다.
    for (let ch = 1; ch < out.length; ch++) out[ch].set(mono);
    return true;
  }
}

registerProcessor('ks-string', KSStringProcessor);

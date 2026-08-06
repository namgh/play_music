/**
 * AudioWorklet 프로세서 — Rust DSP 코어를 오디오 스레드에서 돌린다.
 *
 * **의존성이 0개인 평범한 JS 파일이다.** 그래서 `public/` 에 그대로 두고 번들러를
 * 거치지 않는다. 이게 가능한 이유는 wasm 을 wasm-bindgen 없이 순수 숫자 ABI 로
 * 만들었기 때문이다 — 글루가 필요하면 여기서 번들링을 풀어야 했다.
 *
 * 워크렛 스코프에는 `fetch` 가 없다. 그래서 wasm 바이트를 메인 스레드에서 받아
 * `postMessage` 로 넘겨준다.
 *
 * 발음 시각은 **샘플 단위로 정확하다.** 블록 경계로 반올림하면 최대 2.7ms 씩
 * 밀리므로, 이벤트가 블록 중간에 있으면 블록을 쪼개서 처리한다.
 */

const MAX_BLOCK = 2048;
const PARAM_COUNT = 11; // Rust 쪽 PARAM_COUNT 와 같아야 한다 (줄 6 + 음정 곡선 5)
/**
 * 이만큼 지난 예약은 버린다.
 *
 * wasm 로드가 끝나기 전에 예약이 쌓이면(사용자가 곧바로 재생을 누르는 경우)
 * 준비되는 순간 그게 전부 한꺼번에 터진다. 오래 지난 음은 제자리에 놓을 방법이
 * 없으므로 늦게 내는 것보다 버리는 게 낫다.
 */
const STALE_FRAMES = 12000; // 48kHz 에서 0.25초

class KsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasm = null;
    this.paramView = null;
    this.outputView = null;
    /** { frame, freq, velocity, params, gain } — frame 순으로 정렬 */
    this.pending = [];

    this.port.onmessage = (event) => this.handle(event.data);
  }

  async handle(message) {
    switch (message.type) {
      case 'load':
        await this.load(message.bytes);
        break;
      case 'noteOn':
        // 예약 시각이 이미 지났으면 다음 블록 맨 앞에 놓는다 — 드롭하면 음이 사라진다.
        // `currentFrame` 은 워크렛 전역이고 `ctx.currentTime * sampleRate` 와 원점이 같다.
        // 자체 카운터를 쓰면 컨텍스트가 먼저 시작된 만큼 어긋난다
        this.pending.push({
          frame: Math.max(message.frame, currentFrame),
          freq: message.freq,
          velocity: message.velocity,
          params: message.params,
          gain: message.gain ?? 1,
        });
        this.pending.sort((a, b) => a.frame - b.frame);
        break;
      case 'setParams':
        if (this.wasm) {
          this.writeParams(message.params);
          this.wasm.set_params_live(0xffffffff);
        }
        break;
      case 'allOff':
        this.pending.length = 0;
        if (this.wasm) this.wasm.all_off();
        break;
      default:
        break;
    }
  }

  async load(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports;
    exports.init(sampleRate);
    this.wasm = exports;
    this.refreshViews();
    // 준비되기 전에 쌓인 예약은 버린다 — 지금 내면 전부 한 지점에 몰린다
    this.pending.length = 0;
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  /**
   * wasm 메모리가 자라면 기존 ArrayBuffer 가 detach 되고, 그 위에 만든 뷰는
   * 조용히 쓸 수 없게 된다 (읽으면 undefined → NaN). 매번 확인한다.
   */
  refreshViews() {
    const buffer = this.wasm.memory.buffer;
    if (buffer === this.viewBuffer) return;
    this.viewBuffer = buffer;
    this.paramView = new Float32Array(buffer, this.wasm.param_buffer(), PARAM_COUNT);
    this.outputView = new Float32Array(buffer, this.wasm.output_buffer(), MAX_BLOCK);
  }

  writeParams(params) {
    this.refreshViews();
    for (let i = 0; i < PARAM_COUNT; i++) this.paramView[i] = params[i] ?? 0;
  }

  /** `[from, from+count)` 를 렌더해 출력 채널의 `offset` 위치에 쓴다 */
  renderSegment(channels, offset, count) {
    if (count <= 0) return;
    this.wasm.process(count);
    this.refreshViews();
    const left = channels[0];
    for (let i = 0; i < count; i++) left[offset + i] = this.outputView[i];
    for (let ch = 1; ch < channels.length; ch++) {
      for (let i = 0; i < count; i++) channels[ch][offset + i] = left[offset + i];
    }
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    const frames = channels[0].length;

    if (!this.wasm) {
      for (const channel of channels) channel.fill(0);
      return true;
    }

    let written = 0;
    while (written < frames) {
      // 이 블록 안에서 다음 이벤트가 언제인가
      const next = this.pending[0];
      const untilEvent = next ? next.frame - (currentFrame + written) : Infinity;

      if (untilEvent <= 0) {
        this.pending.shift();
        // 너무 오래 지난 예약은 버린다 (위 STALE_FRAMES 설명)
        if (untilEvent < -STALE_FRAMES) continue;
        // 지금 이 샘플에서 발음한다
        this.writeParams(next.params);
        this.wasm.note_on(next.freq, next.velocity, next.gain);
        continue;
      }

      const count = Math.min(frames - written, untilEvent);
      this.renderSegment(channels, written, count);
      written += count;
    }

    return true;
  }
}

registerProcessor('ks-string', KsProcessor);

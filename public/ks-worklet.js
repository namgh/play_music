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
 *
 * ## 노트오프를 여기서 예약한다 (`WORKPLAN.md` 2-1)
 *
 * `noteOff` 메시지를 따로 받지 않고 `noteOn` 에 `durationFrames` 를 실어 받는다.
 * 보이스 번호는 `note_on()` 의 **반환값**이라 워크렛 안에서만 알 수 있고, 노트 id ↔
 * 보이스 번호 대응표를 메시지 경계 너머로 유지하면 상태가 두 곳에 생긴다.
 *
 * 덕분에 노트오프도 같은 블록 쪼개기 루프를 타서 **샘플 단위로 정확**하고,
 * 오프라인 내보내기(이벤트를 미리 전부 post 하는 방식)가 수정 없이 그대로 동작한다.
 */

const MAX_BLOCK = 2048;
// Rust 쪽 PARAM_COUNT 와 같아야 한다
// (줄 6 + 곡선 5 + 앰프 9 + 보이스 10 + 드럼 4 + 연주표현 3 + 표현력 9 + 보이싱 15
//  + 드럼 막진동 3 + 신스 두께 7 + 비조화도 1)
const PARAM_COUNT = 72;
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
    this.curveView = null;
    this.voicingView = null;
    /** { frame, freq, velocity, params, gain, durationFrames, releaseMs } — frame 순 정렬 */
    this.pending = [];
    /** { frame, voice, serial, releaseMs } — frame 순 정렬 */
    this.pendingOff = [];
    /**
     * 슬롯마다 "지금 누구 것인가". 발음할 때 새 일련번호를 찍고, 노트오프는 번호가
     * 그대로일 때만 적용한다.
     *
     * **이게 없으면 보이스를 뺏긴 뒤 도착한 노트오프가 엉뚱한 음을 자른다.**
     * 32음을 넘겨 연주하면 실제로 일어난다.
     */
    this.voiceOwner = null;
    this.serial = 0;

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
          // **요청한 원래 시각.** 위에서 현재 시각으로 당겨 버리면 "늦게 온 예약"과
          // "제때 온 예약"을 구분할 수 없게 된다 (`load` 가 그것으로 판정한다)
          requestedFrame: message.frame,
          freq: message.freq,
          velocity: message.velocity,
          params: message.params,
          gain: message.gain ?? 1,
          // 0 이면 노트오프를 예약하지 않는다 (= 울림 유지, letRing)
          durationFrames: message.durationFrames ?? 0,
          releaseMs: message.releaseMs ?? 120,
          // 사용자가 그린 자유곡선 (`ROADMAP.md` S1-4). 없으면 undefined
          curve: message.curve,
          // 타건 변주 씨앗. **음마다 결정론적**이라 재생과 내보내기가 같다
          seed: message.seed ?? 0,
        });
        this.pending.sort((a, b) => a.frame - b.frame);
        break;
      case 'voicing':
        // 바디 모드·공명현 조율. 파라미터 슬롯이 아니라 버퍼로 온다
        if (this.wasm) this.writeVoicing(message);
        break;
      case 'setParams':
        if (this.wasm) {
          this.writeParams(message.params);
          this.wasm.set_params_live(0xffffffff);
        }
        break;
      case 'allOff':
        this.pending.length = 0;
        this.pendingOff.length = 0;
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
    // 소유권 표는 wasm 의 슬롯 수에 맞춘다 — 상수를 양쪽에 두면 어긋난다
    this.voiceOwner = new Int32Array(exports.max_voices());
    // **지난 예약만 버린다.** 통째로 비우면 안 된다.
    //
    // 원래 의도는 재생 쪽이었다: 로딩 중에 쌓인 예약을 지금 내면 전부 한 지점에
    // 몰려 "쾅" 하고 난다. 그런데 **내보내기는 모든 음을 한 번에, 미래 시각으로**
    // 예약한 뒤 `ready` 를 기다린다. 통째로 비우면 그 음들이 전부 사라져서
    // **완전 무음 파일**이 나온다 — 실제로 그랬다. 16트랙 곡을 내보냈더니
    // 3.4MB 짜리 WAV 가 전 표본 0 이었다. 재생은 룩어헤드가 계속 다시 예약하므로
    // 멀쩡했고, 그래서 이 결함은 브라우저에서 내보내기를 눌러 봐야만 드러났다.
    //
    // 요청 시각이 이미 지난 것만 버리면 두 경우가 모두 산다: 재생에서 늦게 온
    // 예약은 여전히 버려지고(몰리지 않는다), 내보내기의 미래 예약은 살아남는다.
    const stillAhead = (item) => (item.requestedFrame ?? item.frame) >= currentFrame;
    this.pending = this.pending.filter(stillAhead);
    this.pendingOff = this.pendingOff.filter(stillAhead);
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
    this.outputViewR = new Float32Array(buffer, this.wasm.output_buffer_right(), MAX_BLOCK);
    this.curveView = new Float32Array(
      buffer, this.wasm.curve_buffer(), this.wasm.curve_point_capacity() * 2,
    );
    this.voicingView = new Float32Array(
      buffer, this.wasm.voicing_buffer(), this.wasm.body_mode_capacity() * 3,
    );
  }

  /**
   * 자유곡선 점을 **다음 발음 한 번에** 예약한다.
   * 점이 없으면 지운다 — 안 지우면 곡선을 안 그린 다음 음까지 휘어진다.
   */
  writeCurve(curve) {
    const points = curve?.points;
    if (!points || points.length === 0 || !(curve.durationSec > 0)) {
      this.wasm.set_curve_points(0, 0);
      return;
    }
    this.refreshViews();
    const capacity = Math.floor(this.curveView.length / 2);
    const count = Math.min(points.length, capacity);
    for (let i = 0; i < count; i++) {
      this.curveView[i * 2] = points[i].tNorm;
      this.curveView[i * 2 + 1] = points[i].cents;
    }
    this.wasm.set_curve_points(count, curve.durationSec);
  }

  /** 개수가 가변인 보이싱 데이터를 버퍼에 써 넣는다 */
  writeVoicing(message) {
    this.refreshViews();
    const view = this.voicingView;
    if (Array.isArray(message.bodyModes)) {
      const capacity = Math.floor(view.length / 3);
      const count = Math.min(message.bodyModes.length, capacity);
      for (let i = 0; i < count; i++) {
        view[i * 3] = message.bodyModes[i].ratio;
        view[i * 3 + 1] = message.bodyModes[i].gain;
        view[i * 3 + 2] = message.bodyModes[i].q;
      }
      this.wasm.set_body_modes(count);
      this.refreshViews();
    }
    if (Array.isArray(message.sympatheticSemitones)) {
      const capacity = this.wasm.sympathetic_string_capacity();
      const count = Math.min(message.sympatheticSemitones.length, capacity);
      for (let i = 0; i < count; i++) this.voicingView[i] = message.sympatheticSemitones[i];
      this.wasm.set_sympathetic_tuning(count);
      this.refreshViews();
    }
  }

  writeParams(params) {
    this.refreshViews();
    for (let i = 0; i < PARAM_COUNT; i++) this.paramView[i] = params[i] ?? 0;
  }

  /**
   * `[from, from+count)` 를 렌더해 출력 채널의 `offset` 위치에 쓴다.
   *
   * wasm 이 좌우를 따로 준다 (`ROADMAP.md` S1-1). 예전에는 모노 하나를 좌우에
   * 복사해서 **전곡이 사실상 모노**였다. 보이스마다 음 높이로 좌우 배치가 정해지므로
   * 합산한 뒤에는 나눌 수 없고, 그래서 wasm 안에서 두 갈래로 합산한다.
   */
  renderSegment(channels, offset, count) {
    if (count <= 0) return;
    this.wasm.process(count);
    this.refreshViews();
    const left = channels[0];
    for (let i = 0; i < count; i++) left[offset + i] = this.outputView[i];

    if (channels.length > 1) {
      const right = channels[1];
      for (let i = 0; i < count; i++) right[offset + i] = this.outputViewR[i];
      // 3채널 이상은 쓰지 않지만, 남으면 조용해지므로 왼쪽을 복사해 둔다
      for (let ch = 2; ch < channels.length; ch++) {
        for (let i = 0; i < count; i++) channels[ch][offset + i] = left[offset + i];
      }
      return;
    }

    // 모노 출력으로 배선된 경우 — 한쪽만 내보내면 반대쪽에 배치된 음이 사라진다.
    // 폭이 0 이면 좌우가 같으므로 이 평균은 원래 값 그대로다
    for (let i = 0; i < count; i++) {
      left[offset + i] = (this.outputView[i] + this.outputViewR[i]) * 0.5;
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
      const now = currentFrame + written;
      // 노트온·노트오프 중 **먼저 오는 것**에서 블록을 쪼갠다
      const nextOn = this.pending[0];
      const nextOff = this.pendingOff[0];
      const untilOn = nextOn ? nextOn.frame - now : Infinity;
      const untilOff = nextOff ? nextOff.frame - now : Infinity;

      // 같은 샘플이면 노트오프를 먼저 처리한다 — 방금 잡은 보이스를 바로 끄지 않게
      if (untilOff <= 0 && untilOff <= untilOn) {
        this.pendingOff.shift();
        // 뺏긴 뒤 도착한 노트오프는 버린다 (그 슬롯은 이미 남의 것이다)
        if (this.voiceOwner[nextOff.voice] === nextOff.serial) {
          this.wasm.note_off(nextOff.voice, nextOff.releaseMs);
        }
        continue;
      }

      if (untilOn <= 0) {
        this.pending.shift();
        // 너무 오래 지난 예약은 버린다 (위 STALE_FRAMES 설명)
        if (untilOn < -STALE_FRAMES) continue;
        this.writeParams(nextOn.params);
        this.writeCurve(nextOn.curve);
        const voice = this.wasm.note_on(nextOn.freq, nextOn.velocity, nextOn.gain, nextOn.seed >>> 0);
        this.refreshViews(); // note_on 안에서 메모리가 자랐을 수 있다

        const serial = ++this.serial;
        if (voice < this.voiceOwner.length) this.voiceOwner[voice] = serial;

        if (nextOn.durationFrames > 0) {
          // **실제 발음 프레임** 기준으로 잡는다. 예약이 조금 늦었을 때 의도한
          // 시각을 쓰면 길이가 그만큼 깎이고, 심하면 음이 나자마자 꺼진다
          this.pendingOff.push({
            frame: now + nextOn.durationFrames,
            voice,
            serial,
            releaseMs: nextOn.releaseMs,
          });
          this.pendingOff.sort((a, b) => a.frame - b.frame);
        }
        continue;
      }

      const count = Math.min(frames - written, untilOn, untilOff);
      this.renderSegment(channels, written, count);
      written += count;
    }

    return true;
  }
}

registerProcessor('ks-string', KsProcessor);

// ---------------------------------------------------------------------------
// Rust 이펙트 (`EFFECTS_PLAN.md`) — 노드 하나에 이펙트 하나.
//
// fx.wasm 은 **이 컨텍스트에서 한 번만 컴파일**하고(아래 fxModule) 노드마다 인스턴스를 만든다.
// 바이트는 메인 스레드가 첫 노드에만 실어 보낸다 — 노드를 만들 때마다 100KB 를 복사하지 않게.
// 파라미터는 AudioParam p0…p23 — 기존 오토메이션(`scheduleTrackLanes`)이 그대로 움직인다.
// ---------------------------------------------------------------------------

const FX_PARAMS = 24;
const FX_METERS = 16;
let fxModule = null;

class RustFxProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const list = [];
    for (let i = 0; i < FX_PARAMS; i++) {
      list.push({ name: `p${i}`, defaultValue: 0, minValue: -1e9, maxValue: 1e9, automationRate: 'k-rate' });
    }
    return list;
  }

  constructor(options) {
    super();
    const opts = options.processorOptions ?? {};
    this.fx = null;
    this.alive = true;
    // 미터가 있는 이펙트만 초당 20번 보낸다 — 노드가 수십 개면 메시지가 쌓인다
    this.meterEvery = opts.meters ? Math.round(sampleRate / 20) : 0;
    this.sinceMeter = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'dispose') this.alive = false;
    };
    try {
      if (!fxModule && opts.bytes) fxModule = new WebAssembly.Module(opts.bytes);
      if (!fxModule) throw new Error('fx.wasm 이 아직 없다');
      const fx = new WebAssembly.Instance(fxModule, {}).exports;
      // 첫 값을 먼저 쓴다 — 구조가 파라미터에 달린 이펙트(IR 길이 등)가 처음부터 맞는 모양이어야 한다
      // 주소를 **먼저** 얻는다 — 첫 호출이 상태를 할당하며 메모리를 키우면 미리 잡아 둔 버퍼가 떨어져 나간다
      const paramsAt = fx.fx_params();
      new Float32Array(fx.memory.buffer, paramsAt, FX_PARAMS).set(opts.params ?? []);
      const latency = fx.fx_create(opts.kind, sampleRate);
      if (latency < 0) throw new Error(`모르는 이펙트 번호 ${opts.kind}`);
      if (typeof opts.latency === 'number' && opts.latency !== latency) {
        this.port.postMessage({ type: 'error', message: `지연 불일치: 선언 ${opts.latency} · 실제 ${latency}` });
      }
      this.fx = fx;
      this.views();
    } catch (err) {
      // 실패하면 통과시킨다 — 소리가 끊기는 것보다 이펙트가 빠지는 쪽이 낫다
      this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }

  views() {
    const fx = this.fx;
    const at = [fx.fx_params(), fx.fx_in_l(), fx.fx_in_r(), fx.fx_meters()];
    const mem = fx.memory.buffer;
    this.mem = mem;
    this.pView = new Float32Array(mem, at[0], FX_PARAMS);
    this.lView = new Float32Array(mem, at[1], MAX_BLOCK);
    this.rView = new Float32Array(mem, at[2], MAX_BLOCK);
    this.mView = new Float32Array(mem, at[3], FX_METERS);
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const input = inputs[0];
    const frames = out[0].length;
    if (!this.fx) {
      for (let ch = 0; ch < out.length; ch++) {
        const src = input[ch] ?? input[0];
        if (src) out[ch].set(src); else out[ch].fill(0);
      }
      return this.alive;
    }
    if (this.fx.memory.buffer !== this.mem) this.views();
    for (let i = 0; i < FX_PARAMS; i++) this.pView[i] = parameters[`p${i}`][0];
    const inL = input[0];
    const inR = input[1] ?? input[0];
    if (inL) { this.lView.set(inL); this.rView.set(inR); } else { this.lView.fill(0, 0, frames); this.rView.fill(0, 0, frames); }
    this.fx.fx_process(frames);
    if (this.fx.memory.buffer !== this.mem) this.views();
    out[0].set(this.lView.subarray(0, frames));
    if (out[1]) out[1].set(this.rView.subarray(0, frames));
    this.sinceMeter += frames;
    if (this.meterEvery > 0 && this.sinceMeter >= this.meterEvery) {
      this.sinceMeter = 0;
      this.port.postMessage({ type: 'meters', values: Array.from(this.mView) });
    }
    return this.alive;
  }
}

registerProcessor('rust-fx', RustFxProcessor);

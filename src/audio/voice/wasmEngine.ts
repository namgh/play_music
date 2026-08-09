/**
 * Rust DSP 코어 바인딩 (`sound.md` 10절 M1).
 *
 * wasm-bindgen 글루가 없다. 숫자와 선형 메모리만 오가므로 브라우저·Node·나중의
 * 서버가 **같은 `.wasm` 을 그대로** 쓴다. 바이트를 어디서 읽어오는지는 호출자 몫이라
 * (브라우저는 fetch, Node 는 fs) 이 파일은 환경에 의존하지 않는다.
 *
 * 왜 Rust 인가: JS 가 느려서가 아니라 **GC 정지가 오디오 끊김을 만들기 때문**이고,
 * 같은 코드를 서버에서도 돌려 재현성을 확보하기 때문이다 (`plan.md` 5-2).
 */

import type { ParamValue } from '../../instruments/types.ts';

/**
 * Rust 쪽 `PARAM_COUNT` 와 순서가 **정확히** 같아야 한다.
 * 0~5 는 줄 파라미터, 6~10 은 음정 곡선 (0 이면 곡선 없음).
 * 순서가 어긋나면 조용히 엉뚱한 소리가 난다 — 양쪽을 같이 고칠 것.
 */
export const WASM_PARAM_ORDER = [
  // 진동체 (줄)
  'scaleLengthMm',
  'stiffness',
  'damping',
  'sustainSec',
  'pluckPosition',
  'pluckHardness',
  // 음정 곡선 (0 이면 곡선 없음)
  'glideCents',
  'glideMs',
  'vibratoCents',
  'vibratoHz',
  'vibratoDelayMs',
  // 앰프 체인 — **줄과 분리된 층**이다 (sound.md 5절·8절).
  // ampEnabled 가 0 이면 통과 (어쿠스틱 악기)
  'ampEnabled',
  'ampCharacter',
  'ampDrive',
  'ampToneLow',
  'ampToneMid',
  'ampToneHigh',
  'ampLevel',
  'ampCabinet',
  'pickupPosition',
  // 보이스 타입 (0 줄 · 1 모달 · 2 신스 · 3 샘플러)
  'voiceKind',
  // 모달 (Tier 2)
  'modalMaterial',
  'modalDecaySec',
  'strikePosition',
  // 신스 (Tier 3). 엔벌로프는 줄 슬롯 0~3 을 재사용한다 —
  // 신스에는 줄 파라미터가 의미 없으므로 슬롯을 겹쳐 쓴다
  'synthWaveform',
  'synthDetuneCents',
  'synthCutoffHz',
  'synthResonance',
  'synthFilterEnv',
  // 샘플러 (Tier 4)
  'preserveFormant',
  // 드럼 (합성). 밝기는 strikePosition 슬롯을 재사용한다
  'drumKind',
  'drumDecaySec',
  'drumPitchDrop',
  'drumNoiseAmount',
  // 연주 표현 (`ROADMAP.md` S1). 셋 다 **0 이면 예전과 완전히 같은 소리**다 —
  // 악기가 켜지 않으면 아무 영향이 없게 기본값을 0 으로 둔다
  'stereoWidth',
  'pickupHumbucker',
  'velocityBrightness',
] as const;

/** 모델의 `PitchCurve` 를 wasm 파라미터로 펼친다 */
export function curveToParams(curve: {
  glide: { cents: number; ms: number } | null;
  vibrato: { cents: number; hz: number; delayMs: number } | null;
} | null): Record<string, number> {
  return {
    glideCents: curve?.glide?.cents ?? 0,
    glideMs: curve?.glide?.ms ?? 0,
    vibratoCents: curve?.vibrato?.cents ?? 0,
    vibratoHz: curve?.vibrato?.hz ?? 0,
    vibratoDelayMs: curve?.vibrato?.delayMs ?? 0,
  };
}

/** 악기가 값을 안 주면 쓰는 뮤트 속도. 손으로 줄을 짚어 죽이는 데 실제로 걸리는 시간 */
export const DEFAULT_RELEASE_MS = 120;

/**
 * 노트오프를 워크렛에 어떻게 알릴지 정한다 (`WORKPLAN.md` 2-1·2-2).
 *
 * `durationFrames = 0` 은 "노트오프 없음" 이다 — `letRing` 악기(하프·치터처럼
 * 떼도 울리는 것)와 원샷 타악기가 그 경로를 쓴다.
 *
 * **이 두 값이 파라미터 슬롯이 아닌 이유:** 발음마다 바뀌는 게 아니라 노트오프
 * 시점에만 필요하다. 슬롯을 늘리면 Rust·TS·워크렛 세 곳의 `PARAM_COUNT` 를 같이
 * 고쳐야 하고, 어긋나면 조용히 엉뚱한 소리가 난다 (`HANDOFF.md` 작업 규칙).
 *
 * 순수 함수로 두어 브라우저 없이 테스트한다.
 */
export function noteOffFields(
  params: Readonly<Record<string, number | string>>,
  durationSec: number,
  sampleRate: number,
): { durationFrames: number; releaseMs: number } {
  const letRing = Number(params.letRing) === 1;
  const raw = Number(params.releaseMs);
  const releaseMs = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RELEASE_MS;

  if (letRing || !(durationSec > 0) || !(sampleRate > 0)) {
    return { durationFrames: 0, releaseMs };
  }
  // 최소 1프레임 — 0 은 "노트오프 없음"이라 아주 짧은 음이 영원히 울려 버린다
  return { durationFrames: Math.max(1, Math.round(durationSec * sampleRate)), releaseMs };
}

const MAX_BLOCK = 2048;

/** Rust 쪽 PARAM_COUNT 와 같아야 한다 */
export const WASM_PARAM_COUNT = 37;

interface WasmExports {
  memory: WebAssembly.Memory;
  init(sampleRate: number): void;
  param_buffer(): number;
  output_buffer(): number;
  output_buffer_right(): number;
  note_on(freqHz: number, velocity: number, gain: number): number;
  set_params_live(voice: number): void;
  note_off(voice: number, releaseMs: number): void;
  all_off(): void;
  process(frames: number): number;
  param_count(): number;
  voice_line_delay(voice: number): number;
  voice_loop_gain(voice: number): number;
  sample_rate(): number;
  max_voices(): number;
  live_voices(): number;
}

export class WasmEngineError extends Error {}

/**
 * Rust 보이스 풀. 보이스 관리가 wasm 안에 있으므로 JS 쪽은 발음 요청만 보낸다.
 * 오디오 경로에서 JS 가 메모리를 할당하지 않는다 — 할당자가 지연을 튀게 만든다.
 */
export class WasmVoiceEngine {
  private readonly exports: WasmExports;
  private viewBuffer: ArrayBuffer | null = null;
  private paramView!: Float32Array;
  private outputView!: Float32Array;
  private outputViewR!: Float32Array;

  readonly sampleRate: number;

  private constructor(exports: WasmExports) {
    this.exports = exports;
    this.sampleRate = exports.sample_rate();
    this.refreshViews();
  }

  /**
   * wasm 메모리가 자라면 기존 `ArrayBuffer` 가 detach 되고, 그 위에 만든 타입 배열은
   * **조용히 쓸 수 없게 된다** (읽으면 undefined 가 나와 NaN 으로 번진다).
   * Rust 쪽에서 오디오 경로의 할당을 없앴지만, 뷰를 캐시하는 쪽도 방어해 둔다.
   */
  private refreshViews(): void {
    const buffer = this.exports.memory.buffer;
    if (buffer === this.viewBuffer) return;
    this.viewBuffer = buffer;
    this.paramView = new Float32Array(buffer, this.exports.param_buffer(), WASM_PARAM_COUNT);
    this.outputView = new Float32Array(buffer, this.exports.output_buffer(), MAX_BLOCK);
    this.outputViewR = new Float32Array(buffer, this.exports.output_buffer_right(), MAX_BLOCK);
  }

  static async create(bytes: BufferSource, sampleRate: number): Promise<WasmVoiceEngine> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const exports = instance.exports as unknown as WasmExports;
    const required = [
      'init', 'note_on', 'process', 'param_buffer', 'output_buffer', 'output_buffer_right',
    ] as const;
    for (const name of required) {
      if (typeof exports[name] !== 'function') {
        throw new WasmEngineError(`wasm 에 ${name} 이 없다 — 빌드가 오래됐을 수 있다`);
      }
    }
    exports.init(sampleRate);

    // 파라미터 순서가 어긋나면 조용히 엉뚱한 소리가 난다 (드라이브가 톤 자리에 들어가는 식).
    // 양쪽이 각자 상수를 들고 있으므로 여기서 대조한다
    const expected = exports.param_count();
    if (expected !== WASM_PARAM_COUNT) {
      throw new WasmEngineError(
        `파라미터 개수 불일치: wasm ${expected}, JS ${WASM_PARAM_COUNT} — 한쪽만 고쳤다`,
      );
    }
    return new WasmVoiceEngine(exports);
  }

  /** 발음. 반환값은 쓰인 보이스 번호 */
  noteOn(
    freqHz: number,
    velocity: number,
    params: Readonly<Record<string, ParamValue>>,
    gain = 1,
  ): number {
    this.refreshViews();
    WASM_PARAM_ORDER.forEach((key, i) => {
      const value = params[key];
      this.paramView[i] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
    const voice = this.exports.note_on(freqHz, velocity, gain);
    this.refreshViews(); // note_on 안에서 자랐을 수 있다
    return voice;
  }

  /**
   * **발음 중인 보이스에** 파라미터를 반영한다 (`sound.md` 9-6 튜닝 도구).
   * 현재 주파수로 루프를 다시 계산하므로 음정은 유지된다. 단 큰 폭으로 움직이면
   * 클릭이 난다 — 파라미터 스무딩(`sound.md` 6-4)은 아직 없다.
   */
  setParamsLive(params: Readonly<Record<string, ParamValue>>, voice = 0xffffffff): void {
    this.refreshViews();
    WASM_PARAM_ORDER.forEach((key, i) => {
      const value = params[key];
      this.paramView[i] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
    this.exports.set_params_live(voice);
    this.refreshViews();
  }

  noteOff(voice: number, releaseMs = DEFAULT_RELEASE_MS): void {
    this.exports.note_off(voice, releaseMs);
  }

  allOff(): void {
    this.exports.all_off();
  }

  /** 보이스 슬롯 수 (페이드용 여유 포함) */
  get maxVoices(): number {
    return this.exports.max_voices();
  }

  /** 살아 있는(페이드 중이 아닌) 보이스 수. 폴리포니 상한을 넘지 않아야 한다 */
  get liveVoices(): number {
    return this.exports.live_voices();
  }

  /**
   * 한 블록 렌더해서 `out` 에 **모노로 더한다**. 반환값은 아직 울리는 보이스 수.
   * 블록은 최대 2048 프레임이다 — 넘으면 호출자가 쪼개야 한다.
   *
   * 좌우 평균을 쓴다. `stereoWidth = 0` 이면 좌우가 같으므로 **예전과 정확히 같은
   * 값**이 나오고, 폭을 켠 악기도 한쪽만 읽어 음이 사라지는 일이 없다.
   */
  process(out: Float32Array, frames: number): number {
    if (frames > MAX_BLOCK) throw new WasmEngineError(`블록이 너무 크다: ${frames} > ${MAX_BLOCK}`);
    const active = this.exports.process(frames);
    this.refreshViews();
    for (let i = 0; i < frames; i++) {
      out[i] = out[i]! + (this.outputView[i]! + this.outputViewR[i]!) * 0.5;
    }
    return active;
  }

  /**
   * 한 블록 렌더해서 좌우에 **각각 더한다** (`ROADMAP.md` S1-1).
   *
   * 보이스별 좌우 배치는 wasm 안에서 이미 적용돼 있다. 합산한 뒤에는 나눌 수 없으므로
   * 여기서 채널을 만들어 내려 하지 말 것 — 그건 가짜 스테레오다.
   */
  processStereo(left: Float32Array, right: Float32Array, frames: number): number {
    if (frames > MAX_BLOCK) throw new WasmEngineError(`블록이 너무 크다: ${frames} > ${MAX_BLOCK}`);
    const active = this.exports.process(frames);
    this.refreshViews();
    for (let i = 0; i < frames; i++) {
      left[i] = left[i]! + this.outputView[i]!;
      right[i] = right[i]! + this.outputViewR[i]!;
    }
    return active;
  }

  /** 검증·표시용 — 실제로 쓰인 루프 딜레이(샘플)와 루프 이득 */
  inspect(voice: number): { lineDelay: number; loopGain: number } {
    return {
      lineDelay: this.exports.voice_line_delay(voice),
      loopGain: this.exports.voice_loop_gain(voice),
    };
  }
}

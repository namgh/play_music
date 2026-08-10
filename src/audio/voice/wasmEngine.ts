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
  // 표현력 (`ROADMAP.md` S2). 여기도 **0 이면 예전과 같은 소리**다
  'polarizationDetuneCents',
  'polarizationMix',
  'polarizationDecayRatio',
  'playNoiseAmount',
  'sympatheticAmount',
  'variationAmount',
  'sympatheticBaseHz',
  'bodyAmount',
  'bodyHelmholtzHz',
  // **보이싱 세부** — 예전에 Rust 상수로 박혀 있던 값들 (`ROADMAP.md` S4 준비).
  // 전부 0 이면 엔진 기본값으로 떨어져 예전과 같은 소리가 난다
  'velocityReference',
  'panCenterHz',
  'panOctaveSpan',
  'variationGainDepth',
  'variationBrightDepth',
  'variationDecayDepth',
  'detuneRefHz',
  'detuneMinScale',
  'playNoiseMs',
  'playNoiseLevel',
  'stealFadeMs',
  'pickupCoilHz',
  'sympatheticT60Sec',
  'sympatheticDamping',
  'bodyMix',
  // 드럼 막 진동. 모드 1개·비조화도 0 이면 예전과 같은 사인 하나다
  'drumModeCount',
  'drumInharmonicity',
  'drumSnareWires',
  // 신스 두께·움직임. 전부 0 이면 예전과 같은 소리다
  'synthUnison',
  'synthUnisonDetuneCents',
  'synthSubLevel',
  'synthNoiseLevel',
  'synthLfoHz',
  'synthLfoToPitchCents',
  'synthLfoToCutoff',
  // 줄 비조화도 — **줄 길이와 무관하게 직접 지정한다**. 0 이면 stiffness 만 쓴다
  'inharmonicity',
] as const;

/**
 * 사용자가 직접 그린 자유곡선 (`plan.md` 5-4 의 `points`).
 *
 * `tNorm` 은 **음 길이로 정규화된 시간**이라 음을 늘려도 모양이 유지된다.
 * 그래서 길이를 함께 넘겨야 엔진이 초로 되돌릴 수 있다.
 */
export interface FreeCurve {
  points: readonly { tNorm: number; cents: number }[];
  durationSec: number;
}

/**
 * 자유곡선을 엔진에 넘길 형태로. **정렬은 여기서 한다** — 엔진은 오름차순이 아닌
 * 점을 버리므로, 여기서 안 맞추면 화면에는 있는 점이 소리에서 조용히 사라진다.
 */
export function toFreeCurve(
  curve: { points: readonly { tNorm: number; cents: number }[] | null } | null,
  durationSec: number,
): FreeCurve | undefined {
  const points = curve?.points;
  if (!points || points.length === 0 || !(durationSec > 0)) return undefined;
  return {
    points: [...points].sort((a, b) => a.tNorm - b.tNorm),
    durationSec,
  };
}

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

/**
 * 노트 id → 변주 씨앗 (`ROADMAP.md` S2-4).
 *
 * **자유 난수를 쓰면 안 된다.** `plan.md` 5-2 가 "미리듣기 = 내보내기 = 공유본"을
 * 요구하는데, 재생할 때마다 변주가 달라지면 내보낸 파일과 들은 것이 같다는 보장이
 * 깨진다. 노트 id 는 프로젝트에 저장되므로 **파일을 다시 열어도 같은 변주**가 나온다.
 *
 * FNV-1a 32비트 — 짧고, 비슷한 문자열도 잘 흩어진다.
 */
export function variationSeed(noteId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < noteId.length; i++) {
    hash ^= noteId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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
export const WASM_PARAM_COUNT = 72;

interface WasmExports {
  memory: WebAssembly.Memory;
  init(sampleRate: number): void;
  param_buffer(): number;
  curve_buffer(): number;
  voicing_buffer(): number;
  body_mode_capacity(): number;
  sympathetic_string_capacity(): number;
  set_body_modes(count: number): void;
  set_sympathetic_tuning(count: number): void;
  curve_point_capacity(): number;
  set_curve_points(count: number, durationSec: number): void;
  output_buffer(): number;
  output_buffer_right(): number;
  note_on(freqHz: number, velocity: number, gain: number, variationSeed: number): number;
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
  private curveView!: Float32Array;
  private voicingView!: Float32Array;
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
    this.curveView = new Float32Array(
      buffer, this.exports.curve_buffer(), this.exports.curve_point_capacity() * 2,
    );
    this.voicingView = new Float32Array(
      buffer, this.exports.voicing_buffer(), this.exports.body_mode_capacity() * 3,
    );
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
    freeCurve?: FreeCurve,
    variationSeed = 0,
  ): number {
    this.refreshViews();
    this.stageCurvePoints(freeCurve);
    WASM_PARAM_ORDER.forEach((key, i) => {
      const value = params[key];
      this.paramView[i] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
    const voice = this.exports.note_on(freqHz, velocity, gain, variationSeed >>> 0);
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

  /**
   * 자유곡선 점을 **다음 발음 한 번에** 예약한다 (`ROADMAP.md` S1-4).
   *
   * 점이 없으면 예약을 지운다 — 안 지우면 곡선을 그리지 않은 다음 음까지 휘어진다.
   */
  private stageCurvePoints(curve: FreeCurve | undefined): void {
    const points = curve?.points ?? [];
    if (points.length === 0 || !(curve!.durationSec > 0)) {
      this.exports.set_curve_points(0, 0);
      return;
    }
    const capacity = Math.floor(this.curveView.length / 2);
    const count = Math.min(points.length, capacity);
    for (let i = 0; i < count; i++) {
      this.curveView[i * 2] = points[i]!.tNorm;
      this.curveView[i * 2 + 1] = points[i]!.cents;
    }
    this.exports.set_curve_points(count, curve!.durationSec);
  }

  /**
   * 바디 모드를 통째로 바꾼다 (`ROADMAP.md` S4 준비).
   *
   * 예전에는 Rust `const` 라 밖에서 손댈 수 없었다 — 통이 다른 악기를 같은 통으로
   * 만들고 있었다는 뜻이다. 빈 배열이면 엔진 기본 모드로 되돌린다.
   */
  setBodyModes(modes: readonly { ratio: number; gain: number; q: number }[]): void {
    this.refreshViews();
    const capacity = Math.floor(this.voicingView.length / 3);
    const count = Math.min(modes.length, capacity);
    for (let i = 0; i < count; i++) {
      this.voicingView[i * 3] = modes[i]!.ratio;
      this.voicingView[i * 3 + 1] = modes[i]!.gain;
      this.voicingView[i * 3 + 2] = modes[i]!.q;
    }
    this.exports.set_body_modes(count);
    this.refreshViews();
  }

  /** 공명현 조율 (기준음 대비 반음). 빈 배열이면 기본 조율 */
  setSympatheticTuning(semitones: readonly number[]): void {
    this.refreshViews();
    const capacity = this.exports.sympathetic_string_capacity();
    const count = Math.min(semitones.length, capacity);
    for (let i = 0; i < count; i++) this.voicingView[i] = semitones[i]!;
    this.exports.set_sympathetic_tuning(count);
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

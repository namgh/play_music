//! DSP 코어 — WASM ABI.
//!
//! **wasm-bindgen 을 쓰지 않는다.** 숫자와 선형 메모리만 오가므로 브라우저·Node·
//! 나중의 서버가 같은 `.wasm` 을 글루 없이 쓴다. 같은 코드를 서버에서도 돌릴 수
//! 있어야 한다는 요구(`plan.md` 5-2)가 여기 걸려 있다.
//!
//! JS 쪽에서 메모리를 할당하지 않도록 보이스 풀과 출력 버퍼를 여기서 고정 크기로
//! 들고 있는다. 할당자를 오디오 경로에 두면 지연이 튄다.

pub mod amp;
pub mod curve;
pub mod denormal;
pub mod filters;
pub mod interp;
pub mod modal;
pub mod oversample;
pub mod percussion;
pub mod sampler;
pub mod smooth;
pub mod string_voice;
pub mod sympathetic;
pub mod synth;
pub mod voice;

use amp::{AmpChain, AmpCharacter, AmpParams};
use curve::{CurvePoint, PitchCurve, MAX_CURVE_POINTS};
use modal::{ModalMaterial, ModalParams};
use percussion::{DrumKind, DrumParams};
use sampler::{SampleData, SamplerParams};
use string_voice::StringParams;
use symp::SympatheticStrings;
use sympathetic as symp;
use synth::{SynthParams, Waveform};
use voice::{AnyVoice, VoiceKind};

/// 동시에 **울릴 수 있는** 보이스 수 (할당 상한).
pub const POLYPHONY: usize = 32;

/// 보이스 배열의 크기. `POLYPHONY` 를 넘는 8개는 **페이드아웃 전용 여유**다
/// (`WORKPLAN.md` 2-4).
///
/// 클릭의 원인은 울리던 파형이 한 샘플 만에 0 으로 점프하는 것이다. 페이드를 걸려면
/// 뺏긴 보이스가 사라지는 데 시간이 필요한데, 슬롯이 꽉 차 있으면 그 시간을 줄 곳이
/// 없다. 여유를 두면 **새 음을 지연시키지 않고** 뺏긴 음을 페이드아웃할 수 있다.
pub const MAX_VOICES: usize = POLYPHONY + 8;

/// 여유가 없으면 페이드를 걸 곳이 없어 훔칠 때 클릭이 난다.
/// 테스트가 아니라 **컴파일 타임**에 막는다 — 누가 상수를 되돌리면 빌드가 깨져야 한다
const _: () = assert!(MAX_VOICES > POLYPHONY);

/// 보이스를 뺏을 때 걸어 주는 페이드. 짧아서 안 들리고, 없으면 딱 소리가 난다
const STEAL_FADE_MS: f64 = 5.0;

/// 샘플 하나가 담기는 최대 프레임 수 (48kHz 에서 약 8초)
pub const SAMPLE_CAPACITY: usize = 384_000;
pub const MAX_BLOCK: usize = 2048;

/// 파라미터 슬롯 개수. JS 는 이 순서로 f32 배열을 채운다.
///
/// | 인덱스 | 층 |
/// |---|---|
/// | 0~5 | 줄 (진동체) |
/// | 6~10 | 음정 곡선 (0 이면 곡선 없음) |
/// | 11~19 | 앰프 체인 (`amp_enabled` 가 0 이면 통과) |
/// | 20 | 보이스 타입 (0 줄 · 1 모달 · 2 신스 · 3 샘플러) |
/// | 21~23 | 모달 |
/// | 24~28 | 신스 |
/// | 29 | 샘플러 |
/// | 30~33 | 드럼 |
/// | 34~36 | 연주 표현 (스테레오 · 픽업 · 벨로시티 밝기) |
/// | 37~43 | 표현력 (2편광 3개 · 연주 노이즈 · 공명현 2개 · 타건 변주) |
///
/// **층을 분리한다** (`sound.md` 5절·8절): "줄 길이"와 "왜곡"은 서로 다른 층이다.
///
/// 34~36 은 `ROADMAP.md` S1, 37~41 은 S2 에서 **각각 한 번에** 추가했다.
/// 슬롯을 늘리면 Rust·TS·워크렛 세 곳을 같이 고쳐야 하므로 나눠서 늘리지 않는다
/// (로드맵 원칙 1).
pub const PARAM_COUNT: usize = 44;

/// 벨로시티 밝기의 기준점. 이 세기로 쳤을 때 악기 정의의 값이 그대로 쓰인다.
/// 0.7 은 mf(보통 세기)에 해당한다 — 위면 밝아지고 아래면 어두워진다.
const VELOCITY_REFERENCE: f64 = 0.7;

/// 음 높이 → 좌우 위치를 계산할 때 기준이 되는 음 (C4) 과 폭.
/// C4 에서 ±3옥타브를 좌우 끝으로 편다 — 악기 음역 대부분이 이 안에 들어온다.
const PAN_CENTER_HZ: f64 = 261.625_57;
const PAN_OCTAVE_SPAN: f64 = 3.0;

/// 타건 변주의 최대 폭. `variation_amount = 1` 일 때 이만큼까지 벌어진다.
///
/// **음정은 흔들지 않는다.** "음정이 정밀하다"가 제품의 핵심 주장인데
/// 사용자가 0.0센트로 맞춘 음을 엔진이 몰래 흔들면 그 주장이 무너진다
/// (`CLAUDE.md` 타협 불가). 세기·밝기·감쇠만 흔든다.
const VARIATION_GAIN: f64 = 0.12;
const VARIATION_BRIGHT: f64 = 0.08;
const VARIATION_DECAY: f64 = 0.10;

/// 씨앗 하나에서 서로 다른 세 개의 [-1, 1] 값을 뽑는다. **순수 함수.**
///
/// 왜 자유 실행 난수가 아닌가: `plan.md` 5-2 가 "미리듣기 = 내보내기 = 공유본"을
/// 요구한다. 재생할 때마다 달라지면 내보낸 파일과 들은 것이 같다는 보장이 깨진다.
/// 그래서 **음마다 결정론적인 씨앗**(노트 id 에서 유도)에서만 변주를 만든다.
pub fn variation_values(seed: u32) -> (f64, f64, f64) {
    // splitmix 계열 비트 섞기 — 씨앗이 1씩만 달라도 결과가 흩어져야 한다
    let mix = |x: u32| -> f64 {
        // **섞기를 먼저 하고 곱한다.** 곱셈부터 하면 이웃한 씨앗이 상위 비트만
        // 조금 달라져 결과가 뭉친다 — 연속된 음이 사실상 같은 변주를 받는다
        let mut h = x ^ 0x2545_f491;
        h ^= h >> 15;
        h = h.wrapping_mul(0x2c1b_3c6d);
        h ^= h >> 12;
        h = h.wrapping_mul(0x2974_5b3d);
        h ^= h >> 16;
        (h as f64 / u32::MAX as f64) * 2.0 - 1.0
    };
    (mix(seed), mix(seed ^ 0x5bf0_3635), mix(seed ^ 0x27d4_eb2f))
}

struct Engine {
    sample_rate: f64,
    /// 트랙 하나당 워크렛 노드 하나이므로 앰프도 트랙당 하나다.
    /// 보이스들의 합에 걸린다 — 실제 기타도 픽업 하나가 여섯 줄을 함께 읽는다.
    ///
    /// **좌우로 두 벌을 둔다.** 앰프는 비선형이라 좌우를 한 벌로 처리한 뒤 나누면
    /// 보이스별 좌우 배치가 사라진다. `stereo_width = 0` 이면 두 채널의 입력이
    /// 같으므로 출력도 **비트 단위로 같다** — 모노였던 기존 동작이 그대로 보존된다
    amp: AmpChain,
    amp_r: AmpChain,
    amp_enabled: bool,
    /// 공명현 (`ROADMAP.md` S2-5). 앰프와 같은 층 — 보이스 합에 걸린다.
    /// 좌우를 따로 두는 이유도 앰프와 같다 (스테레오 배치를 지우지 않기 위해)
    sympathetic: SympatheticStrings,
    sympathetic_r: SympatheticStrings,
    /// 샘플러 보이스가 쓰는 데이터. JS 가 load_sample 로 채운다
    sample: SampleData,
    /// JS 가 샘플을 써 넣는 곳
    sample_in: Vec<f32>,
    voices: Vec<AnyVoice>,
    /// 보이스별 파라미터
    params: Vec<StringParams>,
    /// 보이스별 게인 (트랙 레벨)
    gains: Vec<f32>,
    /// 보이스별 좌우 게인. 발음 시점의 음 높이로 정해진다 (`pan_gains`)
    pan_l: Vec<f32>,
    pan_r: Vec<f32>,
    out: Vec<f32>,
    out_r: Vec<f32>,
    /// 보이스별 합산용. 미리 잡아 둔다 — process() 에서 할당하지 않는다
    scratch: Vec<f32>,
    /// JS 가 파라미터를 써 넣는 곳
    param_in: Vec<f32>,
    /// JS 가 자유곡선 점을 써 넣는 곳. `[t_norm, cents]` 를 번갈아 쓴다.
    /// **다음 `note_on` 한 번에만 적용되고 소비된다** — 남겨 두면 곡선을 안 그린
    /// 음까지 휘어진다
    curve_in: Vec<f32>,
    curve_point_count: usize,
    curve_duration_sec: f64,
    /// 보이스별 발음 순번. 뺏을 때 **가장 오래된 것**을 고르는 데 쓴다
    ages: Vec<u64>,
    /// 다음 발음에 줄 순번 (단조 증가)
    note_counter: u64,
}

static mut ENGINE: Option<Engine> = None;

fn engine() -> &'static mut Engine {
    // wasm 은 단일 스레드다. 오디오 워크렛과 메인 스레드가 각자 자기 인스턴스를 갖는다
    unsafe {
        let ptr = &raw mut ENGINE;
        (*ptr).as_mut().expect("init() 를 먼저 불러야 한다")
    }
}

/// 엔진 초기화. 샘플레이트가 바뀌면 다시 부른다
#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let sr = sample_rate as f64;
    let engine = Engine {
        sample_rate: sr,
        amp: AmpChain::new(sr),
        amp_r: AmpChain::new(sr),
        amp_enabled: false,
        sympathetic: SympatheticStrings::new(sr),
        sympathetic_r: SympatheticStrings::new(sr),
        voices: (0..MAX_VOICES)
            .map(|i| AnyVoice::new(sr, 0x2f6e2b1u32.wrapping_add(i as u32 * 2654435761)))
            .collect(),
        sample: SampleData::empty(),
        sample_in: vec![0.0; SAMPLE_CAPACITY],
        params: vec![StringParams::default(); MAX_VOICES],
        gains: vec![1.0; MAX_VOICES],
        pan_l: vec![1.0; MAX_VOICES],
        pan_r: vec![1.0; MAX_VOICES],
        out: vec![0.0; MAX_BLOCK],
        out_r: vec![0.0; MAX_BLOCK],
        scratch: vec![0.0; MAX_BLOCK],
        param_in: vec![0.0; PARAM_COUNT],
        curve_in: vec![0.0; MAX_CURVE_POINTS * 2],
        curve_point_count: 0,
        curve_duration_sec: 0.0,
        ages: vec![0; MAX_VOICES],
        note_counter: 0,
    };
    unsafe {
        let ptr = &raw mut ENGINE;
        *ptr = Some(engine);
    }
}

/// JS 가 파라미터를 써 넣을 f32 배열의 주소
#[no_mangle]
pub extern "C" fn param_buffer() -> *mut f32 {
    engine().param_in.as_mut_ptr()
}

/// JS 가 자유곡선 점을 써 넣을 f32 배열의 주소.
/// `[t_norm0, cents0, t_norm1, cents1, ...]` 순서이고 최대 `curve_point_capacity()` 개다.
#[no_mangle]
pub extern "C" fn curve_buffer() -> *mut f32 {
    engine().curve_in.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn curve_point_capacity() -> u32 {
    MAX_CURVE_POINTS as u32
}

/// `curve_buffer()` 에 써 넣은 점들을 **다음 `note_on` 한 번에** 적용한다.
///
/// 왜 파라미터 슬롯이 아닌가: 점은 개수가 가변이라 고정 슬롯에 안 들어간다.
/// 왜 한 번만 쓰이나: 남겨 두면 **곡선을 그리지 않은 다음 음까지 휘어진다.**
/// 노트오프(`WORKPLAN.md` 2-2)와 같은 이유로 상태를 오래 들고 있지 않는다.
///
/// `count = 0` 이면 예약을 지운다.
#[no_mangle]
pub extern "C" fn set_curve_points(count: u32, duration_sec: f32) {
    let e = engine();
    e.curve_point_count = (count as usize).min(MAX_CURVE_POINTS);
    e.curve_duration_sec = duration_sec as f64;
}

/// 왼쪽 출력 버퍼의 주소 (f32, MAX_BLOCK 개)
#[no_mangle]
pub extern "C" fn output_buffer() -> *const f32 {
    engine().out.as_ptr()
}

/// 오른쪽 출력 버퍼의 주소.
///
/// 좌우를 인터리브하지 않고 **따로 둔다.** Web Audio 의 출력이 채널별 배열(planar)
/// 이라 인터리브로 주면 워크렛이 매 샘플 갈라내야 한다.
#[no_mangle]
pub extern "C" fn output_buffer_right() -> *const f32 {
    engine().out_r.as_ptr()
}

/// 음 높이 → 좌우 게인. **순수 함수라 테스트가 직접 검증한다.**
///
/// 왜 음 높이인가: 실제로 마이크로 잡은 피아노·말렛·하프는 낮은 음이 한쪽, 높은 음이
/// 반대쪽에서 들린다. 소리를 내는 지점이 실제로 떨어져 있기 때문이다. 보이스마다
/// 게인 두 개를 곱하는 것뿐이라 **CPU 가 사실상 0** 이다.
///
/// `width = 0` 이면 좌우가 정확히 1.0 으로 같다 — 모노였던 기존 동작과 **비트 단위로
/// 같은 출력**이 나온다. 그래서 이 값을 켜지 않은 악기는 아무 영향도 받지 않는다.
///
/// 등가 파워 팬을 쓰되 중앙이 1.0 이 되게 맞춘다. 중앙을 0.707 로 두는 관례를 그대로
/// 쓰면 **오늘까지 나던 소리가 갑자기 3dB 작아진다.**
pub fn pan_gains(freq_hz: f64, width: f64) -> (f32, f32) {
    let width = width.clamp(0.0, 1.0);
    // NaN 도 여기서 걸러진다 — 비교가 전부 거짓이라 `> 0.0` 이 성립하지 않는다
    if !(width > 0.0 && freq_hz > 0.0) {
        return (1.0, 1.0);
    }
    let octaves = (freq_hz / PAN_CENTER_HZ).log2() / PAN_OCTAVE_SPAN;
    let pan = octaves.clamp(-1.0, 1.0) * width;
    // -1 → 0, 0 → π/4, +1 → π/2
    let theta = (pan + 1.0) * core::f64::consts::FRAC_PI_4;
    let norm = core::f64::consts::SQRT_2;
    ((theta.cos() * norm) as f32, (theta.sin() * norm) as f32)
}

/// 벨로시티 → 밝기 보정값. **순수 함수.**
///
/// 지금까지 벨로시티는 진폭만 바꿨다. 실제 악기는 세게 치면 **밝아진다** — 그게 없으면
/// 벨로시티 레인을 아무리 그려도 볼륨 오토메이션으로만 들린다 (`ROADMAP.md` S1-2).
///
/// 반환값은 "밝기 파라미터에 더할 양"이다. 보이스마다 밝기를 담당하는 파라미터가
/// 다르므로(줄은 뜯는 세기, 신스는 컷오프) 더하는 쪽은 호출자가 정한다.
pub fn velocity_brightness(velocity: f64, amount: f64) -> f64 {
    amount.clamp(0.0, 1.0) * (velocity.clamp(0.0, 1.0) - VELOCITY_REFERENCE)
}

/// `bright` 는 `velocity_brightness()` 가 준 보정값이다. 발음이 아닌 경로
/// (`set_params_live`)에서는 0 을 넘긴다 — 그쪽에는 벨로시티가 없다.
fn read_params(bright: f64) -> StringParams {
    let p = &engine().param_in;
    StringParams {
        scale_length_mm: p[0] as f64,
        stiffness: p[1] as f64,
        damping: p[2] as f64,
        sustain_sec: p[3] as f64,
        pluck_position: p[4] as f64,
        // 세게 뜯으면 더 단단하게(= 밝게) 뜯은 것이 된다.
        // `fill_excitation` 이 이 값으로 여진 노이즈의 저역통과를 정한다
        pluck_hardness: (p[5] as f64 + bright).clamp(0.0, 1.0),
        polarization_detune_cents: p[37] as f64,
        polarization_mix: p[38] as f64,
        polarization_decay_ratio: if p[39] > 0.0 { p[39] as f64 } else { 0.35 },
    }
}

fn read_stereo_width() -> f64 {
    engine().param_in[34] as f64
}

fn read_velocity_brightness(velocity: f64) -> f64 {
    velocity_brightness(velocity, engine().param_in[36] as f64)
}

fn read_sympathetic() -> (f64, f64) {
    let p = &engine().param_in;
    (p[41] as f64, p[43] as f64)
}

fn read_play_noise_amount() -> f64 {
    (engine().param_in[40] as f64).clamp(0.0, 1.0)
}

fn read_variation_amount() -> f64 {
    (engine().param_in[42] as f64).clamp(0.0, 1.0)
}

fn read_voice_kind() -> VoiceKind {
    VoiceKind::from_index(engine().param_in[20] as u32)
}

fn read_modal(bright: f64) -> ModalParams {
    let p = &engine().param_in;
    ModalParams {
        material: ModalMaterial::from_index(p[21] as u32),
        decay_sec: p[22] as f64,
        strike_position: p[23] as f64,
        // 뜯는 세기와 같은 슬롯을 쓴다 (타격 세기). 세게 때리면 밝아진다
        strike_hardness: (p[4] as f64 + bright).clamp(0.0, 1.0),
    }
}

fn read_synth(bright: f64) -> SynthParams {
    let p = &engine().param_in;
    SynthParams {
        waveform: Waveform::from_index(p[24] as u32),
        detune_cents: p[25] as f64,
        // 신스의 밝기는 필터 컷오프다. 옥타브(비율)로 움직여야 저역·고역에서 같은
        // 느낌이 난다 — 헤르츠로 더하면 낮은 컷오프에서만 크게 변한다
        cutoff_hz: p[26] as f64 * (bright * 2.0).exp2(),
        resonance: p[27] as f64,
        filter_env: p[28] as f64,
        // 엔벌로프는 줄 슬롯을 재사용한다 — 신스에는 줄 파라미터가 의미 없다
        attack_ms: p[0] as f64,
        decay_ms: p[1] as f64,
        sustain: p[2] as f64,
        release_ms: p[3] as f64,
        drive: p[13] as f64,
    }
}

fn read_sampler() -> SamplerParams {
    let p = &engine().param_in;
    SamplerParams {
        preserve_formant: p[29] > 0.5,
        start: p[4] as f64,
        level: p[5] as f64,
    }
}

fn read_drum(bright: f64) -> DrumParams {
    let p = &engine().param_in;
    DrumParams {
        kind: DrumKind::from_index(p[30] as u32),
        decay_sec: p[31] as f64,
        pitch_drop: p[32] as f64,
        noise_amount: p[33] as f64,
        // 때리는 위치 슬롯을 밝기로 재사용. 세게 치면 밝아진다
        tone: (p[23] as f64 + bright).clamp(0.0, 1.0),
    }
}

fn read_amp() -> (bool, AmpParams) {
    let p = &engine().param_in;
    let enabled = p[11] > 0.5;
    (
        enabled,
        AmpParams {
            character: AmpCharacter::from_index(p[12] as u32),
            drive: p[13] as f64,
            tone_low: p[14] as f64,
            tone_mid: p[15] as f64,
            tone_high: p[16] as f64,
            level: p[17] as f64,
            cabinet: p[18] > 0.5,
            pickup_position: p[19] as f64,
            // 코일 종류가 공진 주파수를 정한다 (`ROADMAP.md` S1-3).
            //
            // 험버커는 코일 두 개가 직렬이라 인덕턴스가 커지고 공진이 아래로 내려간다
            // — 그래서 더 두껍고 어둡게 들린다. 싱글코일은 그 반대다.
            // 예전에는 이 값이 픽업 **위치**에서 파생돼서, 스트랫과 레스폴의 차이가
            // 줄 길이 20mm 뿐이었다
            pickup_coil_hz: if p[35] > 0.5 { 3000.0 } else { 6500.0 }
                + (1.0 - p[19] as f64) * 1000.0,
        },
    )
}

/// 곡선을 읽는다. 자유곡선 점이 예약돼 있으면 그것이 **글라이드·비브라토를 대신한다**
/// (`plan.md` 5-4: "사용자가 그리면 `points` 가 우선").
fn read_curve() -> PitchCurve {
    let e = engine();
    let p = &e.param_in;
    let mut curve = PitchCurve {
        glide_cents: p[6] as f64,
        glide_ms: p[7] as f64,
        vibrato_cents: p[8] as f64,
        vibrato_hz: p[9] as f64,
        vibrato_delay_ms: p[10] as f64,
        ..Default::default()
    };
    if e.curve_point_count > 0 {
        // 스택 배열을 쓴다 — **오디오 경로에서 힙을 건드리면 지연이 튄다.**
        // note_on 은 워크렛 스레드에서 불린다
        let mut raw = [CurvePoint::default(); MAX_CURVE_POINTS];
        let n = e.curve_point_count.min(MAX_CURVE_POINTS);
        for (i, slot) in raw[..n].iter_mut().enumerate() {
            *slot = CurvePoint {
                t_norm: e.curve_in[i * 2] as f64,
                cents: e.curve_in[i * 2 + 1] as f64,
            };
        }
        curve.set_points(&raw[..n], e.curve_duration_sec);
    }
    curve
}

/// 할당 결정 (`WORKPLAN.md` 2-4). **순수 함수라 테스트가 직접 검증한다** —
/// 보이스 풀은 전역 상태 뒤에 있어서 밖에서 재현하기 어렵다.
///
/// 반환: `(페이드를 걸 보이스, 새 음이 들어갈 슬롯)`
///
/// **가장 조용한 것을 찾지 않는 이유:** 우리 보이스는 전부 시간이 갈수록 감쇠한다
/// (줄은 T60, 신스는 ADSR, 드럼은 엔벌로프). 그래서 "가장 오래된 것"이 곧 "가장
/// 조용한 것"이고, 진폭 추적기를 보이스마다 돌리는 비용이 필요 없다.
pub fn plan_allocation(
    active: &[bool],
    fading: &[bool],
    ages: &[u64],
    polyphony: usize,
) -> (Option<usize>, usize) {
    let n = active.len();
    let oldest_live = (0..n)
        .filter(|&i| active[i] && !fading[i])
        .min_by_key(|&i| ages[i]);

    // 폴리포니 상한을 넘으면 가장 오래된 것을 페이드아웃시켜 자리를 만든다.
    // 즉시 리셋하지 않으므로 **클릭이 나지 않는다**
    let live = (0..n).filter(|&i| active[i] && !fading[i]).count();
    let victim = if live >= polyphony { oldest_live } else { None };

    let slot = match (0..n).find(|&i| !active[i]) {
        Some(i) => i,
        // 페이드용 여유까지 다 찼다 — 5ms 안에 8음이 더 들어온 극단적인 경우다.
        // 가장 오래된 것을 즉시 재사용한다 (클릭이 나지만 음을 버리는 것보다 낫다)
        None => (0..n).min_by_key(|&i| ages[i]).unwrap_or(0),
    };

    (victim, slot)
}

fn allocate_voice(e: &mut Engine) -> usize {
    // 스택 배열 — 오디오 경로에서 힙을 건드리지 않는다
    let mut active = [false; MAX_VOICES];
    let mut fading = [false; MAX_VOICES];
    for i in 0..MAX_VOICES {
        active[i] = e.voices[i].is_active();
        fading[i] = e.voices[i].is_fading();
    }

    let (victim, slot) = plan_allocation(&active, &fading, &e.ages, POLYPHONY);
    if let Some(i) = victim {
        e.voices[i].start_fade(STEAL_FADE_MS);
    }
    slot
}

/// 발음. `param_buffer()` 를 채운 뒤 부른다. 반환값은 쓰인 보이스 번호
#[no_mangle]
pub extern "C" fn note_on(freq_hz: f32, velocity: f32, gain: f32, variation_seed: u32) -> u32 {
    // 같은 음을 반복하면 완전히 똑같은 파형이 나와 하이햇 16분이 **머신건**이 된다.
    // 변주는 **음마다 결정론적인 씨앗**에서 나온다 (`ROADMAP.md` S2-4) —
    // 자유 난수를 쓰면 미리듣기와 내보내기가 달라진다
    let amount = read_variation_amount();
    let (v_gain, v_bright, v_decay) = if amount > 0.0 {
        variation_values(variation_seed)
    } else {
        (0.0, 0.0, 0.0)
    };

    // 세게 칠수록 밝아진다. 보이스마다 밝기를 담당하는 파라미터가 다르므로
    // 보정값만 구해 두고 적용은 각 `read_*` 가 한다
    let bright = read_velocity_brightness(velocity as f64) + v_bright * amount * VARIATION_BRIGHT;
    let mut params = read_params(bright);
    // 감쇠도 조금씩 다르다 — 실제로 같은 줄을 같은 세기로 두 번 뜯어도 같지 않다
    params.sustain_sec *= 1.0 + v_decay * amount * VARIATION_DECAY;
    let (pan_l, pan_r) = pan_gains(freq_hz as f64, read_stereo_width());
    let e = engine();

    let index = allocate_voice(e);
    e.ages[index] = e.note_counter;
    e.note_counter += 1;

    e.params[index] = params;
    e.gains[index] = gain * (1.0 + v_gain * amount * VARIATION_GAIN) as f32;
    // 좌우 배치는 **발음 시점에 정한다.** 울리는 도중 바뀌면 음이 화면을 가로지른다
    e.pan_l[index] = pan_l;
    e.pan_r[index] = pan_r;

    // 픽·프렛 노이즈. 음정이 없어야 하므로 보이스 밖에서 더한다 (`ROADMAP.md` S2-2)
    engine().voices[index].trigger_play_noise(read_play_noise_amount(), velocity as f64);

    // 보이스 타입에 따라 라우팅한다. **여기가 유일한 분기점**이다 (`sound.md` 9-4)
    match read_voice_kind() {
        VoiceKind::WaveguideString => {
            let curve = read_curve();
            engine().voices[index].note_on_string(freq_hz as f64, velocity as f64, &params, &curve);
        }
        VoiceKind::Modal => {
            let modal = read_modal(bright);
            engine().voices[index].note_on_modal(freq_hz as f64, velocity as f64, &modal);
        }
        VoiceKind::VirtualAnalog => {
            let synth = read_synth(bright);
            engine().voices[index].note_on_synth(freq_hz as f64, velocity as f64, &synth);
        }
        VoiceKind::Percussion => {
            let drum = read_drum(bright);
            engine().voices[index].note_on_drum(freq_hz as f64, velocity as f64, &drum);
        }
        VoiceKind::Sampler => {
            let sampler = read_sampler();
            let e = engine();
            let sample = core::mem::replace(&mut e.sample, SampleData::empty());
            e.voices[index].note_on_sampler(freq_hz as f64, velocity as f64, &sample, &sampler);
            engine().sample = sample;
        }
    }

    // 앰프 파라미터도 같이 온다. 픽업 콤 필터가 줄 주기를 알아야 하므로 주파수를 넘긴다
    // **예약을 여기서 비운다.** 안 비우면 다음 음이 남의 곡선을 물려받는다
    let e = engine();
    e.curve_point_count = 0;
    e.curve_duration_sec = 0.0;

    let (enabled, amp_params) = read_amp();
    let e = engine();
    e.amp_enabled = enabled;
    if enabled {
        // 좌우 두 벌에 **같은 설정**을 넣는다. 다르게 주면 두 대의 앰프가 되어
        // 음색이 좌우로 갈라진다 — 우리가 원하는 건 배치이지 다른 악기가 아니다
        e.amp.set_params(&amp_params, freq_hz as f64);
        e.amp_r.set_params(&amp_params, freq_hz as f64);
    }

    let (symp_amount, symp_base) = read_sympathetic();
    let e = engine();
    e.sympathetic.set(symp_amount, symp_base);
    e.sympathetic_r.set(symp_amount, symp_base);

    index as u32
}

/// 발음 중인 보이스들의 파라미터를 바꾼다 (`sound.md` 9-6 튜닝 도구).
/// `param_buffer()` 를 채운 뒤 부른다. `voice` 가 u32::MAX 면 전체에 적용.
#[no_mangle]
pub extern "C" fn set_params_live(voice: u32) {
    // 튜닝 도구에서 오는 경로다. 벨로시티가 없으므로 밝기 보정은 0 —
    // 악기 정의에 적힌 값이 그대로 들린다
    let params = read_params(0.0);
    let (amp_enabled, amp_params) = read_amp();
    let e = engine();
    e.amp_enabled = amp_enabled;
    if amp_enabled {
        // 픽업 콤은 지금 울리는 음 기준으로 맞춘다
        let freq = e
            .voices
            .iter()
            .find(|v| v.is_active())
            .map_or(220.0, |_| 220.0);
        e.amp.set_params(&amp_params, freq);
        e.amp_r.set_params(&amp_params, freq);
    }
    let synth = read_synth(0.0);
    let e = engine();
    if voice == u32::MAX {
        for i in 0..MAX_VOICES {
            e.params[i] = params;
            e.voices[i].set_string_params_live(&params);
            e.voices[i].set_synth_params_live(&synth);
        }
        return;
    }
    if let Some(v) = e.voices.get_mut(voice as usize) {
        e.params[voice as usize] = params;
        v.set_string_params_live(&params);
        v.set_synth_params_live(&synth);
    }
}

/// 노트오프. `release_ms` 는 줄·모달·샘플러의 뮤트 속도다 (신스는 자기 ADSR 릴리즈를
/// 쓰고, 타악기는 무시한다 — `voice.rs` 의 `note_off` 참고).
///
/// `release_ms` 를 파라미터 슬롯이 아니라 인자로 받는 이유: 이 값은 발음마다 바뀌는
/// 게 아니라 노트오프 시점에만 필요하다. 슬롯을 늘리면 Rust·TS·워크렛 세 곳의
/// `PARAM_COUNT` 를 같이 고쳐야 하고, 어긋나면 조용히 엉뚱한 소리가 난다
/// (`HANDOFF.md` 작업 규칙).
#[no_mangle]
pub extern "C" fn note_off(voice: u32, release_ms: f32) {
    let e = engine();
    if let Some(v) = e.voices.get_mut(voice as usize) {
        v.note_off(release_ms as f64);
    }
}

#[no_mangle]
pub extern "C" fn all_off() {
    let e = engine();
    for v in e.voices.iter_mut() {
        v.reset();
    }
    e.amp.reset();
    e.amp_r.reset();
    e.sympathetic.reset();
    e.sympathetic_r.reset();
}

/// 한 블록 렌더. `output_buffer()` 에 결과가 들어간다.
/// 반환값은 아직 울리고 있는 보이스 수 — 0이면 호출자가 쉬어도 된다
#[no_mangle]
pub extern "C" fn process(frames: u32) -> u32 {
    let n = (frames as usize).min(MAX_BLOCK);
    let e = engine();

    for v in e.out[..n].iter_mut() {
        *v = 0.0;
    }
    for v in e.out_r[..n].iter_mut() {
        *v = 0.0;
    }

    // 보이스별 게인이 다르므로 한 번에 합산할 수 없다. 미리 잡아 둔 스크래치를 재사용한다
    let mut active = 0;
    for i in 0..MAX_VOICES {
        if !e.voices[i].is_active() {
            continue;
        }
        active += 1;
        for v in e.scratch[..n].iter_mut() {
            *v = 0.0;
        }
        // 보이스와 스크래치를 동시에 빌리지 못하므로 스크래치를 잠깐 떼어 낸다
        let mut scratch = core::mem::take(&mut e.scratch);
        let sample = core::mem::replace(&mut e.sample, SampleData::empty());
        e.voices[i].process(&mut scratch[..n], &sample);
        e.sample = sample;
        // 좌우 게인을 여기서 곱한다. 보이스마다 배치가 다르므로 합산한 뒤에는 못 나눈다
        let gain_l = e.gains[i] * e.pan_l[i];
        let gain_r = e.gains[i] * e.pan_r[i];
        for (dst, src) in e.out[..n].iter_mut().zip(scratch[..n].iter()) {
            *dst += *src * gain_l;
        }
        for (dst, src) in e.out_r[..n].iter_mut().zip(scratch[..n].iter()) {
            *dst += *src * gain_r;
        }
        e.scratch = scratch;
    }

    // 공명현은 **앰프 앞**이다. 실제 악기에서도 줄이 먼저 울고 그 소리가 픽업에
    // 잡힌다 — 뒤에 두면 앰프 왜곡이 공명까지 밀어붙여 지저분해진다
    if e.sympathetic.is_enabled() {
        let mut out = core::mem::take(&mut e.out);
        e.sympathetic.process(&mut out[..n]);
        e.out = out;
        let mut out_r = core::mem::take(&mut e.out_r);
        e.sympathetic_r.process(&mut out_r[..n]);
        e.out_r = out_r;
    }

    // 앰프 체인은 보이스 합에 걸린다 (`sound.md` 5절의 신호 체인 순서).
    // 좌우를 각각 통과시킨다 — 비선형이라 합쳐서 처리한 뒤 나눌 수 없다
    if e.amp_enabled {
        let mut out = core::mem::take(&mut e.out);
        e.amp.process(&mut out[..n]);
        e.out = out;
        let mut out_r = core::mem::take(&mut e.out_r);
        e.amp_r.process(&mut out_r[..n]);
        e.out_r = out_r;
    }

    active
}

/// 마지막 발음에서 실제로 쓰인 루프 딜레이 — 검증·표시용
#[no_mangle]
pub extern "C" fn voice_line_delay(voice: u32) -> f32 {
    engine()
        .voices
        .get(voice as usize)
        .map(|v| v.line_delay() as f32)
        .unwrap_or(0.0)
}

#[no_mangle]
pub extern "C" fn voice_loop_gain(voice: u32) -> f32 {
    engine()
        .voices
        .get(voice as usize)
        .map(|v| v.loop_gain() as f32)
        .unwrap_or(0.0)
}

/// 샘플 데이터를 넣을 버퍼의 주소. `load_sample` 전에 여기에 f32 로 써 넣는다.
/// 최대 길이는 `sample_capacity()`.
#[no_mangle]
pub extern "C" fn sample_buffer() -> *mut f32 {
    engine().sample_in.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn sample_capacity() -> u32 {
    SAMPLE_CAPACITY as u32
}

/// `sample_buffer()` 에 써 넣은 `frames` 개를 샘플로 등록한다.
/// `root_hz` 가 0 이면 음정 없는 샘플(드럼)로 취급해 이조하지 않는다.
#[no_mangle]
pub extern "C" fn load_sample(frames: u32, sample_rate: f32, root_hz: f32) {
    let count = (frames as usize).min(SAMPLE_CAPACITY);
    let e = engine();
    e.sample = SampleData {
        frames: e.sample_in[..count].to_vec(),
        sample_rate: sample_rate as f64,
        root_hz: root_hz as f64,
    };
}

/// 파라미터 슬롯 개수. JS 쪽 `WASM_PARAM_ORDER` 와 맞는지 확인하는 데 쓴다.
///
/// 순서나 개수가 어긋나면 **조용히 엉뚱한 소리가 난다** — 예를 들어 드라이브 값이
/// 톤 노브 자리에 들어간다. 양쪽이 각자 상수를 들고 있으므로 대조할 방법이 필요하다.
#[no_mangle]
pub extern "C" fn param_count() -> u32 {
    PARAM_COUNT as u32
}

#[no_mangle]
pub extern "C" fn sample_rate() -> f32 {
    engine().sample_rate as f32
}

/// 보이스 슬롯 수. 워크렛이 **보이스별 소유권 표**를 이 크기로 잡는다.
///
/// 왜 필요한가: 노트오프는 발음보다 나중에 실행되는데, 그 사이에 보이스를 뺏기면
/// 그 슬롯에는 이미 다른 음이 들어 있다. 그때 노트오프를 그냥 적용하면 **엉뚱한 음이
/// 잘린다.** 워크렛이 슬롯마다 "지금 누구 것인가"를 들고 있어야 막을 수 있다.
#[no_mangle]
pub extern "C" fn max_voices() -> u32 {
    MAX_VOICES as u32
}

/// 살아 있는(페이드 중이 아닌) 보이스 수. `POLYPHONY` 를 넘지 않아야 한다.
///
/// `process()` 가 돌려주는 "울리는 보이스 수"에는 페이드아웃 중인 것도 들어가므로
/// 폴리포니 상한을 그것만으로는 검증할 수 없다. 테스트가 이 값을 본다.
#[no_mangle]
pub extern "C" fn live_voices() -> u32 {
    let e = engine();
    e.voices
        .iter()
        .filter(|v| v.is_active() && !v.is_fading())
        .count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `active`·`fading`·`ages` 를 짧게 만드는 도우미. 길이는 슬롯 수
    fn pool(spec: &[(bool, bool, u64)]) -> (Vec<bool>, Vec<bool>, Vec<u64>) {
        (
            spec.iter().map(|s| s.0).collect(),
            spec.iter().map(|s| s.1).collect(),
            spec.iter().map(|s| s.2).collect(),
        )
    }

    #[test]
    fn free_slot_is_used_without_stealing() {
        // 여유가 있으면 아무것도 뺏지 않는다
        let (a, f, g) = pool(&[(true, false, 0), (false, false, 0), (false, false, 0)]);
        let (victim, slot) = plan_allocation(&a, &f, &g, 2);
        assert_eq!(victim, None, "뺏을 필요가 없는데 뺏었다");
        assert_eq!(slot, 1);
    }

    #[test]
    fn steals_the_oldest_not_round_robin() {
        // 라운드로빈이면 방금 친 음을 죽일 수 있다. 나이가 가장 작은 것을 골라야 한다
        let (a, f, g) = pool(&[
            (true, false, 30),
            (true, false, 10), // 가장 오래된 것
            (true, false, 20),
            (false, false, 0), // 페이드용 여유
        ]);
        let (victim, slot) = plan_allocation(&a, &f, &g, 3);
        assert_eq!(victim, Some(1), "가장 오래된 보이스를 고르지 않았다");
        // 새 음은 **여유 슬롯**에 들어간다 — 뺏은 슬롯을 즉시 재사용하면 클릭이 난다
        assert_eq!(slot, 3);
        assert_ne!(slot, victim.unwrap(), "페이드 중인 슬롯을 덮어썼다");
    }

    #[test]
    fn already_fading_voices_do_not_count_toward_polyphony() {
        // 죽는 중인 보이스를 폴리포니로 세면 상한에 못 미치는데도 계속 뺏는다
        let (a, f, g) = pool(&[
            (true, true, 5), // 페이드 중
            (true, false, 10),
            (false, false, 0),
        ]);
        let (victim, slot) = plan_allocation(&a, &f, &g, 2);
        assert_eq!(victim, None, "살아 있는 보이스가 1개인데 뺏었다");
        assert_eq!(slot, 2);
    }

    #[test]
    fn already_fading_voices_are_not_stolen_again() {
        let (a, f, g) = pool(&[
            (true, true, 1), // 가장 오래됐지만 이미 죽는 중
            (true, false, 9),
            (true, false, 8),
            (false, false, 0),
        ]);
        let (victim, _) = plan_allocation(&a, &f, &g, 2);
        assert_eq!(
            victim,
            Some(2),
            "이미 페이드 중인 것을 다시 골랐거나 엉뚱한 것을 골랐다"
        );
    }

    // --- 타건 변주 (S2-4) ---------------------------------------------------

    #[test]
    fn variation_is_deterministic() {
        // **미리듣기 = 내보내기.** 같은 씨앗이면 항상 같은 변주여야 한다
        assert_eq!(variation_values(12345), variation_values(12345));
    }

    #[test]
    fn nearby_seeds_give_scattered_values() {
        // 씨앗이 1씩 달라도 결과가 흩어져야 한다. 안 그러면 연속된 음이
        // 사실상 같은 변주를 받아 머신건이 그대로 남는다
        let a = variation_values(1000).0;
        let b = variation_values(1001).0;
        let c = variation_values(1002).0;
        assert!(
            (a - b).abs() > 0.05 && (b - c).abs() > 0.05,
            "이웃 씨앗이 뭉쳐 있다"
        );
    }

    #[test]
    fn variation_axes_are_independent() {
        // 세 축이 같은 값이면 세기·밝기·감쇠가 함께 움직여 변주가 한 방향이 된다
        let (g, b, d) = variation_values(777);
        assert!((g - b).abs() > 1e-6 && (b - d).abs() > 1e-6 && (g - d).abs() > 1e-6);
    }

    #[test]
    fn variation_stays_in_range() {
        for seed in [0u32, 1, 7, 4242, u32::MAX] {
            let (g, b, d) = variation_values(seed);
            for v in [g, b, d] {
                assert!(
                    (-1.0..=1.0).contains(&v),
                    "씨앗 {seed} 에서 {v} 가 범위를 넘었다"
                );
            }
        }
    }

    // --- 스테레오 배치 (S1-1) ---------------------------------------------

    #[test]
    fn zero_width_is_exactly_mono() {
        // **이게 깨지면 오늘까지 나던 소리가 전부 바뀐다.** 폭을 켜지 않은 악기는
        // 좌우가 1.0 으로 같아야 하고, 그래야 기존 동작이 비트 단위로 보존된다
        for hz in [55.0, 261.6, 1000.0, 4186.0] {
            assert_eq!(pan_gains(hz, 0.0), (1.0, 1.0), "{hz}Hz 에서 모노가 아니다");
        }
    }

    #[test]
    fn center_pitch_stays_centered() {
        // C4 는 기준음이라 폭과 무관하게 가운데
        let (l, r) = pan_gains(PAN_CENTER_HZ, 1.0);
        assert!((l - r).abs() < 1e-6, "기준음이 한쪽으로 치우쳤다");
        assert!(
            (l - 1.0).abs() < 1e-6,
            "중앙 게인이 1.0 이 아니다 — 소리가 작아진다"
        );
    }

    #[test]
    fn low_goes_left_and_high_goes_right() {
        let (low_l, low_r) = pan_gains(PAN_CENTER_HZ / 4.0, 0.5);
        let (high_l, high_r) = pan_gains(PAN_CENTER_HZ * 4.0, 0.5);
        assert!(low_l > low_r, "낮은 음이 왼쪽으로 가지 않았다");
        assert!(high_r > high_l, "높은 음이 오른쪽으로 가지 않았다");
        // 대칭이어야 한다 — 한쪽으로 쏠리면 곡 전체가 기운다
        assert!((low_l - high_r).abs() < 1e-6);
        assert!((low_r - high_l).abs() < 1e-6);
    }

    #[test]
    fn pan_keeps_total_power_constant() {
        // 등가 파워 — 배치를 바꿨다고 소리 크기가 달라지면 안 된다
        for hz in [55.0, 130.8, 261.6, 880.0, 4186.0] {
            let (l, r) = pan_gains(hz, 1.0);
            let power = (l * l + r * r) as f64;
            assert!((power - 2.0).abs() < 1e-5, "{hz}Hz 에서 파워가 {power}");
        }
    }

    #[test]
    fn pan_is_clamped_beyond_the_span() {
        // 음역 밖으로 나가도 완전히 한쪽으로 사라지지 않는다
        let far = pan_gains(1.0, 1.0);
        let edge = pan_gains(PAN_CENTER_HZ / 8.0, 1.0);
        assert_eq!(far, edge, "범위 밖에서 계속 더 왼쪽으로 갔다");
    }

    // --- 벨로시티 → 밝기 (S1-2) -------------------------------------------

    #[test]
    fn velocity_brightness_is_zero_when_disabled() {
        // 기본값은 꺼짐이다. 악기가 켜지 않으면 예전과 같은 소리가 나야 한다
        for v in [0.0, 0.3, 0.7, 1.0] {
            assert_eq!(velocity_brightness(v, 0.0), 0.0);
        }
    }

    #[test]
    fn harder_is_brighter_and_softer_is_darker() {
        assert!(velocity_brightness(1.0, 1.0) > 0.0, "세게 쳐도 안 밝아진다");
        assert!(
            velocity_brightness(0.2, 1.0) < 0.0,
            "약하게 쳐도 안 어두워진다"
        );
        // 기준 세기에서는 악기 정의 값이 그대로 쓰인다
        assert_eq!(velocity_brightness(VELOCITY_REFERENCE, 1.0), 0.0);
    }

    #[test]
    fn velocity_brightness_is_monotonic_and_bounded() {
        let mut prev = f64::NEG_INFINITY;
        for step in 0..=10 {
            let v = step as f64 / 10.0;
            let b = velocity_brightness(v, 1.0);
            assert!(b > prev, "벨로시티가 올라갔는데 밝기가 안 올라갔다");
            assert!(b.abs() <= 1.0, "보정값이 파라미터 범위를 통째로 넘는다");
            prev = b;
        }
    }

    #[test]
    fn full_pool_falls_back_to_the_oldest_slot() {
        // 페이드 여유까지 다 찬 극단적 경우. 음을 버리지 않는다
        let (a, f, g) = pool(&[(true, true, 7), (true, true, 3), (true, false, 5)]);
        let (_, slot) = plan_allocation(&a, &f, &g, 2);
        assert_eq!(slot, 1, "가장 오래된 슬롯을 재사용해야 한다");
    }
}

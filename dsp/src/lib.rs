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
pub mod filters;
pub mod interp;
pub mod modal;
pub mod oversample;
pub mod sampler;
pub mod smooth;
pub mod string_voice;
pub mod synth;
pub mod voice;

use amp::{AmpChain, AmpCharacter, AmpParams};
use curve::PitchCurve;
use modal::{ModalMaterial, ModalParams};
use sampler::{SampleData, SamplerParams};
use string_voice::StringParams;
use synth::{SynthParams, Waveform};
use voice::{AnyVoice, VoiceKind};

pub const MAX_VOICES: usize = 32;

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
///
/// **층을 분리한다** (`sound.md` 5절·8절): "줄 길이"와 "왜곡"은 서로 다른 층이다.
pub const PARAM_COUNT: usize = 30;

struct Engine {
    sample_rate: f64,
    /// 트랙 하나당 워크렛 노드 하나이므로 앰프 체인도 하나면 된다.
    /// 보이스들의 합에 걸린다 — 실제 기타도 픽업 하나가 여섯 줄을 함께 읽는다
    amp: AmpChain,
    amp_enabled: bool,
    /// 샘플러 보이스가 쓰는 데이터. JS 가 load_sample 로 채운다
    sample: SampleData,
    /// JS 가 샘플을 써 넣는 곳
    sample_in: Vec<f32>,
    voices: Vec<AnyVoice>,
    /// 보이스별 파라미터
    params: Vec<StringParams>,
    /// 보이스별 게인 (트랙 레벨)
    gains: Vec<f32>,
    out: Vec<f32>,
    /// 보이스별 합산용. 미리 잡아 둔다 — process() 에서 할당하지 않는다
    scratch: Vec<f32>,
    /// JS 가 파라미터를 써 넣는 곳
    param_in: Vec<f32>,
    next_voice: usize,
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
        amp_enabled: false,
        voices: (0..MAX_VOICES)
            .map(|i| AnyVoice::new(sr, 0x2f6e2b1u32.wrapping_add(i as u32 * 2654435761)))
            .collect(),
        sample: SampleData::empty(),
        sample_in: vec![0.0; SAMPLE_CAPACITY],
        params: vec![StringParams::default(); MAX_VOICES],
        gains: vec![1.0; MAX_VOICES],
        out: vec![0.0; MAX_BLOCK],
        scratch: vec![0.0; MAX_BLOCK],
        param_in: vec![0.0; PARAM_COUNT],
        next_voice: 0,
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

/// 출력 버퍼의 주소 (f32, MAX_BLOCK 개)
#[no_mangle]
pub extern "C" fn output_buffer() -> *const f32 {
    engine().out.as_ptr()
}

fn read_params() -> StringParams {
    let p = &engine().param_in;
    StringParams {
        scale_length_mm: p[0] as f64,
        stiffness: p[1] as f64,
        damping: p[2] as f64,
        sustain_sec: p[3] as f64,
        pluck_position: p[4] as f64,
        pluck_hardness: p[5] as f64,
    }
}

fn read_voice_kind() -> VoiceKind {
    VoiceKind::from_index(engine().param_in[20] as u32)
}

fn read_modal() -> ModalParams {
    let p = &engine().param_in;
    ModalParams {
        material: ModalMaterial::from_index(p[21] as u32),
        decay_sec: p[22] as f64,
        strike_position: p[23] as f64,
        strike_hardness: p[4] as f64, // 뜯는 세기와 같은 슬롯을 쓴다 (타격 세기)
    }
}

fn read_synth() -> SynthParams {
    let p = &engine().param_in;
    SynthParams {
        waveform: Waveform::from_index(p[24] as u32),
        detune_cents: p[25] as f64,
        cutoff_hz: p[26] as f64,
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
            // 코일 특성은 지금 픽업 위치와 함께 하나의 값으로 묶는다.
            // 험버커/싱글코일을 따로 노출하게 되면 슬롯을 하나 더 쓴다
            pickup_coil_hz: 4000.0 + (1.0 - p[19] as f64) * 4000.0,
        },
    )
}

fn read_curve() -> PitchCurve {
    let p = &engine().param_in;
    PitchCurve {
        glide_cents: p[6] as f64,
        glide_ms: p[7] as f64,
        vibrato_cents: p[8] as f64,
        vibrato_hz: p[9] as f64,
        vibrato_delay_ms: p[10] as f64,
    }
}

/// 발음. `param_buffer()` 를 채운 뒤 부른다. 반환값은 쓰인 보이스 번호
#[no_mangle]
pub extern "C" fn note_on(freq_hz: f32, velocity: f32, gain: f32) -> u32 {
    let params = read_params();
    let e = engine();

    // 쉬는 보이스 우선, 없으면 가장 오래된 것을 뺏는다 (보이스 스틸링)
    let index = match e.voices.iter().position(|v| !v.is_active()) {
        Some(i) => i,
        None => {
            let i = e.next_voice;
            e.next_voice = (e.next_voice + 1) % MAX_VOICES;
            i
        }
    };

    e.params[index] = params;
    e.gains[index] = gain;

    // 보이스 타입에 따라 라우팅한다. **여기가 유일한 분기점**이다 (`sound.md` 9-4)
    match read_voice_kind() {
        VoiceKind::WaveguideString => {
            let curve = read_curve();
            engine().voices[index].note_on_string(freq_hz as f64, velocity as f64, &params, &curve);
        }
        VoiceKind::Modal => {
            let modal = read_modal();
            engine().voices[index].note_on_modal(freq_hz as f64, velocity as f64, &modal);
        }
        VoiceKind::VirtualAnalog => {
            let synth = read_synth();
            engine().voices[index].note_on_synth(freq_hz as f64, velocity as f64, &synth);
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
    let (enabled, amp_params) = read_amp();
    let e = engine();
    e.amp_enabled = enabled;
    if enabled {
        e.amp.set_params(&amp_params, freq_hz as f64);
    }
    index as u32
}

/// 발음 중인 보이스들의 파라미터를 바꾼다 (`sound.md` 9-6 튜닝 도구).
/// `param_buffer()` 를 채운 뒤 부른다. `voice` 가 u32::MAX 면 전체에 적용.
#[no_mangle]
pub extern "C" fn set_params_live(voice: u32) {
    let params = read_params();
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
    }
    let synth = read_synth();
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

#[no_mangle]
pub extern "C" fn note_off(voice: u32) {
    let e = engine();
    if let Some(v) = e.voices.get_mut(voice as usize) {
        v.note_off();
    }
}

#[no_mangle]
pub extern "C" fn all_off() {
    let e = engine();
    for v in e.voices.iter_mut() {
        v.reset();
    }
    e.amp.reset();
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
        let gain = e.gains[i];
        for (dst, src) in e.out[..n].iter_mut().zip(scratch[..n].iter()) {
            *dst += *src * gain;
        }
        e.scratch = scratch;
    }

    // 앰프 체인은 보이스 합에 걸린다 (`sound.md` 5절의 신호 체인 순서)
    if e.amp_enabled {
        let mut out = core::mem::take(&mut e.out);
        e.amp.process(&mut out[..n]);
        e.out = out;
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

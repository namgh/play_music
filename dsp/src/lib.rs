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
pub mod synth;
pub mod voice;

use amp::{AmpChain, AmpCharacter, AmpParams};
use curve::PitchCurve;
use modal::{ModalMaterial, ModalParams};
use percussion::{DrumKind, DrumParams};
use sampler::{SampleData, SamplerParams};
use string_voice::StringParams;
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
///
/// **층을 분리한다** (`sound.md` 5절·8절): "줄 길이"와 "왜곡"은 서로 다른 층이다.
pub const PARAM_COUNT: usize = 34;

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

fn read_drum() -> DrumParams {
    let p = &engine().param_in;
    DrumParams {
        kind: DrumKind::from_index(p[30] as u32),
        decay_sec: p[31] as f64,
        pitch_drop: p[32] as f64,
        noise_amount: p[33] as f64,
        tone: p[23] as f64, // 때리는 위치 슬롯을 밝기로 재사용
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
pub extern "C" fn note_on(freq_hz: f32, velocity: f32, gain: f32) -> u32 {
    let params = read_params();
    let e = engine();

    let index = allocate_voice(e);
    e.ages[index] = e.note_counter;
    e.note_counter += 1;

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
        VoiceKind::Percussion => {
            let drum = read_drum();
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

    #[test]
    fn full_pool_falls_back_to_the_oldest_slot() {
        // 페이드 여유까지 다 찬 극단적 경우. 음을 버리지 않는다
        let (a, f, g) = pool(&[(true, true, 7), (true, true, 3), (true, false, 5)]);
        let (_, slot) = plan_allocation(&a, &f, &g, 2);
        assert_eq!(slot, 1, "가장 오래된 슬롯을 재사용해야 한다");
    }
}

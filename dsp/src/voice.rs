//! 보이스 타입 디스패치 (`sound.md` 7절·9-4).
//!
//! > 모든 보이스 타입이 동일한 인터페이스를 구현한다. 사용자와 상위 레이어는
//! > 웨이브가이드인지 샘플인지 알 필요가 없다.
//!
//! > 레지스트리에 등록하면 악기 정의에서 `"voice": "새타입"` 으로 즉시 사용 가능.
//! > **상위 레이어(스케줄러, 보이스 매니저, 믹서, UI)는 손대지 않는다.**
//!
//! 그래서 여기가 유일한 분기점이다. 보이스 타입을 추가할 때 고치는 곳은
//! 이 파일과 그 타입의 모듈뿐이다.

use crate::curve::{cents_to_ratio, PitchCurve};
use crate::modal::{ModalParams, ModalVoice};
use crate::percussion::{DrumParams, DrumVoice};
use crate::sampler::{SampleData, SamplerParams, SamplerVoice};
use crate::string_voice::{StringParams, StringVoice};
use crate::synth::{SynthParams, SynthVoice};

/// 악기 정의의 `voice` 필드에 대응한다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceKind {
    WaveguideString,
    Modal,
    VirtualAnalog,
    Sampler,
    Percussion,
}

impl VoiceKind {
    pub fn from_index(index: u32) -> Self {
        match index {
            0 => Self::WaveguideString,
            1 => Self::Modal,
            2 => Self::VirtualAnalog,
            3 => Self::Sampler,
            _ => Self::Percussion,
        }
    }
}

/// 편광 디튠의 기준 음역과 하한 배율.
///
/// 디튠을 전 음역에 **같은 센트**로 걸면 안 된다. 고음은 딜레이 라인이 짧아 두
/// 편광의 간섭이 세지고, 측정한 기본음이 밀려 **±1센트 회귀 테스트를 깬다**
/// (C6 위에서 실측 1.9센트). 물리적으로도 편광 갈라짐을 7옥타브에 걸쳐 같은
/// 비율로 두는 근거가 없다 — 높고 뻣뻣한 줄일수록 덜 갈린다.
pub const DEFAULT_DETUNE_REF_HZ: f64 = 250.0;
pub const DEFAULT_DETUNE_MIN_SCALE: f64 = 0.25;

/// 음 높이에 따라 줄인 편광 디튠 (센트). **순수 함수라 테스트가 직접 본다.**
pub fn effective_detune_cents(detune_cents: f64, freq_hz: f64) -> f64 {
    effective_detune_cents_with(
        detune_cents,
        freq_hz,
        DEFAULT_DETUNE_REF_HZ,
        DEFAULT_DETUNE_MIN_SCALE,
    )
}

/// 기준음과 하한을 밖에서 정하는 판. **악기마다 다를 수 있다** — 피아노는 저음현이
/// 굵어 갈라짐이 더 크고, 나일론 줄은 덜하다
pub fn effective_detune_cents_with(
    detune_cents: f64,
    freq_hz: f64,
    ref_hz: f64,
    min_scale: f64,
) -> f64 {
    // NaN 을 명시적으로 거른다 — 나누면 결과가 통째로 NaN 이 된다
    if freq_hz.is_nan() || freq_hz <= 0.0 || ref_hz <= 0.0 {
        return detune_cents;
    }
    detune_cents * (ref_hz / freq_hz).clamp(min_scale.clamp(0.0, 1.0), 1.0)
}

/// 연주 노이즈의 감쇠 시간. 픽이 줄을 긁고 지나가는 시간에 해당한다
pub const DEFAULT_PLAY_NOISE_MS: f64 = 7.0;
/// 연주 노이즈의 기본 크기. `play_noise_amount = 1` 일 때의 진폭
pub const DEFAULT_PLAY_NOISE_LEVEL: f64 = 0.18;

/// 픽·프렛 노이즈 (`ROADMAP.md` S2-2).
///
/// 실제 연주에는 줄이 울리기 전에 **픽이 줄을 긁는 소리**가 있고, 손을 옮길 때
/// 감긴 줄에서 프렛 소리가 난다. 지금까지 이게 0 이었고, "진짜 같음"에서 차지하는
/// 지분이 생각보다 크다.
///
/// 줄 모델 **밖에** 둔다. 여진에 섞으면 딜레이 라인을 돌며 음정이 생겨 버리는데,
/// 픽 소리는 음정이 없어야 한다.
struct PlayNoise {
    rng: crate::string_voice::Lcg,
    env: f64,
    sample_rate: f64,
    decay: f64,
    /// 고역만 남기는 일차 고역통과 상태. 저역이 남으면 픽이 아니라 퍽 소리가 된다
    hp_state: f64,
}

impl PlayNoise {
    fn new(sample_rate: f64, seed: u32) -> Self {
        Self {
            rng: crate::string_voice::Lcg(seed | 1),
            env: 0.0,
            sample_rate,
            decay: (-1.0 / (DEFAULT_PLAY_NOISE_MS * 0.001 * sample_rate)).exp(),
            hp_state: 0.0,
        }
    }

    /// `decay_ms`·`level` 은 악기가 정한다 — 나일론 줄의 손톱 소리와 피크로 긁는
    /// 소리는 길이도 세기도 다르다
    fn trigger(&mut self, amount: f64, velocity: f64, decay_ms: f64, level: f64) {
        let ms = if decay_ms > 0.0 {
            decay_ms
        } else {
            DEFAULT_PLAY_NOISE_MS
        };
        self.decay = (-1.0 / (ms * 0.001 * self.sample_rate)).exp();
        // 세게 뜯을수록 픽 소리도 커진다
        let scale = if level > 0.0 {
            level
        } else {
            DEFAULT_PLAY_NOISE_LEVEL
        };
        self.env = amount.clamp(0.0, 1.0) * velocity.clamp(0.0, 1.0) * scale;
        self.hp_state = 0.0;
    }

    fn reset(&mut self) {
        self.env = 0.0;
        self.hp_state = 0.0;
    }

    fn is_active(&self) -> bool {
        self.env > 1e-6
    }

    /// `out` 에 더한다
    fn process(&mut self, out: &mut [f32]) {
        if !self.is_active() {
            return;
        }
        for sample in out.iter_mut() {
            let x = self.rng.next_bipolar();
            let y = x - self.hp_state;
            self.hp_state = x;
            *sample += (y * self.env) as f32;
            self.env *= self.decay;
        }
    }
}

/// 페이드아웃이 끝났다고 보는 진폭 (-80dB). 여기서 보이스를 반환한다
const FADE_END: f64 = 1e-4;

/// 모든 보이스 타입을 담는다. 보이스 하나가 어느 타입이든 될 수 있어야
/// 보이스 풀을 타입별로 쪼개지 않아도 된다
pub struct AnyVoice {
    string: StringVoice,
    /// **두 번째 편광** (`ROADMAP.md` S2-1).
    ///
    /// 실제 줄은 두 방향으로 진동하고 두 주파수가 미세하게 다르다. 그래서 실제 악기는
    /// "빠른 초기 감쇠 + 느린 꼬리"와 맥놀이가 생기는데, 편광이 하나면 지수 감쇠
    /// 하나뿐이라 **"합성음 같다"는 인상의 1순위 원인**이 된다.
    ///
    /// 웨이브가이드를 통째로 하나 더 두는 이유: 음정 정확도가 걸린 코드
    /// (분수 딜레이·위상 보정)를 **한 줄도 건드리지 않기 위해서**다. 파라미터만
    /// 다르게 줘서 검증된 같은 경로를 두 번 태운다.
    string_b: StringVoice,
    /// 두 번째 편광을 섞는 양. 0 이면 아예 돌리지 않는다 (예전과 같은 소리·CPU)
    polarization_mix: f64,
    /// 픽·프렛 노이즈 (`ROADMAP.md` S2-2)
    play_noise: PlayNoise,
    modal: ModalVoice,
    synth: SynthVoice,
    sampler: SamplerVoice,
    drum: DrumVoice,
    kind: VoiceKind,
    sample_rate: f64,

    // --- 페이드아웃 (`WORKPLAN.md` 2-3·2-4) ---
    //
    // 두 곳에서 쓴다:
    //  1. 줄·모달·샘플러의 노트오프 — 손으로 줄을 짚어 죽이는 동작
    //  2. 보이스 훔치기 — 울리던 파형을 한 샘플에 0 으로 끊으면 그게 클릭이다
    //
    /// 지금 페이드 게인. 1.0 = 정상
    fade: f64,
    /// 샘플당 곱하는 감쇠율. 1.0 이면 페이드 중이 아니다
    fade_rate: f64,
}

impl AnyVoice {
    pub fn new(sample_rate: f64, seed: u32) -> Self {
        Self {
            string: StringVoice::new(sample_rate, seed),
            // **여진 씨앗을 같게 준다.** 다르게 주면 두 편광의 위상이 어긋나고, 감쇠
            // 속도가 다르므로 섞이는 비율이 시간에 따라 변하면서 **합의 위상이 천천히
            // 돈다.** 그게 측정된 기본음을 최대 2.7센트까지 민다 (실측). 위상을 맞춰 두면
            // 음정은 그대로면서 "빠른 초기 감쇠 + 느린 꼬리"만 남는다
            string_b: StringVoice::new(sample_rate, seed),
            polarization_mix: 0.0,
            play_noise: PlayNoise::new(sample_rate, seed ^ 0x1234_5678),
            modal: ModalVoice::new(sample_rate),
            synth: SynthVoice::new(sample_rate),
            sampler: SamplerVoice::new(sample_rate),
            drum: DrumVoice::new(sample_rate, seed),
            kind: VoiceKind::WaveguideString,
            sample_rate,
            fade: 1.0,
            fade_rate: 1.0,
        }
    }

    /// 픽·프렛 노이즈를 낸다. **발음 직후에 부른다** — 보이스 타입과 무관하다
    pub fn trigger_play_noise(&mut self, amount: f64, velocity: f64, decay_ms: f64, level: f64) {
        self.play_noise.trigger(amount, velocity, decay_ms, level);
    }

    /// 픽·프렛 노이즈의 씨앗도 음마다 고정한다.
    ///
    /// 줄의 여진과 **같은 이유**다 — 자유 난수를 쓰면 중간부터 미리듣기할 때
    /// 내보내기와 다른 소리가 난다. 여진만 고치고 여기를 빼면 차이가 줄기만 하고
    /// 남는다 (실측: RMS 0.5dB → 0.0002dB 로 줄었지만 파형은 여전히 달랐다).
    ///
    /// 씨앗을 한 번 더 섞는 이유: 여진과 **같은 값을 그대로 쓰면** 두 잡음이
    /// 상관관계를 갖는다. 픽 소리가 줄 여진과 겹쳐 들려 부자연스러워진다
    /// 신스·드럼의 노이즈 씨앗. 줄과 같은 이유로 음마다 고정한다
    pub fn seed_voice_noise(&mut self, seed: u32) {
        self.synth.seed_noise(seed);
        self.drum.seed_noise(seed);
    }

    pub fn seed_play_noise(&mut self, seed: u32) {
        self.play_noise.rng =
            crate::string_voice::Lcg((seed ^ 0x85eb_ca6b).wrapping_mul(0xc2b2_ae35) | 1);
    }

    pub fn kind(&self) -> VoiceKind {
        self.kind
    }

    pub fn is_active(&self) -> bool {
        match self.kind {
            VoiceKind::WaveguideString => {
                self.string.is_active() || self.string_b.is_active() || self.play_noise.is_active()
            }
            VoiceKind::Modal => self.modal.is_active(),
            VoiceKind::VirtualAnalog => self.synth.is_active(),
            VoiceKind::Sampler => self.sampler.is_active(),
            VoiceKind::Percussion => self.drum.is_active(),
        }
    }

    /// 지금 울리는 주파수 (앰프의 픽업 콤이 알아야 한다). 모르면 0
    pub fn freq_hz(&self) -> f64 {
        match self.kind {
            VoiceKind::WaveguideString => self.string.freq_hz(),
            _ => 0.0,
        }
    }

    /// 여진 씨앗을 두 편광 모두에 심는다 — **같은 씨앗을 써야 한다.**
    /// 다르게 주면 두 편광의 위상이 어긋나 음정이 흔들린다 (`HANDOFF.md` 의 2.7센트 함정)
    pub fn seed_string_excitation(&mut self, seed: u32) {
        self.string.seed_excitation(seed);
        self.string_b.seed_excitation(seed);
    }

    pub fn note_on_string(
        &mut self,
        freq_hz: f64,
        velocity: f64,
        params: &StringParams,
        curve: &PitchCurve,
    ) {
        self.begin(VoiceKind::WaveguideString);
        self.kind = VoiceKind::WaveguideString;

        // 두 번째 편광 (`ROADMAP.md` S2-1). 섞는 양이 0 이면 **아예 돌리지 않는다** —
        // 켜지 않은 악기는 소리도 CPU 도 예전 그대로여야 한다
        self.polarization_mix = params.polarization_mix.clamp(0.0, 1.0);
        let m = self.polarization_mix;

        // **디튠은 수명 전체의 에너지로 가중해 나눈다.**
        //
        // 한쪽으로만 걸면 무게중심이 밀려 음정이 통째로 틀어진다(최대 4센트까지 갔다).
        // 그래서 처음에는 *초기 진폭*으로 가중해 나눴다 — 발음 순간에는 정확했다.
        //
        // 그런데 **B 는 먼저 죽는다**(`polarization_decay_ratio`). 시간이 지나면
        // A 만 남고, A 는 플랫하게 디튠돼 있으므로 **지속음의 음정이 플랫해진다.**
        // 실측 -0.72센트 — 편광을 끄면 +0.06센트로 돌아왔다. 오차 전부가 여기였다.
        //
        // 지수 감쇠의 에너지는 진폭²×감쇠시간에 비례한다:
        //   A → 1²·T,  B → m²·(T·r)   ⇒  가중비 w = m²·r
        // 이렇게 나누면 **음 전체를 통틀은 음정**이 목표와 맞는다. 디튠 폭(A~B 간격)은
        // 그대로 d 로 유지되므로 음색은 변하지 않는다.
        //
        // **주파수를 발음 전에 정한다.** 발음 뒤에 루프를 다시 잡으면 이미 채워 둔
        // 여진 길이가 딜레이 라인 길이와 어긋나 DC 모드가 살아난다 (`HANDOFF.md` 3번).
        let d = if m > 0.0 {
            effective_detune_cents_with(
                params.polarization_detune_cents,
                freq_hz,
                params.detune_ref_hz,
                params.detune_min_scale,
            )
        } else {
            0.0
        };
        let decay_ratio = params.polarization_decay_ratio.clamp(0.05, 1.0);
        let w = m * m * decay_ratio;
        let freq_a = freq_hz * cents_to_ratio(-d * w / (1.0 + w));
        self.string.note_on_curved(freq_a, velocity, params, curve);

        if m > 0.0 {
            let mut b = *params;
            // 세로 편광은 브리지에 더 잘 붙어 먼저 죽는다. 이 차이가 "빠른 초기 감쇠 +
            // 느린 꼬리"를 만든다 — 디튠만 주면 그냥 코러스가 된다
            b.sustain_sec = params.sustain_sec * decay_ratio;
            let freq_b = freq_hz * cents_to_ratio(d / (1.0 + w));
            self.string_b.note_on_curved(freq_b, velocity, &b, curve);
        } else {
            self.string_b.reset();
        }
    }

    pub fn note_on_modal(&mut self, freq_hz: f64, velocity: f64, params: &ModalParams) {
        self.begin(VoiceKind::Modal);
        self.kind = VoiceKind::Modal;
        self.modal.note_on(freq_hz, velocity, params);
    }

    pub fn note_on_synth(&mut self, freq_hz: f64, velocity: f64, params: &SynthParams) {
        self.begin(VoiceKind::VirtualAnalog);
        self.kind = VoiceKind::VirtualAnalog;
        self.synth.note_on(freq_hz, velocity, params);
    }

    pub fn note_on_sampler(
        &mut self,
        freq_hz: f64,
        velocity: f64,
        sample: &SampleData,
        params: &SamplerParams,
    ) {
        self.begin(VoiceKind::Sampler);
        self.kind = VoiceKind::Sampler;
        self.sampler.note_on(freq_hz, velocity, sample, params);
    }

    pub fn note_on_drum(&mut self, freq_hz: f64, velocity: f64, params: &DrumParams) {
        self.begin(VoiceKind::Percussion);
        self.kind = VoiceKind::Percussion;
        self.drum.note_on(freq_hz, velocity, params);
    }

    /// 발음 직전의 공통 처리. 타입을 바꿔 재사용할 때 이전 타입이 계속 울리면 안 되고,
    /// 페이드아웃 중인 슬롯을 재사용할 때 게인이 남아 있으면 새 음이 작게 들린다
    fn begin(&mut self, next: VoiceKind) {
        self.fade = 1.0;
        self.fade_rate = 1.0;
        if self.kind == next {
            return;
        }
        match self.kind {
            VoiceKind::WaveguideString => {
                self.string.reset();
                self.string_b.reset();
            }
            VoiceKind::Modal => self.modal.reset(),
            VoiceKind::VirtualAnalog => self.synth.reset(),
            VoiceKind::Sampler => self.sampler.reset(),
            VoiceKind::Percussion => self.drum.reset(),
        }
    }

    /// 노트오프. **보이스 타입마다 뜻이 다르다** (`WORKPLAN.md` 2-3):
    ///
    /// - 타악기는 **무시한다.** 킥을 짧게 눌렀다고 짧아지면 안 된다 — 원샷이 성질이다
    /// - 신스는 자기 ADSR 의 릴리즈로 간다 (`synth.rs` 의 `Stage::Release`)
    /// - 줄·모달·샘플러는 `release_ms` 페이드. 줄을 손으로 짚어 죽이는 동작에 해당한다
    pub fn note_off(&mut self, release_ms: f64) {
        match self.kind {
            VoiceKind::Percussion => {}
            VoiceKind::VirtualAnalog => self.synth.note_off(),
            VoiceKind::WaveguideString | VoiceKind::Modal | VoiceKind::Sampler => {
                self.start_fade(release_ms)
            }
        }
    }

    /// `ms` 안에 -60dB 로 내려가는 페이드아웃을 시작한다. 끝나면 보이스를 반환한다.
    ///
    /// 보이스 훔치기(`lib.rs`)와 줄 뮤트가 같은 장치를 쓴다. 훔기는 5ms 가
    /// 뮤트 120ms 보다 급하므로, 이미 페이드 중이면 **더 빠른 쪽**을 택한다.
    pub fn start_fade(&mut self, ms: f64) {
        if !self.is_active() {
            return;
        }
        let samples = ((ms.max(0.05) / 1000.0) * self.sample_rate).max(1.0);
        let rate = 10f64.powf(-3.0 / samples);
        self.fade_rate = if self.fade_rate < 1.0 {
            self.fade_rate.min(rate)
        } else {
            rate
        };
    }

    /// 페이드아웃 중인가. 훔길 대상을 고를 때 이미 죽는 중인 보이스는 세지 않는다
    pub fn is_fading(&self) -> bool {
        self.fade_rate < 1.0
    }

    pub fn set_string_params_live(&mut self, params: &StringParams) {
        if self.kind == VoiceKind::WaveguideString {
            self.string.set_params_live(params);
            if self.polarization_mix > 0.0 {
                let mut b = *params;
                b.sustain_sec =
                    params.sustain_sec * params.polarization_decay_ratio.clamp(0.05, 1.0);
                self.string_b.set_params_live(&b);
            }
        }
    }

    pub fn set_synth_params_live(&mut self, params: &SynthParams) {
        if self.kind == VoiceKind::VirtualAnalog {
            self.synth.set_params_live(params);
        }
    }

    pub fn reset(&mut self) {
        self.string.reset();
        self.string_b.reset();
        self.play_noise.reset();
        self.modal.reset();
        self.synth.reset();
        self.sampler.reset();
        self.drum.reset();
        self.fade = 1.0;
        self.fade_rate = 1.0;
    }

    /// 한 블록 렌더.
    ///
    /// **`out` 은 0 으로 채워져 있어야 한다.** 내부 보이스들은 `+=` 로 더하지만,
    /// 페이드 게인은 버퍼 전체에 곱하므로 다른 보이스의 소리가 섞여 있으면 그것까지
    /// 깎인다. `lib.rs` 의 `process()` 가 보이스마다 스크래치를 비워서 부른다.
    pub fn process(&mut self, out: &mut [f32], sample: &SampleData) {
        match self.kind {
            VoiceKind::WaveguideString => {
                self.string.process(out);
                if self.polarization_mix > 0.0 {
                    self.string_b.process_scaled(out, self.polarization_mix);
                }
            }
            VoiceKind::Modal => self.modal.process(out),
            VoiceKind::VirtualAnalog => self.synth.process(out),
            VoiceKind::Sampler => self.sampler.process(out, sample),
            VoiceKind::Percussion => self.drum.process(out),
        }

        // 픽·프렛 노이즈는 보이스 타입과 무관하게 얹힌다. 페이드 **앞**에 두어야
        // 보이스를 뺏길 때 노이즈도 같이 사라진다
        self.play_noise.process(out);

        if self.fade_rate >= 1.0 {
            return;
        }
        for v in out.iter_mut() {
            *v = (*v as f64 * self.fade) as f32;
            self.fade *= self.fade_rate;
        }
        // 다 내려갔으면 보이스를 반환한다. 안 하면 풀이 차서 소리가 끊긴다
        if self.fade <= FADE_END {
            self.reset();
        }
    }

    /// 검증·표시용
    pub fn line_delay(&self) -> f64 {
        self.string.setup().line_delay
    }

    pub fn loop_gain(&self) -> f64 {
        self.string.setup().loop_gain
    }
}

#[cfg(test)]
mod polarization_tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn render(params: &StringParams, seconds: f64) -> Vec<f32> {
        let mut voice = AnyVoice::new(FS, 0x1234_5678);
        voice.note_on_string(220.0, 1.0, params, &PitchCurve::default());
        let n = (FS * seconds) as usize;
        let mut out = vec![0.0f32; n];
        // 블록으로 쪼개 돌린다 — 한 번에 넘기면 `process_scaled` 의 스택 버퍼를 넘는다
        for chunk in out.chunks_mut(512) {
            voice.process(chunk, &SampleData::empty());
        }
        out
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }

    fn single() -> StringParams {
        StringParams {
            sustain_sec: 4.0,
            ..Default::default()
        }
    }

    fn dual() -> StringParams {
        StringParams {
            polarization_detune_cents: 1.8,
            polarization_mix: 0.6,
            polarization_decay_ratio: 0.3,
            ..single()
        }
    }

    #[test]
    fn modal_voice_stays_finite() {
        // 실측 도구가 마림바에서 NaN 을 잡았다. 어느 층에서 나오는지 좁힌다
        let mut voice = AnyVoice::new(FS, 0x77);
        let params = crate::modal::ModalParams {
            material: crate::modal::ModalMaterial::Marimba,
            decay_sec: 1.0,
            strike_position: 0.25,
            strike_hardness: 0.0,
        };
        voice.note_on_modal(110.0, 1.0, &params);
        let mut out = vec![0.0f32; 4096];
        for chunk in out.chunks_mut(256) {
            voice.process(chunk, &SampleData::empty());
        }
        let bad = out.iter().position(|v| !v.is_finite());
        assert!(bad.is_none(), "{bad:?} 번 샘플에서 NaN");
    }

    #[test]
    fn play_noise_only_at_the_attack() {
        // 픽 소리는 어택에만 있어야 한다. 계속 남으면 잡음이 낀 악기가 된다
        let mut voice = AnyVoice::new(FS, 0xabcd);
        voice.note_on_string(220.0, 1.0, &single(), &PitchCurve::default());
        voice.trigger_play_noise(1.0, 1.0, 0.0, 0.0);
        let mut out = vec![0.0f32; (FS * 0.2) as usize];
        for chunk in out.chunks_mut(512) {
            voice.process(chunk, &SampleData::empty());
        }
        let window = (FS * 0.005) as usize;
        let early = rms(&out[..window]);
        let later = rms(&out[(FS * 0.1) as usize..(FS * 0.1) as usize + window]);
        assert!(early > later, "어택이 더 크지 않다");
    }

    #[test]
    fn play_noise_is_off_by_default() {
        // 켜지 않은 악기는 예전과 같은 소리여야 한다
        let mut a = AnyVoice::new(FS, 0xabcd);
        a.note_on_string(220.0, 1.0, &single(), &PitchCurve::default());
        a.trigger_play_noise(0.0, 1.0, 0.0, 0.0);
        let mut b = AnyVoice::new(FS, 0xabcd);
        b.note_on_string(220.0, 1.0, &single(), &PitchCurve::default());

        let mut x = vec![0.0f32; 4096];
        let mut y = vec![0.0f32; 4096];
        for c in x.chunks_mut(512) {
            a.process(c, &SampleData::empty());
        }
        for c in y.chunks_mut(512) {
            b.process(c, &SampleData::empty());
        }
        assert_eq!(x, y, "연주 노이즈를 껐는데 소리가 달라졌다");
    }

    #[test]
    fn detune_shrinks_in_the_top_octaves() {
        // 고음에서 그대로 걸면 간섭이 세져 음정 회귀 테스트를 깬다
        let low = effective_detune_cents(1.8, 82.0);
        let mid = effective_detune_cents(1.8, 440.0);
        let high = effective_detune_cents(1.8, 4186.0);
        assert!(low > mid && mid > high, "고음으로 갈수록 줄어들지 않는다");
        assert!((low - 1.8).abs() < 1e-9, "저음은 지정값 그대로여야 한다");
        assert!(high > 0.0, "완전히 사라지면 편광이 하나가 된다");
    }

    #[test]
    fn disabled_polarization_is_bit_identical() {
        // **켜지 않은 악기는 예전과 완전히 같은 소리여야 한다.**
        // 이게 깨지면 이미 맞춰 둔 악기가 전부 흔들린다
        let a = render(&single(), 0.5);
        let b = render(
            &StringParams {
                // 디튠·감쇠비가 들어 있어도 mix 가 0 이면 꺼진 것이다
                polarization_detune_cents: 5.0,
                polarization_mix: 0.0,
                ..single()
            },
            0.5,
        );
        assert_eq!(a, b, "편광을 껐는데 소리가 달라졌다");
    }

    #[test]
    fn two_polarizations_beat_against_each_other() {
        // 맥놀이 = 포락선이 주기적으로 오르내린다. 편광이 하나면 단조 감소뿐이다.
        //
        // **여기서는 기법이 동작하는지만 본다.** 그래서 디튠을 실제 악기보다 크게
        // 주고 두 편광의 감쇠를 같게 맞춘다 — 실제 설정(1.8센트, 빠른 편광이 먼저
        // 죽음)에서는 맥놀이 주기가 4초를 넘고 두 번째 편광이 그 전에 사라져서
        // 있어도 안 보인다. 그건 아래 `fast_polarization_dies_before_the_slow_one`
        // 이 따로 본다
        let beating = StringParams {
            polarization_detune_cents: 12.0, // 220Hz 에서 약 1.5Hz 맥놀이
            polarization_mix: 1.0,
            polarization_decay_ratio: 1.0, // 둘 다 살아 있어야 맥놀이가 보인다
            ..single()
        };
        let x = render(&beating, 3.0);
        let window = (FS * 0.05) as usize;
        let env: Vec<f64> = x.chunks(window).map(rms).collect();
        let rises = env.windows(2).filter(|w| w[1] > w[0] * 1.02).count();
        assert!(rises > 0, "맥놀이가 없다 — 포락선이 단조 감소뿐이다");
    }

    #[test]
    fn single_polarization_decays_monotonically() {
        // 측정기 검증: 편광 하나짜리에서는 위 판정이 **안 걸려야** 한다.
        // 안 그러면 위 테스트가 무엇이든 통과시킨다
        let x = render(&single(), 3.0);
        let window = (FS * 0.05) as usize;
        let env: Vec<f64> = x.chunks(window).map(rms).collect();
        let rises = env.windows(2).filter(|w| w[1] > w[0] * 1.02).count();
        assert_eq!(rises, 0, "편광 하나인데 포락선이 다시 커진다");
    }

    #[test]
    fn fast_polarization_dies_before_the_slow_one() {
        // "빠른 초기 감쇠 + 느린 꼬리" — 실제 줄의 특징이다.
        // 두 번째 편광이 먼저 죽으므로 초반에 비해 꼬리에서 두 소리의 차이가 줄어든다
        let single_x = render(&single(), 3.0);
        let dual_x = render(&dual(), 3.0);
        let at = |x: &[f32], sec: f64| {
            let i = (FS * sec) as usize;
            rms(&x[i..(i + (FS * 0.1) as usize).min(x.len())])
        };
        let early_ratio = at(&dual_x, 0.05) / at(&single_x, 0.05);
        let late_ratio = at(&dual_x, 2.0) / at(&single_x, 2.0);
        assert!(
            early_ratio > late_ratio,
            "빠른 편광이 먼저 죽지 않는다 (초반 {early_ratio:.2}, 꼬리 {late_ratio:.2})"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn render(voice: &mut AnyVoice, n: usize) -> Vec<f32> {
        let empty = SampleData::empty();
        let mut out = vec![0.0f32; n];
        voice.process(&mut out, &empty);
        out
    }

    #[test]
    fn every_kind_makes_sound() {
        let mut voice = AnyVoice::new(FS, 1);

        voice.note_on_string(220.0, 1.0, &StringParams::default(), &PitchCurve::default());
        assert!(
            render(&mut voice, 4096).iter().any(|v| v.abs() > 1e-4),
            "줄"
        );

        voice.note_on_modal(440.0, 1.0, &ModalParams::default());
        assert!(
            render(&mut voice, 4096).iter().any(|v| v.abs() > 1e-4),
            "모달"
        );

        voice.note_on_synth(440.0, 1.0, &SynthParams::default());
        assert!(
            render(&mut voice, 4096).iter().any(|v| v.abs() > 1e-4),
            "신스"
        );

        voice.note_on_drum(50.0, 1.0, &DrumParams::default());
        assert!(
            render(&mut voice, 4096).iter().any(|v| v.abs() > 1e-4),
            "드럼"
        );
    }

    #[test]
    fn switching_kind_silences_the_previous_one() {
        // 타입을 바꿔 재사용할 때 이전 타입이 계속 울리면 두 소리가 섞인다
        let mut voice = AnyVoice::new(FS, 1);
        voice.note_on_string(220.0, 1.0, &StringParams::default(), &PitchCurve::default());
        render(&mut voice, 512);

        voice.note_on_modal(440.0, 1.0, &ModalParams::default());
        assert_eq!(voice.kind(), VoiceKind::Modal);

        // 줄이 꺼졌는지: 모달을 다시 끄면 완전 무음이어야 한다
        voice.reset();
        assert!(render(&mut voice, 512).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn sampler_without_data_is_silent() {
        let mut voice = AnyVoice::new(FS, 1);
        let empty = SampleData::empty();
        voice.note_on_sampler(440.0, 1.0, &empty, &SamplerParams::default());
        assert!(!voice.is_active(), "빈 샘플로 보이스가 잡혔다");
        assert!(render(&mut voice, 512).iter().all(|v| *v == 0.0));
    }

    /// 블록의 최대 진폭
    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    #[test]
    fn string_note_off_actually_silences_the_note() {
        // 이게 배선되기 전에는 노트오프가 `setup` 에만 쓰고 `process` 는 `smooth_*` 를
        // 읽어서 **아무 일도 일어나지 않았다.** 길이가 소리에 반영되지 않는 버그였다
        let mut voice = AnyVoice::new(FS, 1);
        voice.note_on_string(220.0, 1.0, &StringParams::default(), &PitchCurve::default());
        assert!(
            peak(&render(&mut voice, 2048)) > 1e-3,
            "발음 자체가 안 됐다"
        );

        voice.note_off(50.0);
        assert!(voice.is_fading(), "노트오프가 페이드를 걸지 않았다");

        // 50ms = 2400샘플. **버퍼 앞쪽은 페이드 램프 자체라 당연히 소리가 있다** —
        // 꼬리를 봐야 한다 (측정 구간을 잘못 잡아 한 번 헛짚었다)
        let out = render(&mut voice, 8192);
        let tail = &out[4800..]; // 릴리즈의 2배 지난 뒤
        assert!(
            peak(tail) < 1e-3,
            "노트오프 뒤에도 {} 만큼 울린다",
            peak(tail)
        );
        // 램프가 실제로 내려갔는지도 확인한다 — 앞이 뒤보다 커야 한다
        assert!(
            peak(&out[..2400]) > peak(tail) * 10.0,
            "페이드가 단조 감소하지 않았다"
        );
        assert!(
            !voice.is_active(),
            "보이스를 반환하지 않았다 — 풀이 차면 소리가 끊긴다"
        );
    }

    #[test]
    fn fade_is_continuous_no_click() {
        // 클릭의 정의: 인접 샘플 사이의 점프. 페이드는 램프여야 한다
        let mut voice = AnyVoice::new(FS, 1);
        voice.note_on_string(220.0, 1.0, &StringParams::default(), &PitchCurve::default());
        let before = render(&mut voice, 1024);

        voice.start_fade(5.0);
        let after = render(&mut voice, 1024);

        // 경계(before 마지막 → after 첫)에서 튀지 않아야 한다
        let boundary = (after[0] - before[before.len() - 1]).abs();
        let typical = peak(&before);
        assert!(
            boundary < typical * 0.5,
            "페이드 시작에서 {boundary} 만큼 점프했다 (전형 진폭 {typical})"
        );

        // 램프 안에서도 인접 점프가 파형 자체보다 커지면 안 된다
        let max_step = after
            .windows(2)
            .fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()));
        assert!(max_step < typical, "페이드 중 {max_step} 만큼 튀었다");
    }

    #[test]
    fn percussion_ignores_note_off() {
        // 킥을 짧게 눌렀다고 짧아지면 안 된다 — 원샷이 드럼의 성질이다
        let mut voice = AnyVoice::new(FS, 1);
        voice.note_on_drum(50.0, 1.0, &DrumParams::default());
        render(&mut voice, 256);

        voice.note_off(5.0);
        assert!(!voice.is_fading(), "드럼이 노트오프에 반응했다");
        assert!(voice.is_active(), "드럼이 노트오프로 꺼졌다");
    }

    #[test]
    fn synth_note_off_uses_its_own_release_not_the_fade() {
        // 신스는 ADSR 릴리즈가 있다. 페이드로 덮으면 그 곡선이 무의미해진다
        let mut voice = AnyVoice::new(FS, 1);
        voice.note_on_synth(440.0, 1.0, &SynthParams::default());
        render(&mut voice, 512);

        voice.note_off(120.0);
        assert!(
            !voice.is_fading(),
            "신스에 페이드가 걸렸다 — ADSR 릴리즈를 써야 한다"
        );
        // 릴리즈로 갔으므로 결국 스스로 꺼진다
        render(&mut voice, 48000);
        assert!(
            !voice.is_active(),
            "신스가 릴리즈 뒤에도 보이스를 물고 있다"
        );
    }

    #[test]
    fn faster_fade_wins_when_already_fading() {
        // 뮤트(120ms) 중에 보이스를 뺏기면(5ms) 급한 쪽을 따라야 한다.
        // 아니면 뺏은 슬롯이 제때 비지 않는다
        let mut slow = AnyVoice::new(FS, 1);
        slow.note_on_string(220.0, 1.0, &StringParams::default(), &PitchCurve::default());
        render(&mut slow, 256);
        slow.note_off(200.0);
        slow.start_fade(5.0);
        // 5ms = 240샘플. 512샘플 뒤에는 반환돼 있어야 한다
        render(&mut slow, 512);
        assert!(!slow.is_active(), "느린 페이드가 빠른 페이드를 덮어썼다");
    }

    #[test]
    fn reusing_a_fading_slot_restores_full_level() {
        // 페이드 중인 슬롯을 재사용할 때 게인이 남아 있으면 새 음이 작게 들린다
        let mut voice = AnyVoice::new(FS, 1);
        voice.note_on_string(220.0, 1.0, &StringParams::default(), &PitchCurve::default());
        render(&mut voice, 256);
        voice.start_fade(5.0);
        render(&mut voice, 120); // 페이드 중간

        voice.note_on_string(330.0, 1.0, &StringParams::default(), &PitchCurve::default());
        assert!(!voice.is_fading(), "새 발음이 페이드를 지우지 않았다");
        assert!(
            peak(&render(&mut voice, 2048)) > 1e-2,
            "재사용한 보이스의 소리가 눌렸다"
        );
    }

    #[test]
    fn live_params_only_reach_the_matching_kind() {
        let mut voice = AnyVoice::new(FS, 1);
        voice.note_on_modal(440.0, 1.0, &ModalParams::default());
        // 줄 파라미터를 보내도 모달이 깨지지 않아야 한다
        voice.set_string_params_live(&StringParams::default());
        assert!(render(&mut voice, 1024).iter().all(|v| v.is_finite()));
        assert_eq!(voice.kind(), VoiceKind::Modal);
    }
}

#[cfg(test)]
mod polarization_pitch_tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn params_with(mix: f64, detune: f64, decay_ratio: f64) -> StringParams {
        StringParams {
            polarization_mix: mix,
            polarization_detune_cents: detune,
            polarization_decay_ratio: decay_ratio,
            sustain_sec: 4.0,
            ..Default::default()
        }
    }

    fn render(freq: f64, params: &StringParams, seconds: f64) -> Vec<f32> {
        let mut voice = AnyVoice::new(FS, 0x51ee);
        voice.note_on_string(freq, 0.6, params, &PitchCurve::default());
        let mut out = vec![0.0f32; (FS * seconds) as usize];
        let samples = SampleData::empty();
        for chunk in out.chunks_mut(256) {
            voice.process(chunk, &samples);
        }
        out
    }

    /// 포물선 보간으로 서브빈 정밀도. 빈 폭보다 정밀해야 ±0.5센트를 판정할 수 있다
    fn cents_error(signal: &[f32], target: f64) -> f64 {
        let n = 1 << 16;
        let take = signal.len().min(n);
        let mut best = (0.0f64, 0.0f64);
        // 목표 주변만 훑는다 — 비조화 성분에 끌리지 않게
        let step = 0.02; // 센트 단위 탐색은 비싸므로 상관으로 직접 찾는다
        let mut cents = -6.0;
        while cents <= 6.0 {
            let hz = target * 2f64.powf(cents / 1200.0);
            let w = 2.0 * core::f64::consts::PI * hz / FS;
            let (mut re, mut im) = (0.0, 0.0);
            for (i, v) in signal[..take].iter().enumerate() {
                let t = 2.0 * core::f64::consts::PI * i as f64 / take as f64;
                let window = 0.5 - 0.5 * t.cos();
                let s = *v as f64 * window;
                re += s * (w * i as f64).cos();
                im -= s * (w * i as f64).sin();
            }
            let mag = (re * re + im * im).sqrt();
            if mag > best.1 {
                best = (cents, mag);
            }
            cents += step;
        }
        best.0
    }

    /// **지속음의 음정이 목표와 맞아야 한다.**
    ///
    /// 처음에는 *초기 진폭*으로 디튠을 나눴다 — 발음 순간에는 정확했지만, 세로
    /// 편광이 먼저 죽고 나면 남은 쪽이 플랫하게 디튠돼 있어서 **지속음이 플랫**했다.
    /// 실측 -0.72센트. 수명 전체의 에너지(진폭²×감쇠시간)로 가중하니 -0.15센트가 됐다.
    #[test]
    fn dual_polarization_does_not_shift_the_pitch() {
        // **악기 정의가 실제로 쓰는 범위**를 본다 (믹스 0.3~0.55, 디튠 1~1.8).
        //
        // 그보다 넓게 디튠하면 저음에서 두 부분음이 음 길이 안에 분해되지 않는다 —
        // 32.7Hz 에서 3센트는 0.057Hz 차이이고, 그 비트 주기는 17초다. 1초짜리
        // 분석 창에서 읽히는 "음정"은 에너지가 아니라 **초기 위상**에 달려 있어서,
        // 거기서 0.5센트를 요구하는 것은 측정할 수 없는 것을 요구하는 것이다
        for (mix, detune, ratio) in [
            (0.55, 1.8, 0.3), // 하프·기타
            (0.3, 1.0, 0.25), // 피아노
            (0.6, 2.0, 0.4),  // 정의 범위의 가장 바깥
        ] {
            let p = params_with(mix, detune, ratio);
            for freq in [32.7, 110.0, 440.0] {
                let err = cents_error(&render(freq, &p, 2.5), freq);
                assert!(
                    err.abs() <= 0.5,
                    "mix={mix} detune={detune} ratio={ratio} {freq}Hz: {err:.3}센트 (최상 기준 0.5)"
                );
            }
        }
    }

    /// 디튠 폭은 그대로여야 한다 — 음정을 맞추느라 음색을 바꾸면 안 된다
    #[test]
    fn detune_spread_is_preserved() {
        // 편광을 끈 것과 켠 것의 음정 차이가 디튠 폭의 절반을 넘지 않아야 한다.
        // 넘으면 한쪽으로 쏠렸다는 뜻이다
        let with = params_with(0.55, 1.8, 0.3);
        let without = params_with(0.0, 1.8, 0.3);
        let a = cents_error(&render(110.0, &with, 2.5), 110.0);
        let b = cents_error(&render(110.0, &without, 2.5), 110.0);
        assert!(
            (a - b).abs() < 0.9,
            "편광을 켜자 음정이 {:.3}센트 움직였다",
            a - b
        );
    }
}

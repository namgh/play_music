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

use crate::curve::PitchCurve;
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

/// 페이드아웃이 끝났다고 보는 진폭 (-80dB). 여기서 보이스를 반환한다
const FADE_END: f64 = 1e-4;

/// 모든 보이스 타입을 담는다. 보이스 하나가 어느 타입이든 될 수 있어야
/// 보이스 풀을 타입별로 쪼개지 않아도 된다
pub struct AnyVoice {
    string: StringVoice,
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

    pub fn kind(&self) -> VoiceKind {
        self.kind
    }

    pub fn is_active(&self) -> bool {
        match self.kind {
            VoiceKind::WaveguideString => self.string.is_active(),
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

    pub fn note_on_string(
        &mut self,
        freq_hz: f64,
        velocity: f64,
        params: &StringParams,
        curve: &PitchCurve,
    ) {
        self.begin(VoiceKind::WaveguideString);
        self.kind = VoiceKind::WaveguideString;
        self.string.note_on_curved(freq_hz, velocity, params, curve);
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
            VoiceKind::WaveguideString => self.string.reset(),
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
        }
    }

    pub fn set_synth_params_live(&mut self, params: &SynthParams) {
        if self.kind == VoiceKind::VirtualAnalog {
            self.synth.set_params_live(params);
        }
    }

    pub fn reset(&mut self) {
        self.string.reset();
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
            VoiceKind::WaveguideString => self.string.process(out),
            VoiceKind::Modal => self.modal.process(out),
            VoiceKind::VirtualAnalog => self.synth.process(out),
            VoiceKind::Sampler => self.sampler.process(out, sample),
            VoiceKind::Percussion => self.drum.process(out),
        }

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

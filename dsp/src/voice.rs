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
}

impl VoiceKind {
    pub fn from_index(index: u32) -> Self {
        match index {
            0 => Self::WaveguideString,
            1 => Self::Modal,
            2 => Self::VirtualAnalog,
            _ => Self::Sampler,
        }
    }
}

/// 모든 보이스 타입을 담는다. 보이스 하나가 어느 타입이든 될 수 있어야
/// 보이스 풀을 타입별로 쪼개지 않아도 된다
pub struct AnyVoice {
    string: StringVoice,
    modal: ModalVoice,
    synth: SynthVoice,
    sampler: SamplerVoice,
    kind: VoiceKind,
}

impl AnyVoice {
    pub fn new(sample_rate: f64, seed: u32) -> Self {
        Self {
            string: StringVoice::new(sample_rate, seed),
            modal: ModalVoice::new(sample_rate),
            synth: SynthVoice::new(sample_rate),
            sampler: SamplerVoice::new(sample_rate),
            kind: VoiceKind::WaveguideString,
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
        self.stop_others(VoiceKind::WaveguideString);
        self.kind = VoiceKind::WaveguideString;
        self.string.note_on_curved(freq_hz, velocity, params, curve);
    }

    pub fn note_on_modal(&mut self, freq_hz: f64, velocity: f64, params: &ModalParams) {
        self.stop_others(VoiceKind::Modal);
        self.kind = VoiceKind::Modal;
        self.modal.note_on(freq_hz, velocity, params);
    }

    pub fn note_on_synth(&mut self, freq_hz: f64, velocity: f64, params: &SynthParams) {
        self.stop_others(VoiceKind::VirtualAnalog);
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
        self.stop_others(VoiceKind::Sampler);
        self.kind = VoiceKind::Sampler;
        self.sampler.note_on(freq_hz, velocity, sample, params);
    }

    /// 타입을 바꿔 재사용할 때 이전 타입이 계속 울리면 안 된다
    fn stop_others(&mut self, next: VoiceKind) {
        if self.kind == next {
            return;
        }
        match self.kind {
            VoiceKind::WaveguideString => self.string.reset(),
            VoiceKind::Modal => self.modal.reset(),
            VoiceKind::VirtualAnalog => self.synth.reset(),
            VoiceKind::Sampler => self.sampler.reset(),
        }
    }

    pub fn note_off(&mut self) {
        match self.kind {
            VoiceKind::WaveguideString => self.string.note_off(),
            VoiceKind::Modal => self.modal.note_off(),
            VoiceKind::VirtualAnalog => self.synth.note_off(),
            VoiceKind::Sampler => self.sampler.note_off(),
        }
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
    }

    /// `out` 에 **더한다**. 샘플러는 샘플 데이터가 필요하다
    pub fn process(&mut self, out: &mut [f32], sample: &SampleData) {
        match self.kind {
            VoiceKind::WaveguideString => self.string.process(out),
            VoiceKind::Modal => self.modal.process(out),
            VoiceKind::VirtualAnalog => self.synth.process(out),
            VoiceKind::Sampler => self.sampler.process(out, sample),
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

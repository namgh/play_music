//! 버추얼 아날로그 신스 (`sound.md` Tier 3, M4).
//!
//! > 물리 모델링 무관. **에일리어싱 방지 오실레이터(PolyBLEP 등)만 제대로 하면 됨**
//!
//! 왜 PolyBLEP 인가: 순진한 톱니파는 매 주기마다 값이 뚝 떨어진다. 그 불연속은
//! 무한한 하모닉을 만들고, 나이퀴스트 위 성분이 전부 접혀 들어와 **즉시 지저분해진다**
//! (`sound.md` 6-1). PolyBLEP 은 그 불연속 지점만 다항식으로 매끄럽게 만들어
//! 접히는 성분을 없앤다. 오실레이터는 매 샘플 도는 코드라 오버샘플링보다 훨씬 싸다.
//!
//! 완료 판정 (`sound.md` 10절 M4): 대역제한 오실레이터 에일리어싱 측정 통과.

use crate::oversample::Oversampler;
use crate::smooth::{times, Smoothed};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Waveform {
    Saw,
    Square,
    Triangle,
    Sine,
}

impl Waveform {
    pub fn from_index(index: u32) -> Self {
        match index {
            0 => Self::Saw,
            1 => Self::Square,
            2 => Self::Triangle,
            _ => Self::Sine,
        }
    }
}

/// PolyBLEP 보정항.
///
/// `t` 는 불연속 지점까지의 위상 거리(0~1), `dt` 는 한 샘플당 위상 증가.
/// 불연속 앞뒤 한 샘플씩만 손본다.
fn poly_blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// 대역제한 오실레이터 하나
#[derive(Clone, Copy, Debug, Default)]
struct Oscillator {
    phase: f64,
    /// 삼각파는 사각파를 적분해 만든다 — 그 적분 상태
    integrator: f64,
}

impl Oscillator {
    fn reset(&mut self, phase: f64) {
        self.phase = phase;
        self.integrator = 0.0;
    }

    fn next(&mut self, waveform: Waveform, dt: f64) -> f64 {
        let t = self.phase;
        let value = match waveform {
            Waveform::Sine => (2.0 * core::f64::consts::PI * t).sin(),
            Waveform::Saw => {
                // 순진한 톱니: 2t-1. 불연속은 t=0 에 있다
                let naive = 2.0 * t - 1.0;
                naive - poly_blep(t, dt)
            }
            Waveform::Square => {
                let naive = if t < 0.5 { 1.0 } else { -1.0 };
                // 불연속이 t=0 과 t=0.5 두 곳에 있다
                let half = (t + 0.5) % 1.0;
                naive + poly_blep(t, dt) - poly_blep(half, dt)
            }
            Waveform::Triangle => {
                // 대역제한된 사각파를 적분하면 삼각파가 된다.
                // 적분이 DC 를 쌓으므로 살짝 새는 적분기를 쓴다
                let naive = if t < 0.5 { 1.0 } else { -1.0 };
                let half = (t + 0.5) % 1.0;
                let square = naive + poly_blep(t, dt) - poly_blep(half, dt);
                self.integrator = self.integrator * 0.9995 + square * dt * 4.0;
                self.integrator
            }
        };

        self.phase += dt;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        value
    }
}

/// ADSR 엔벌로프. 신스는 줄과 달리 감쇠가 물리로 정해지지 않으므로 필요하다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy, Debug)]
struct Envelope {
    stage: Stage,
    value: f64,
    attack_rate: f64,
    decay_rate: f64,
    sustain: f64,
    release_rate: f64,
}

impl Envelope {
    fn new() -> Self {
        Self {
            stage: Stage::Idle,
            value: 0.0,
            attack_rate: 1.0,
            decay_rate: 1.0,
            sustain: 0.7,
            release_rate: 1.0,
        }
    }

    fn set(&mut self, attack_ms: f64, decay_ms: f64, sustain: f64, release_ms: f64, sr: f64) {
        let rate = |ms: f64| 1.0 / (ms.max(0.5) / 1000.0 * sr);
        self.attack_rate = rate(attack_ms);
        self.decay_rate = rate(decay_ms);
        self.release_rate = rate(release_ms);
        self.sustain = sustain.clamp(0.0, 1.0);
    }

    fn note_on(&mut self) {
        self.stage = Stage::Attack;
    }

    fn note_off(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }

    fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    fn advance(&mut self) -> f64 {
        match self.stage {
            Stage::Idle => self.value = 0.0,
            Stage::Attack => {
                self.value += self.attack_rate;
                if self.value >= 1.0 {
                    self.value = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.value -= self.decay_rate * (1.0 - self.sustain);
                if self.value <= self.sustain {
                    self.value = self.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => self.value = self.sustain,
            Stage::Release => {
                self.value -= self.release_rate;
                if self.value <= 0.0 {
                    self.value = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.value
    }
}

/// 감산 합성의 필터 — TPT(zero-delay feedback) 상태 변수 필터.
///
/// **왜 고전 Chamberlin SVF 가 아닌가:** 그건 컷오프가 `fs/6`(48kHz 에서 8kHz)을
/// 넘으면 불안정해진다. 처음 그걸로 만들었다가 컷오프 18kHz 에서 NaN 이 났다.
/// TPT 는 전 대역에서 안정하고, 컷오프가 아날로그 프로토타입과 정확히 맞는다.
#[derive(Clone, Copy, Debug, Default)]
struct StateVariableFilter {
    /// 적분기 상태 (등가 전압)
    ic1: f64,
    ic2: f64,
    a1: f64,
    a2: f64,
    a3: f64,
}

impl StateVariableFilter {
    fn set(&mut self, cutoff_hz: f64, resonance: f64, sample_rate: f64) {
        // 나이퀴스트에 붙으면 tan 이 발산하므로 살짝 아래로 자른다
        let cutoff = cutoff_hz.clamp(20.0, sample_rate * 0.49);
        let g = (core::f64::consts::PI * cutoff / sample_rate).tan();
        // k = 1/Q. 작을수록 레조넌스가 강하다. 0 이면 자기 발진하므로 하한을 둔다
        let k = (2.0 - 1.94 * resonance.clamp(0.0, 1.0)).max(0.06);
        self.a1 = 1.0 / (1.0 + g * (g + k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }

    fn process(&mut self, x: f64) -> f64 {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        v2
    }

    fn is_finite(&self) -> bool {
        self.ic1.is_finite() && self.ic2.is_finite()
    }

    fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SynthParams {
    pub waveform: Waveform,
    /// 두 번째 오실레이터의 디튠 (센트). 0 이면 하나만 쓴다
    pub detune_cents: f64,
    pub cutoff_hz: f64,
    pub resonance: f64,
    /// 엔벌로프가 컷오프를 얼마나 올리는지 (0~1)
    pub filter_env: f64,
    pub attack_ms: f64,
    pub decay_ms: f64,
    pub sustain: f64,
    pub release_ms: f64,
    /// 출력 왜곡 (0 이면 없음). 있으면 오버샘플링을 거친다
    pub drive: f64,
}

impl Default for SynthParams {
    fn default() -> Self {
        Self {
            waveform: Waveform::Saw,
            detune_cents: 8.0,
            cutoff_hz: 3000.0,
            resonance: 0.2,
            filter_env: 0.5,
            attack_ms: 5.0,
            decay_ms: 300.0,
            sustain: 0.6,
            release_ms: 250.0,
            drive: 0.0,
        }
    }
}

pub struct SynthVoice {
    sample_rate: f64,
    osc_a: Oscillator,
    osc_b: Oscillator,
    envelope: Envelope,
    filter: StateVariableFilter,
    oversampler: Oversampler,
    params: SynthParams,
    freq_hz: f64,
    velocity: f64,
    cutoff: Smoothed,
    active: bool,
}

impl SynthVoice {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            osc_a: Oscillator::default(),
            osc_b: Oscillator::default(),
            envelope: Envelope::new(),
            filter: StateVariableFilter::default(),
            oversampler: Oversampler::new(sample_rate),
            params: SynthParams::default(),
            freq_hz: 440.0,
            velocity: 1.0,
            cutoff: Smoothed::new(3000.0, times::FILTER_MS, sample_rate),
            active: false,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn note_on(&mut self, freq_hz: f64, velocity: f64, params: &SynthParams) {
        self.params = *params;
        self.freq_hz = freq_hz.clamp(8.0, self.sample_rate * 0.45);
        self.velocity = velocity.clamp(0.0, 1.0);

        // 두 오실레이터의 위상을 다르게 시작해 디튠이 바로 들리게 한다
        self.osc_a.reset(0.0);
        self.osc_b.reset(0.37);
        self.filter.reset();
        self.oversampler.reset();

        self.envelope.set(
            params.attack_ms,
            params.decay_ms,
            params.sustain,
            params.release_ms,
            self.sample_rate,
        );
        self.envelope.note_on();
        self.cutoff.reset(params.cutoff_hz);
        self.active = true;
    }

    pub fn note_off(&mut self) {
        self.envelope.note_off();
    }

    pub fn set_params_live(&mut self, params: &SynthParams) {
        if !self.active {
            return;
        }
        self.params = *params;
        self.cutoff.set_target(params.cutoff_hz);
        self.envelope.set(
            params.attack_ms,
            params.decay_ms,
            params.sustain,
            params.release_ms,
            self.sample_rate,
        );
    }

    pub fn reset(&mut self) {
        self.filter.reset();
        self.oversampler.reset();
        self.envelope.stage = Stage::Idle;
        self.envelope.value = 0.0;
        self.active = false;
    }

    /// `out` 에 **더한다**
    pub fn process(&mut self, out: &mut [f32]) {
        if !self.active {
            return;
        }

        let dt_a = self.freq_hz / self.sample_rate;
        let ratio = (self.params.detune_cents / 1200.0).exp2();
        let dt_b = (self.freq_hz * ratio / self.sample_rate).min(0.49);
        let waveform = self.params.waveform;
        let use_second = self.params.detune_cents.abs() > 0.01;
        let drive = self.params.drive.clamp(0.0, 1.0);

        for sample in out.iter_mut() {
            let env = self.envelope.advance();

            let mut raw = self.osc_a.next(waveform, dt_a);
            if use_second {
                raw = (raw + self.osc_b.next(waveform, dt_b)) * 0.5;
            }

            // 엔벌로프가 컷오프를 밀어 올린다 (감산 합성의 기본 움직임)
            let base = self.cutoff.advance();
            let cutoff = base * (1.0 + self.params.filter_env * env * 3.0);
            self.filter
                .set(cutoff, self.params.resonance, self.sample_rate);

            let filtered = self.filter.process(raw);
            *sample += (filtered * env * self.velocity * 0.4) as f32;
        }

        // 출력 왜곡은 **오버샘플링 안에서만** (`sound.md` 6-1)
        if drive > 0.0 {
            let gain = 1.0 + drive * 12.0;
            self.oversampler.process(out, |x| (x * gain).tanh());
        }

        if self.envelope.is_idle() {
            self.active = false;
        }
        if !self.filter.is_finite() {
            self.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn magnitude_at(signal: &[f32], hz: f64) -> f64 {
        let w = 2.0 * core::f64::consts::PI * hz / FS;
        let n = signal.len();
        let (mut re, mut im, mut norm) = (0.0, 0.0, 0.0);
        for (i, sample) in signal.iter().enumerate() {
            let window =
                0.5 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / (n - 1) as f64).cos();
            let s = *sample as f64 * window;
            re += s * (w * i as f64).cos();
            im -= s * (w * i as f64).sin();
            norm += window;
        }
        2.0 * (re * re + im * im).sqrt() / norm.max(1.0)
    }

    fn render(params: SynthParams, freq: f64, n: usize) -> Vec<f32> {
        let mut voice = SynthVoice::new(FS);
        voice.note_on(freq, 1.0, &params);
        let mut out = vec![0.0f32; n];
        voice.process(&mut out);
        out
    }

    /// 대역제한 없이 만든 톱니 — 비교용
    fn naive_saw(freq: f64, n: usize) -> Vec<f32> {
        let dt = freq / FS;
        let mut phase = 0.0;
        (0..n)
            .map(|_| {
                let v = (2.0 * phase - 1.0) as f32;
                phase += dt;
                if phase >= 1.0 {
                    phase -= 1.0;
                }
                v * 0.4
            })
            .collect()
    }

    #[test]
    fn oscillator_produces_expected_pitch() {
        // 신스도 음정이 맞아야 한다 (제품 주장은 악기를 가리지 않는다)
        for freq in [55.0, 220.0, 440.0, 2000.0] {
            let params = SynthParams {
                cutoff_hz: 18000.0,
                resonance: 0.0,
                filter_env: 0.0,
                attack_ms: 1.0,
                decay_ms: 5000.0,
                sustain: 1.0,
                detune_cents: 0.0,
                ..SynthParams::default()
            };
            let out = render(params, freq, 16384);
            let at_f = magnitude_at(&out[2048..], freq);
            let off = magnitude_at(&out[2048..], freq * 1.5);
            assert!(
                at_f > off * 5.0,
                "{freq}Hz 에 에너지가 없다: {at_f} vs {off}"
            );
        }
    }

    #[test]
    fn polyblep_removes_aliasing() {
        // M4 완료 판정 (`sound.md` 10절): 대역제한 오실레이터 에일리어싱 측정 통과.
        //
        // 2093Hz 톱니의 하모닉은 2093 배수로 뻗는다. 24kHz 를 넘는 성분이 접히면
        // 배수가 아닌 자리에 에너지가 생긴다
        let freq = 2093.0;
        let params = SynthParams {
            waveform: Waveform::Saw,
            cutoff_hz: 20000.0,
            resonance: 0.0,
            filter_env: 0.0,
            attack_ms: 1.0,
            decay_ms: 5000.0,
            sustain: 1.0,
            detune_cents: 0.0,
            drive: 0.0,
            release_ms: 200.0,
        };
        let banded = render(params, freq, 16384);
        let naive = naive_saw(freq, 16384);

        // 접혀 들어오는 자리: 13×2093 = 27209 → 48000-27209 = 20791Hz
        let folded = 20791.0;
        let banded_db = 20.0
            * (magnitude_at(&banded[2048..], folded) / magnitude_at(&banded[2048..], freq)).log10();
        let naive_db = 20.0
            * (magnitude_at(&naive[2048..], folded) / magnitude_at(&naive[2048..], freq)).log10();

        assert!(
            naive_db > banded_db + 12.0,
            "PolyBLEP 이 에일리어싱을 줄이지 못했다: 순진 {naive_db:.1}dB vs 대역제한 {banded_db:.1}dB"
        );
        assert!(banded_db < -40.0, "대역제한 후에도 {banded_db:.1}dB 남는다");
    }

    #[test]
    fn every_waveform_is_finite_and_bounded() {
        for index in 0..4 {
            for freq in [40.0, 440.0, 4000.0] {
                let params = SynthParams {
                    waveform: Waveform::from_index(index),
                    resonance: 0.95,
                    drive: 1.0,
                    ..Default::default()
                };
                let out = render(params, freq, 8192);
                assert!(
                    out.iter().all(|v| v.is_finite()),
                    "파형 {index}, {freq}Hz: 유한하지 않다"
                );
                assert!(
                    out.iter().all(|v| v.abs() < 4.0),
                    "파형 {index}, {freq}Hz: 발산했다"
                );
            }
        }
    }

    #[test]
    fn envelope_shapes_the_note() {
        let params = SynthParams {
            attack_ms: 50.0,
            decay_ms: 100.0,
            sustain: 0.5,
            release_ms: 100.0,
            filter_env: 0.0,
            cutoff_hz: 8000.0,
            ..Default::default()
        };
        let out = render(params, 440.0, 24000);

        let rms = |from: usize, to: usize| {
            let mut sum = 0.0;
            for v in &out[from..to] {
                sum += (*v as f64) * (*v as f64);
            }
            (sum / (to - from) as f64).sqrt()
        };

        // 어택 중(0~20ms)이 서스테인 구간(300ms 부근)보다 조용해야 한다
        let attacking = rms(0, 960);
        let sustaining = rms(14400, 19200);
        assert!(
            attacking < sustaining,
            "어택이 없다: {attacking} vs {sustaining}"
        );
    }

    #[test]
    fn note_off_releases_and_frees_the_voice() {
        let params = SynthParams {
            release_ms: 20.0,
            ..Default::default()
        };
        let mut voice = SynthVoice::new(FS);
        voice.note_on(440.0, 1.0, &params);
        let mut out = vec![0.0f32; 4800];
        voice.process(&mut out);
        assert!(voice.is_active());

        voice.note_off();
        for _ in 0..10 {
            let mut tail = vec![0.0f32; 4800];
            voice.process(&mut tail);
        }
        assert!(!voice.is_active(), "릴리즈 후에도 보이스가 잡혀 있다");
    }

    #[test]
    fn detune_creates_beating() {
        // 두 오실레이터를 디튠하면 맥놀이가 생긴다 — 신스가 두껍게 들리는 이유
        let params = SynthParams {
            detune_cents: 12.0,
            filter_env: 0.0,
            cutoff_hz: 12000.0,
            attack_ms: 1.0,
            decay_ms: 5000.0,
            sustain: 1.0,
            ..Default::default()
        };
        let out = render(params, 220.0, 48000);

        let rms = |from: usize, to: usize| {
            let mut sum = 0.0;
            for v in &out[from..to] {
                sum += (*v as f64) * (*v as f64);
            }
            (sum / (to - from) as f64).sqrt()
        };

        // 맥놀이 주기 = 220 * (2^(12/1200) - 1) ≈ 1.53Hz → 약 0.65초
        let mut lowest = f64::MAX;
        let mut highest: f64 = 0.0;
        for k in 0..8 {
            let level = rms(k * 6000, (k + 1) * 6000);
            lowest = lowest.min(level);
            highest = highest.max(level);
        }
        assert!(
            highest > lowest * 1.15,
            "맥놀이가 없다: {lowest} ~ {highest}"
        );
    }

    #[test]
    fn resonance_emphasizes_the_cutoff() {
        let base = SynthParams {
            waveform: Waveform::Saw,
            cutoff_hz: 1000.0,
            filter_env: 0.0,
            attack_ms: 1.0,
            decay_ms: 5000.0,
            sustain: 1.0,
            detune_cents: 0.0,
            ..Default::default()
        };
        let flat = render(
            SynthParams {
                resonance: 0.0,
                ..base
            },
            110.0,
            16384,
        );
        let peaky = render(
            SynthParams {
                resonance: 0.9,
                ..base
            },
            110.0,
            16384,
        );

        // 컷오프 부근(990Hz = 9배음)이 레조넌스로 올라와야 한다
        let flat_level = magnitude_at(&flat[2048..], 990.0);
        let peaky_level = magnitude_at(&peaky[2048..], 990.0);
        assert!(
            peaky_level > flat_level * 1.5,
            "레조넌스가 컷오프를 강조하지 않는다: {flat_level:.5} vs {peaky_level:.5}"
        );
    }
}

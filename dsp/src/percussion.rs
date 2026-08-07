//! 합성 드럼 — 킥·스네어·하이햇·탐·클랩.
//!
//! # 왜 샘플이 아닌가
//!
//! `sound.md` 3절은 드럼을 Tier 4(샘플)로 둔다. 어쿠스틱 드럼은 샘플이 품질·비용
//! 모두 우세하고 그 판단은 지금도 맞다. **하지만 그 샘플이 없다** — 녹음이나
//! 라이선스가 필요하고 코드로 만들 수 있는 것이 아니다.
//!
//! 드럼이 아예 없으면 `plan.md` 5-1 의 Phase 1 완료 조건("AI 없이 곡 하나를 끝내고
//! 내보낼 수 있다")이 성립하지 않는다. 리듬 없이 곡을 끝낼 수는 없다.
//!
//! 그래서 **합성 드럼**을 넣는다. 이건 어쿠스틱 드럼을 흉내 내려는 것이 아니라
//! 전자 드럼이라는 **별개의 실재하는 악기**다 (TR-808 계열이 그 자체로 하나의 음색인
//! 것처럼). 어쿠스틱 드럼 샘플은 에셋이 확보되면 샘플러 보이스로 따로 들어온다.
//!
//! 합성으로 만드는 이상 이 소리는 "드럼 흉내"가 아니라 그 자체로 판단받아야 한다.

use crate::denormal::flush;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrumKind {
    Kick,
    Snare,
    HiHatClosed,
    HiHatOpen,
    Tom,
    Clap,
}

impl DrumKind {
    pub fn from_index(index: u32) -> Self {
        match index {
            0 => Self::Kick,
            1 => Self::Snare,
            2 => Self::HiHatClosed,
            3 => Self::HiHatOpen,
            4 => Self::Tom,
            _ => Self::Clap,
        }
    }

    /// 음정을 따라가는가. 킥·탐은 음정이 있고 하이햇·클랩은 없다
    fn is_pitched(self) -> bool {
        matches!(self, Self::Kick | Self::Tom)
    }
}

/// 결정론적 노이즈. 오디오 스레드에서 OS 난수를 부를 수 없다
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.0 as f64 / 4294967296.0) * 2.0 - 1.0
    }
}

/// 2극 대역통과 — 노이즈에서 특정 대역만 뽑는다
#[derive(Clone, Copy, Debug, Default)]
struct BandPass {
    low: f64,
    band: f64,
    f: f64,
    q: f64,
}

impl BandPass {
    fn set(&mut self, hz: f64, resonance: f64, sample_rate: f64) {
        let cutoff = hz.clamp(20.0, sample_rate * 0.45);
        self.f = 2.0 * (core::f64::consts::PI * cutoff / sample_rate).sin();
        self.f = self.f.clamp(0.0, 1.2);
        self.q = (1.0 - resonance.clamp(0.0, 0.95)).max(0.05);
    }

    fn process(&mut self, x: f64) -> f64 {
        let high = x - self.low - self.q * self.band;
        self.band = flush(self.band + self.f * high);
        self.low = flush(self.low + self.f * self.band);
        self.band
    }

    fn reset(&mut self) {
        self.low = 0.0;
        self.band = 0.0;
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DrumParams {
    pub kind: DrumKind,
    /// 몸통의 감쇠 시간 (초)
    pub decay_sec: f64,
    /// 음정 스윕 깊이 — 킥의 "둥" 소리를 만드는 것
    pub pitch_drop: f64,
    /// 노이즈 성분의 양 (0~1). 스네어의 "샤" 소리
    pub noise_amount: f64,
    /// 밝기 (노이즈 대역의 중심)
    pub tone: f64,
}

impl Default for DrumParams {
    fn default() -> Self {
        Self {
            kind: DrumKind::Kick,
            decay_sec: 0.35,
            pitch_drop: 0.7,
            noise_amount: 0.0,
            tone: 0.5,
        }
    }
}

pub struct DrumVoice {
    sample_rate: f64,
    kind: DrumKind,

    /// 몸통 사인의 위상
    phase: f64,
    base_hz: f64,
    /// 음정 스윕의 현재 배율 (1 로 수렴한다)
    sweep: f64,
    sweep_decay: f64,

    body_env: f64,
    body_decay: f64,
    noise_env: f64,
    noise_decay: f64,
    noise_amount: f64,

    noise: Noise,
    band: BandPass,
    /// 클랩의 여러 번 튀는 어택
    clap_countdown: f64,
    clap_left: u32,

    velocity: f64,
    active: bool,
}

impl DrumVoice {
    pub fn new(sample_rate: f64, seed: u32) -> Self {
        Self {
            sample_rate,
            kind: DrumKind::Kick,
            phase: 0.0,
            base_hz: 50.0,
            sweep: 1.0,
            sweep_decay: 0.999,
            body_env: 0.0,
            body_decay: 0.999,
            noise_env: 0.0,
            noise_decay: 0.999,
            noise_amount: 0.0,
            noise: Noise(seed | 1),
            band: BandPass::default(),
            clap_countdown: 0.0,
            clap_left: 0,
            velocity: 1.0,
            active: false,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// `freq_hz` 는 음정이 있는 드럼(킥·탐)에만 쓰인다.
    /// 하이햇을 반음 올려 봐야 하이햇이 아니므로 무시한다.
    pub fn note_on(&mut self, freq_hz: f64, velocity: f64, params: &DrumParams) {
        self.kind = params.kind;
        self.velocity = velocity.clamp(0.0, 1.0);
        self.phase = 0.0;
        self.sweep = 1.0 + params.pitch_drop.clamp(0.0, 4.0) * 3.0;
        self.band.reset();

        let rate = |sec: f64| (-1.0 / (sec.max(0.002) * self.sample_rate)).exp();
        let decay = params.decay_sec.clamp(0.01, 4.0);

        match params.kind {
            DrumKind::Kick => {
                self.base_hz = if freq_hz > 0.0 {
                    freq_hz.clamp(30.0, 120.0)
                } else {
                    50.0
                };
                self.body_decay = rate(decay);
                // 스윕이 빨라야 "둥"이 되고 느리면 "우웅"이 된다
                self.sweep_decay = rate(decay * 0.08);
                self.noise_decay = rate(0.004);
                self.noise_amount = params.noise_amount.clamp(0.0, 1.0) * 0.3;
                self.band.set(3000.0, 0.2, self.sample_rate);
            }
            DrumKind::Tom => {
                self.base_hz = if freq_hz > 0.0 {
                    freq_hz.clamp(60.0, 400.0)
                } else {
                    120.0
                };
                self.body_decay = rate(decay);
                self.sweep_decay = rate(decay * 0.25);
                self.noise_decay = rate(0.01);
                self.noise_amount = params.noise_amount.clamp(0.0, 1.0) * 0.2;
                self.band.set(2000.0, 0.2, self.sample_rate);
            }
            DrumKind::Snare => {
                self.base_hz = 190.0;
                self.body_decay = rate(decay * 0.35);
                self.sweep_decay = rate(decay * 0.05);
                self.noise_decay = rate(decay);
                self.noise_amount = 0.6 + params.noise_amount.clamp(0.0, 1.0) * 0.4;
                self.band.set(
                    1200.0 + params.tone.clamp(0.0, 1.0) * 3000.0,
                    0.35,
                    self.sample_rate,
                );
            }
            DrumKind::HiHatClosed | DrumKind::HiHatOpen => {
                self.base_hz = 0.0;
                let length = if params.kind == DrumKind::HiHatOpen {
                    decay
                } else {
                    decay * 0.18
                };
                self.body_decay = 0.0;
                self.noise_decay = rate(length);
                self.noise_amount = 1.0;
                self.band.set(
                    6000.0 + params.tone.clamp(0.0, 1.0) * 4000.0,
                    0.5,
                    self.sample_rate,
                );
            }
            DrumKind::Clap => {
                self.base_hz = 0.0;
                self.body_decay = 0.0;
                self.noise_decay = rate(decay * 0.5);
                self.noise_amount = 1.0;
                self.band.set(
                    1500.0 + params.tone.clamp(0.0, 1.0) * 2000.0,
                    0.4,
                    self.sample_rate,
                );
                // 클랩은 여러 손바닥이 살짝 어긋나 부딪히는 소리다
                self.clap_left = 3;
                self.clap_countdown = 0.008 * self.sample_rate;
            }
        }

        self.body_env = if params.kind.is_pitched() || params.kind == DrumKind::Snare {
            1.0
        } else {
            0.0
        };
        self.noise_env = 1.0;
        self.active = true;
    }

    pub fn note_off(&mut self) {
        // 원샷이다. 하이햇 오픈을 클로즈로 막는 것은 상위 레이어(초크 그룹)의 일이다
    }

    pub fn reset(&mut self) {
        self.active = false;
        self.body_env = 0.0;
        self.noise_env = 0.0;
        self.band.reset();
    }

    /// `out` 에 **더한다**
    pub fn process(&mut self, out: &mut [f32]) {
        if !self.active {
            return;
        }

        for slot in out.iter_mut() {
            // 몸통: 음정이 아래로 떨어지는 사인
            let mut value = 0.0;
            if self.body_env > 1e-5 && self.base_hz > 0.0 {
                let hz = self.base_hz * self.sweep;
                self.phase += hz / self.sample_rate;
                if self.phase >= 1.0 {
                    self.phase -= 1.0;
                }
                value += (2.0 * core::f64::consts::PI * self.phase).sin() * self.body_env;
                self.sweep = 1.0 + (self.sweep - 1.0) * self.sweep_decay;
                self.body_env = flush(self.body_env * self.body_decay);
            }

            // 노이즈: 대역통과를 거쳐 "샤" 소리를 만든다.
            //
            // **엔벌로프는 노이즈 양과 무관하게 감쇠시켜야 한다.** 처음에
            // `noise_amount > 0` 일 때만 줄였더니, 노이즈가 0인 킥은 엔벌로프가
            // 영원히 1로 남아 보이스가 반환되지 않았다 — 치다 보면 보이스 풀이
            // 차서 소리가 끊기는 증상이 된다
            if self.noise_env > 1e-5 {
                // 클랩은 여러 번 다시 튄다
                if self.clap_left > 0 {
                    self.clap_countdown -= 1.0;
                    if self.clap_countdown <= 0.0 {
                        self.noise_env = 1.0;
                        self.clap_left -= 1;
                        self.clap_countdown = 0.008 * self.sample_rate;
                    }
                }
                if self.noise_amount > 0.0 {
                    let filtered = self.band.process(self.noise.next());
                    value += filtered * self.noise_env * self.noise_amount;
                }
                self.noise_env = flush(self.noise_env * self.noise_decay);
            }

            *slot += (value * self.velocity * 0.6) as f32;
        }

        if self.body_env <= 1e-5 && self.noise_env <= 1e-5 {
            self.active = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn render(params: DrumParams, freq: f64, n: usize) -> Vec<f32> {
        let mut voice = DrumVoice::new(FS, 12345);
        voice.note_on(freq, 1.0, &params);
        let mut out = vec![0.0f32; n];
        voice.process(&mut out);
        out
    }

    fn rms(signal: &[f32]) -> f64 {
        let mut sum = 0.0;
        for v in signal {
            sum += (*v as f64) * (*v as f64);
        }
        (sum / signal.len() as f64).sqrt()
    }

    /// 대략적인 스펙트럼 무게중심 — 밝기 비교용
    fn brightness(signal: &[f32]) -> f64 {
        let mut edges = 0.0;
        for pair in signal.windows(2) {
            edges += ((pair[1] - pair[0]) as f64).abs();
        }
        edges / signal.len() as f64 / rms(signal).max(1e-12)
    }

    #[test]
    fn every_kind_makes_sound_and_stays_finite() {
        for index in 0..6 {
            let out = render(
                DrumParams {
                    kind: DrumKind::from_index(index),
                    ..Default::default()
                },
                60.0,
                24000,
            );
            assert!(
                out.iter().all(|v| v.is_finite()),
                "종류 {index}: 유한하지 않다"
            );
            assert!(out.iter().all(|v| v.abs() < 2.0), "종류 {index}: 발산");
            assert!(rms(&out) > 1e-4, "종류 {index}: 소리가 안 난다");
        }
    }

    #[test]
    fn kick_is_low_and_hihat_is_bright() {
        // 종류가 실제로 다른 소리를 내는지. 안 그러면 이름만 다른 것이다
        let kick = render(
            DrumParams {
                kind: DrumKind::Kick,
                ..Default::default()
            },
            50.0,
            24000,
        );
        let hihat = render(
            DrumParams {
                kind: DrumKind::HiHatClosed,
                ..Default::default()
            },
            50.0,
            24000,
        );
        assert!(
            brightness(&hihat) > brightness(&kick) * 3.0,
            "하이햇이 킥보다 밝지 않다: {} vs {}",
            brightness(&hihat),
            brightness(&kick)
        );
    }

    #[test]
    fn kick_pitch_sweeps_downward() {
        // "둥" 소리의 정체. 스윕이 없으면 그냥 삑 소리가 난다
        let out = render(
            DrumParams {
                kind: DrumKind::Kick,
                pitch_drop: 1.0,
                decay_sec: 0.5,
                ..Default::default()
            },
            50.0,
            24000,
        );

        // 앞부분의 영교차가 뒷부분보다 촘촘해야 한다 (= 주파수가 높다)
        let crossings = |s: &[f32]| {
            let mut count = 0;
            for pair in s.windows(2) {
                if (pair[0] < 0.0) != (pair[1] < 0.0) {
                    count += 1;
                }
            }
            count
        };
        let early = crossings(&out[200..2400]);
        let late = crossings(&out[12000..14200]);
        assert!(early > late, "음정이 안 떨어진다: 앞 {early} 뒤 {late}");
    }

    #[test]
    fn unpitched_kinds_ignore_the_note() {
        // 하이햇을 반음 올려 봐야 하이햇이다
        let low = render(
            DrumParams {
                kind: DrumKind::HiHatClosed,
                ..Default::default()
            },
            40.0,
            8000,
        );
        let high = render(
            DrumParams {
                kind: DrumKind::HiHatClosed,
                ..Default::default()
            },
            2000.0,
            8000,
        );
        for (a, b) in low.iter().zip(high.iter()) {
            assert!((a - b).abs() < 1e-9, "음정 없는 드럼이 이조됐다");
        }
    }

    #[test]
    fn pitched_kinds_follow_the_note() {
        let low = render(
            DrumParams {
                kind: DrumKind::Tom,
                pitch_drop: 0.0,
                ..Default::default()
            },
            80.0,
            8000,
        );
        let high = render(
            DrumParams {
                kind: DrumKind::Tom,
                pitch_drop: 0.0,
                ..Default::default()
            },
            300.0,
            8000,
        );
        let crossings = |s: &[f32]| {
            let mut count = 0;
            for pair in s.windows(2) {
                if (pair[0] < 0.0) != (pair[1] < 0.0) {
                    count += 1;
                }
            }
            count
        };
        assert!(
            crossings(&high) > crossings(&low) * 2,
            "탐이 음정을 안 따라간다"
        );
    }

    #[test]
    fn open_hihat_rings_longer_than_closed() {
        let closed = render(
            DrumParams {
                kind: DrumKind::HiHatClosed,
                decay_sec: 0.4,
                ..Default::default()
            },
            0.0,
            24000,
        );
        let open = render(
            DrumParams {
                kind: DrumKind::HiHatOpen,
                decay_sec: 0.4,
                ..Default::default()
            },
            0.0,
            24000,
        );
        assert!(
            rms(&open[12000..]) > rms(&closed[12000..]) * 3.0,
            "오픈 하이햇이 더 길게 울리지 않는다"
        );
    }

    #[test]
    fn voice_frees_itself() {
        let mut voice = DrumVoice::new(FS, 1);
        voice.note_on(
            50.0,
            1.0,
            &DrumParams {
                decay_sec: 0.05,
                ..Default::default()
            },
        );
        for _ in 0..30 {
            let mut out = vec![0.0f32; 4800];
            voice.process(&mut out);
        }
        assert!(!voice.is_active(), "끝났는데 보이스가 잡혀 있다");
    }

    #[test]
    fn velocity_scales_the_hit() {
        let mut soft = DrumVoice::new(FS, 1);
        soft.note_on(50.0, 0.2, &DrumParams::default());
        let mut a = vec![0.0f32; 8000];
        soft.process(&mut a);

        let mut hard = DrumVoice::new(FS, 1);
        hard.note_on(50.0, 1.0, &DrumParams::default());
        let mut b = vec![0.0f32; 8000];
        hard.process(&mut b);

        assert!(rms(&b) > rms(&a) * 3.0, "세기가 반영되지 않는다");
    }
}

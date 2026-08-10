//! 모달 합성 — 벨·마림바·글로켄슈필 (`sound.md` Tier 2, M6).
//!
//! > 공진 모드 N개를 병렬 공진 필터로 합산
//!
//! 왜 웨이브가이드가 아닌가: 줄은 1차원이라 하모닉이 (거의) 정수배로 늘어서지만,
//! 판·막대·벨은 2·3차원이라 모드가 **정수배가 전혀 아니다**. 딜레이 루프로는
//! 그 배치를 만들 수 없다. 그래서 모드를 하나씩 공진 필터로 세운다.
//!
//! 대가 (`sound.md` 3절): 모드 수만큼 공진 필터가 필요해 CPU 가 비싸다.
//! 웨이브가이드 보이스는 딜레이 라인 + 필터 몇 개인데 여기는 모드당 2차 필터 하나다.

use crate::denormal::flush;
use crate::smooth::{times, Smoothed};

/// 모드 개수 상한. 늘리면 소리는 좋아지고 CPU 는 비례해 는다
pub const MAX_MODES: usize = 24;

/// 감쇠 사인 하나 = 모드 하나.
///
/// 2차 공진기를 직접 도는 방식으로 만든다 (매 샘플 sin/cos 를 부르지 않는다).
#[derive(Clone, Copy, Debug, Default)]
struct Mode {
    /// 회전자 (복소수 곱으로 사인을 진행시킨다)
    cos_w: f64,
    sin_w: f64,
    re: f64,
    im: f64,
    /// 샘플당 감쇠
    decay: f64,
    amplitude: f64,
}

impl Mode {
    fn start(&mut self, freq_hz: f64, amplitude: f64, t60_sec: f64, sample_rate: f64) {
        let w = 2.0 * core::f64::consts::PI * freq_hz / sample_rate;
        self.cos_w = w.cos();
        self.sin_w = w.sin();
        // 위상 0에서 시작 — 모든 모드가 동시에 0에서 출발해야 어택이 깔끔하다
        self.re = 0.0;
        self.im = amplitude;
        self.amplitude = amplitude;
        self.decay = 10f64.powf(-3.0 / (t60_sec.max(0.01) * sample_rate));
    }

    fn advance(&mut self) -> f64 {
        // 복소 회전 + 감쇠
        let re = self.re * self.cos_w - self.im * self.sin_w;
        let im = self.re * self.sin_w + self.im * self.cos_w;
        // 비정규수 방지 (`sound.md` 6-3) — 감쇠하는 회전자는 0을 향해 끝없이 줄어든다
        self.re = flush(re * self.decay);
        self.im = flush(im * self.decay);
        self.re
    }

    fn silent(&self) -> bool {
        self.re.abs() < 1e-7 && self.im.abs() < 1e-7
    }
}

/// 악기별 모드 배치 (기본음 대비 비율 · 상대 진폭 · 상대 감쇠).
///
/// 이 숫자들이 악기의 정체다. 실측 스펙트럼에서 뽑아 오는 것이 정석이고,
/// 여기 값은 문헌에 널리 알려진 근사다 — **튜닝 도구로 귀로 잡을 대상**이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModalMaterial {
    /// 마림바·목금: 3차 모드가 4배음 근처로 조율돼 있다
    Marimba,
    /// 비브라폰: 금속이라 더 오래 울린다
    Vibraphone,
    /// 벨·차임: 비정수 모드가 촘촘하다
    Bell,
    /// 글로켄슈필: 밝고 짧다
    Glockenspiel,
}

impl ModalMaterial {
    pub fn from_index(index: u32) -> Self {
        match index {
            0 => Self::Marimba,
            1 => Self::Vibraphone,
            2 => Self::Bell,
            _ => Self::Glockenspiel,
        }
    }

    /// (주파수 비율, 진폭, 감쇠 배율)
    fn modes(self) -> &'static [(f64, f64, f64)] {
        match self {
            // 마림바: 조율된 막대. 4배음과 10배음 근처에 강한 모드
            Self::Marimba => &[
                (1.0, 1.0, 1.0),
                (3.99, 0.35, 0.6),
                (9.85, 0.12, 0.35),
                (17.9, 0.05, 0.2),
            ],
            Self::Vibraphone => &[
                (1.0, 1.0, 1.0),
                (3.98, 0.45, 0.8),
                (9.2, 0.18, 0.5),
                (16.8, 0.08, 0.3),
                (23.4, 0.04, 0.2),
            ],
            // 벨: 비정수 모드가 촘촘하다. "hum" 과 "prime" 이 함께 울린다
            Self::Bell => &[
                (0.5, 0.4, 1.2),
                (1.0, 1.0, 1.0),
                (1.19, 0.6, 0.9),
                (1.51, 0.5, 0.8),
                (2.0, 0.7, 0.7),
                (2.51, 0.35, 0.5),
                (2.66, 0.3, 0.5),
                (3.01, 0.25, 0.4),
                (4.07, 0.15, 0.3),
                (5.12, 0.1, 0.25),
            ],
            Self::Glockenspiel => &[
                (1.0, 1.0, 1.0),
                (2.71, 0.5, 0.7),
                (5.15, 0.25, 0.45),
                (8.43, 0.12, 0.3),
            ],
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ModalParams {
    pub material: ModalMaterial,
    /// 기본음의 T60 (초)
    pub decay_sec: f64,
    /// 때리는 위치 0~1. 절점을 때리면 그 모드가 안 울린다
    pub strike_position: f64,
    /// 때리는 세기 — 밝기를 바꾼다 (세게 치면 고차 모드가 산다)
    pub strike_hardness: f64,
}

impl Default for ModalParams {
    fn default() -> Self {
        Self {
            material: ModalMaterial::Marimba,
            decay_sec: 1.2,
            strike_position: 0.25,
            strike_hardness: 0.5,
        }
    }
}

pub struct ModalVoice {
    sample_rate: f64,
    modes: [Mode; MAX_MODES],
    count: usize,
    active: bool,
    gain: Smoothed,
}

impl ModalVoice {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            modes: [Mode::default(); MAX_MODES],
            count: 0,
            active: false,
            gain: Smoothed::new(1.0, times::GAIN_MS, sample_rate),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn note_on(&mut self, freq_hz: f64, velocity: f64, params: &ModalParams) {
        let table = params.material.modes();
        let nyquist = self.sample_rate * 0.49;
        let hardness = params.strike_hardness.clamp(0.0, 1.0);
        let position = params.strike_position.clamp(0.0, 1.0);

        self.count = 0;
        let mut total_weight = 0.0;
        for (index, (ratio, amplitude, decay_scale)) in table.iter().copied().enumerate() {
            if self.count >= MAX_MODES {
                break;
            }
            let freq = freq_hz * ratio;
            // 나이퀴스트 위 모드는 만들지 않는다 — 만들면 접혀 들어온다
            if freq >= nyquist {
                continue;
            }

            // 때리는 위치가 절점이면 그 모드가 죽는다.
            //
            // **모드 번호로 계산해야 한다.** 처음 주파수 비율을 썼는데, 막대·판의
            // 진동 모드는 주파수가 정수배가 아니다 — 마림바 2번 모드는 주파수가
            // 3.99배지 "3.99번 모드"가 아니다. 비율을 쓰면 엉뚱한 곳이 절점이 된다.
            // n 번 모드의 형상은 sin(nπx/L), 절점은 x = kL/n 에 있다
            let mode_number = (index + 1) as f64;
            let shape = (core::f64::consts::PI * mode_number * position).sin().abs();
            // 세게 칠수록 고차 모드가 산다
            let brightness = hardness.powf(0.5).max(0.05);
            let weight = amplitude * shape * brightness.powf((ratio - 1.0).max(0.0) * 0.15);

            if weight < 1e-4 {
                continue;
            }

            self.modes[self.count].start(
                freq,
                weight * velocity.clamp(0.0, 1.0) * 0.5,
                params.decay_sec * decay_scale,
                self.sample_rate,
            );
            total_weight += weight;
            self.count += 1;
        }

        // **모드 합을 정규화한다.** 모드가 많은 재질(차임벨)은 위상이 맞는 순간
        // 진폭이 겹쳐 **한 음만 쳐도 클리핑했다** (실측 +1.2dBFS).
        // 모드를 늘릴수록 커지면 "모드 수"가 음량 손잡이가 되어 버린다
        if total_weight > 1.0 {
            for mode in self.modes[..self.count].iter_mut() {
                // **회전자를 직접 줄인다.** 진폭은 `amplitude` 필드가 아니라 `re`/`im`
                // 안에 들어 있다 — 필드만 고치면 아무 일도 일어나지 않는다
                // (실제로 그렇게 짰다가 차임벨이 계속 +1.2dBFS 로 잘렸다)
                mode.re /= total_weight;
                mode.im /= total_weight;
                mode.amplitude /= total_weight;
            }
        }

        self.gain.reset(1.0);
        self.active = self.count > 0;
    }

    /// 모달은 때리고 나면 물리적으로 감쇠할 뿐이라 노트오프가 "손으로 막기"에 해당한다
    pub fn note_off(&mut self) {
        if !self.active {
            return;
        }
        for mode in self.modes[..self.count].iter_mut() {
            mode.decay *= 0.9995;
        }
    }

    pub fn reset(&mut self) {
        self.count = 0;
        self.active = false;
    }

    /// `out` 에 **더한다**
    pub fn process(&mut self, out: &mut [f32]) {
        if !self.active {
            return;
        }

        for sample in out.iter_mut() {
            let mut sum = 0.0;
            for mode in self.modes[..self.count].iter_mut() {
                sum += mode.advance();
            }
            *sample += sum as f32;
        }

        if self.modes[..self.count].iter().all(Mode::silent) {
            self.active = false;
        }
        if self.modes[..self.count]
            .iter()
            .any(|m| !m.re.is_finite() || !m.im.is_finite())
        {
            self.reset();
        }
    }

    /// 지금 울리고 있는 모드 수 — CPU 예산 측정용 (`sound.md` 11-4)
    pub fn mode_count(&self) -> usize {
        self.count
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

    fn render(params: ModalParams, freq: f64, n: usize) -> Vec<f32> {
        let mut voice = ModalVoice::new(FS);
        voice.note_on(freq, 1.0, &params);
        let mut out = vec![0.0f32; n];
        voice.process(&mut out);
        out
    }

    #[test]
    fn fundamental_lands_on_the_requested_pitch() {
        for freq in [220.0, 440.0, 1046.5] {
            let out = render(ModalParams::default(), freq, 16384);
            let at_f = magnitude_at(&out, freq);
            let off = magnitude_at(&out, freq * 1.26);
            assert!(
                at_f > off * 4.0,
                "{freq}Hz 기본음이 약하다: {at_f} vs {off}"
            );
        }
    }

    #[test]
    fn modes_are_inharmonic() {
        // 모달의 정체. 정수배로 늘어서면 웨이브가이드로 만들었어야 한다는 뜻이다
        let out = render(
            ModalParams {
                material: ModalMaterial::Marimba,
                ..Default::default()
            },
            220.0,
            32768,
        );
        // 마림바의 2번째 모드는 4배음 근처(3.99)에 있고, 2배음에는 없다
        let second_harmonic = magnitude_at(&out, 440.0);
        let fourth_ish = magnitude_at(&out, 220.0 * 3.99);
        assert!(
            fourth_ish > second_harmonic * 3.0,
            "모드 배치가 정수배처럼 보인다: 2배음 {second_harmonic:.6}, 3.99배 {fourth_ish:.6}"
        );
    }

    #[test]
    fn materials_sound_different() {
        let mut previous: Option<Vec<f32>> = None;
        for index in 0..4 {
            let out = render(
                ModalParams {
                    material: ModalMaterial::from_index(index),
                    ..Default::default()
                },
                440.0,
                8192,
            );
            assert!(out.iter().all(|v| v.is_finite()));
            if let Some(before) = previous {
                let same = before
                    .iter()
                    .zip(out.iter())
                    .filter(|(a, b)| (**a - **b).abs() < 1e-9)
                    .count();
                assert!(same < out.len() / 2, "재질 {index} 가 이전과 같은 소리다");
            }
            previous = Some(out);
        }
    }

    #[test]
    fn strike_position_mutes_nodes() {
        // 절점을 때리면 그 모드가 안 울린다 — 실제 타악기의 물리
        let center = render(
            ModalParams {
                material: ModalMaterial::Marimba,
                strike_position: 0.5,
                ..Default::default()
            },
            220.0,
            16384,
        );
        let quarter = render(
            ModalParams {
                material: ModalMaterial::Marimba,
                strike_position: 0.25,
                ..Default::default()
            },
            220.0,
            16384,
        );
        // 위치가 다르면 모드 균형이 달라야 한다
        let ratio = |s: &[f32]| magnitude_at(s, 220.0 * 3.99) / magnitude_at(s, 220.0).max(1e-12);
        assert!(
            (ratio(&center) - ratio(&quarter)).abs() > 0.01,
            "때리는 위치가 소리를 바꾸지 않는다"
        );
    }

    #[test]
    fn decay_parameter_controls_length() {
        let short = render(
            ModalParams {
                decay_sec: 0.3,
                ..Default::default()
            },
            440.0,
            48000,
        );
        let long = render(
            ModalParams {
                decay_sec: 3.0,
                ..Default::default()
            },
            440.0,
            48000,
        );

        let tail = |s: &[f32]| {
            let mut sum = 0.0;
            for v in &s[36000..] {
                sum += (*v as f64) * (*v as f64);
            }
            sum.sqrt()
        };
        assert!(
            tail(&long) > tail(&short) * 5.0,
            "감쇠 파라미터가 동작하지 않는다"
        );
    }

    #[test]
    fn no_modes_above_nyquist() {
        // 나이퀴스트 위 모드를 만들면 접혀 들어와 음정이 아닌 소리가 섞인다.
        //
        // 절점이 아닌 타점을 쓴다 — 0.25 같은 단순 분수는 4·8번 모드의 절점이라
        // 나이퀴스트 효과와 절점 효과가 섞여 무엇을 재는지 알 수 없게 된다
        let bell = ModalParams {
            material: ModalMaterial::Bell,
            strike_position: 0.137,
            ..Default::default()
        };

        let mut low = ModalVoice::new(FS);
        low.note_on(220.0, 1.0, &bell);
        let at_low = low.mode_count();

        let mut high = ModalVoice::new(FS);
        high.note_on(8000.0, 1.0, &bell);
        assert!(
            high.mode_count() < at_low,
            "8kHz 에서 모드가 걸러지지 않았다: 220Hz {at_low} 개 vs 8kHz {} 개",
            high.mode_count()
        );

        // 아주 높은 음에서는 기본음 이하만 남는다 (0.5배·1배)
        let mut extreme = ModalVoice::new(FS);
        extreme.note_on(20000.0, 1.0, &bell);
        assert!(
            extreme.mode_count() <= 2,
            "20kHz 에서 모드 {} 개가 남았다",
            extreme.mode_count()
        );

        let mut out = vec![0.0f32; 8192];
        high.process(&mut out);
        assert!(out.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn voice_frees_itself_when_silent() {
        let mut voice = ModalVoice::new(FS);
        voice.note_on(
            440.0,
            1.0,
            &ModalParams {
                decay_sec: 0.05,
                ..Default::default()
            },
        );
        for _ in 0..40 {
            let mut out = vec![0.0f32; 4800];
            voice.process(&mut out);
        }
        assert!(!voice.is_active(), "조용해졌는데 보이스가 잡혀 있다");
    }

    #[test]
    fn is_stable_at_extremes() {
        for index in 0..4 {
            for freq in [30.0, 440.0, 6000.0] {
                for decay in [0.01, 10.0] {
                    let out = render(
                        ModalParams {
                            material: ModalMaterial::from_index(index),
                            decay_sec: decay,
                            strike_position: 0.0,
                            strike_hardness: 1.0,
                        },
                        freq,
                        4096,
                    );
                    assert!(
                        out.iter().all(|v| v.is_finite() && v.abs() < 4.0),
                        "재질 {index}, {freq}Hz, 감쇠 {decay}: 불안정"
                    );
                }
            }
        }
    }
}

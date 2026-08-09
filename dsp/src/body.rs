//! 어쿠스틱 바디 공명 (`ROADMAP.md` S3 대체).
//!
//! **지금까지 어쿠스틱 기타에 몸통이 아예 없었다.** 줄만 울리고 그 소리가 나무 상자와
//! 그 안의 공기를 거치지 않았다. 그래서 "기타 소리"가 아니라 "줄 소리"로 들린다.
//!
//! `sound.md` 는 바디를 **실측 임펄스 응답(IR) 컨볼루션**으로 대체하라고 했고 그
//! 판단은 지금도 맞다. 하지만 **IR 은 녹음이 필요한 에셋**이라 코드로 만들 수 없고,
//! 그것 때문에 어쿠스틱 계열 전체가 막혀 있었다.
//!
//! 그래서 그 사이를 **모달 근사**로 메운다 — 실측 기타 바디의 주요 공진 몇 개를
//! 병렬 공진 필터로 세운다. IR 만큼 정확하지는 않지만 "몸통이 있다/없다"의 차이는
//! 그 몇 개가 거의 다 만든다. IR 이 확보되면 이 층을 컨볼루션으로 **교체**하면 된다
//! (신호 경로에서 같은 자리다).
//!
//! ## 실측 기준
//!
//! 드레드노트 기타에서 반복해서 관측되는 공진이다:
//!
//! | 모드 | 대략 주파수 | 정체 |
//! |---|---|---|
//! | A0 | 100Hz | **헬름홀츠 공명** — 사운드홀과 통 안 공기 |
//! | T1 | 200Hz | 앞판의 첫 모드 |
//! | T2 | 250Hz | 뒷판 |
//! | 상위 | 380·550Hz | 앞판 고차 모드 |
//!
//! 몸통이 작을수록 전부 위로 올라간다 — 우쿨렐레는 헬름홀츠가 높고, 베이스는 낮다.
//! 그래서 **헬름홀츠 주파수 하나로 전체를 옮긴다.**

use crate::denormal::flush;

/// `(헬름홀츠 대비 배율, 세기, Q)`
///
/// 세기가 모두 1 이 아닌 이유: 실제 바디는 헬름홀츠와 앞판 첫 모드가 지배적이고
/// 상위 모드는 훨씬 약하다. 같게 두면 통이 "웅웅"거리기만 한다.
const MODES: [(f64, f64, f64); 5] = [
    (1.00, 1.00, 12.0),
    (2.00, 0.80, 18.0),
    (2.50, 0.55, 20.0),
    (3.80, 0.30, 22.0),
    (5.50, 0.18, 24.0),
];

/// TPT 상태변수 필터의 대역통과 출력.
///
/// **Chamberlin 이 아니라 TPT 를 쓴다** — Chamberlin 은 컷오프가 fs/6 을 넘으면
/// 불안정하다 (`HANDOFF.md` 6번). 바디 공진은 낮은 대역이라 당장은 안전하지만,
/// 나중에 누가 배율을 키웠을 때 조용히 발산하게 두지 않는다.
#[derive(Clone, Copy, Debug, Default)]
struct Resonator {
    g: f64,
    k: f64,
    a1: f64,
    a2: f64,
    ic1: f64,
    ic2: f64,
}

impl Resonator {
    fn set(&mut self, hz: f64, q: f64, sample_rate: f64) {
        let cutoff = hz.clamp(20.0, sample_rate * 0.45);
        self.g = (core::f64::consts::PI * cutoff / sample_rate).tan();
        self.k = 1.0 / q.max(0.5);
        self.a1 = 1.0 / (1.0 + self.g * (self.g + self.k));
        self.a2 = self.g * self.a1;
    }

    fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    fn process(&mut self, x: f64) -> f64 {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.g * v1;
        self.ic1 = flush(2.0 * v1 - self.ic1);
        self.ic2 = flush(2.0 * v2 - self.ic2);
        // **`k` 를 곱해 정규화한다.** 대역통과의 공진점 이득은 Q 에 비례하므로
        // 그대로 두면 Q 를 올릴 때 소리가 같이 커진다 — 그러면 `amount` 가
        // "얼마나 섞을지"가 아니라 "얼마나 클지"가 되어 의미를 잃는다.
        // 실제로 Q=12 에서 공진점 출력이 원음만큼 커져 음정 측정이 1.7센트 밀렸다
        v1 * self.k
    }
}

/// 악기 몸통. 트랙 하나에 하나 (앰프·공명현과 같은 층이다).
pub struct BodyResonance {
    sample_rate: f64,
    modes: [Resonator; MODES.len()],
    amount: f64,
    helmholtz_hz: f64,
}

impl BodyResonance {
    pub fn new(sample_rate: f64) -> Self {
        let mut this = Self {
            sample_rate,
            modes: [Resonator::default(); MODES.len()],
            amount: 0.0,
            helmholtz_hz: 0.0,
        };
        this.set(0.0, 100.0);
        this
    }

    /// `amount` 가 0 이면 완전히 꺼진다 (소리도 CPU 도 예전 그대로).
    /// `helmholtz_hz` 는 통 안 공기의 공명 주파수 — 이 값 하나가 몸통 크기다.
    pub fn set(&mut self, amount: f64, helmholtz_hz: f64) {
        self.amount = amount.clamp(0.0, 1.0);
        let base = if helmholtz_hz > 0.0 {
            helmholtz_hz
        } else {
            100.0
        };
        if (base - self.helmholtz_hz).abs() < 1e-6 {
            return;
        }
        self.helmholtz_hz = base;
        for (mode, &(ratio, _, q)) in self.modes.iter_mut().zip(MODES.iter()) {
            mode.set(base * ratio, q, self.sample_rate);
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.amount > 0.0
    }

    pub fn reset(&mut self) {
        for mode in self.modes.iter_mut() {
            mode.reset();
        }
    }

    /// `buffer` 를 제자리에서 처리한다.
    ///
    /// **원음을 지우지 않고 섞는다.** 실제 악기도 줄의 직접음과 몸통이 방사하는
    /// 소리가 함께 들린다 — 몸통만 남기면 먹먹해진다.
    pub fn process(&mut self, buffer: &mut [f32]) {
        if !self.is_enabled() {
            return;
        }
        for sample in buffer.iter_mut() {
            let dry = *sample as f64;
            let mut wet = 0.0;
            for (mode, &(_, gain, _)) in self.modes.iter_mut().zip(MODES.iter()) {
                wet += mode.process(dry) * gain;
            }
            // 공진이 다섯 개나 겹치므로 그대로 더하면 저역이 터진다.
            // 정규화된 뒤라 이 배율이 곧 "공진점에서 몇 배로 울리나"다
            *sample = (dry + wet * self.amount * 1.4) as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn tone(hz: f64, seconds: f64) -> Vec<f32> {
        let n = (FS * seconds) as usize;
        (0..n)
            .map(|i| (0.3 * (2.0 * core::f64::consts::PI * hz * i as f64 / FS).sin()) as f32)
            .collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }

    /// 정착한 뒤 구간만 본다 — 앞쪽은 필터가 채워지는 중이다
    fn settled(x: &[f32]) -> f64 {
        rms(&x[(FS * 0.3) as usize..])
    }

    #[test]
    fn disabled_leaves_the_signal_untouched() {
        // 켜지 않은 악기는 예전과 **완전히** 같은 소리여야 한다
        let mut body = BodyResonance::new(FS);
        body.set(0.0, 100.0);
        let mut x = tone(220.0, 0.2);
        let before = x.clone();
        body.process(&mut x);
        assert_eq!(x, before);
    }

    #[test]
    fn boosts_the_helmholtz_pitch() {
        // 몸통이 있다는 것은 특정 음정에서 더 크게 울린다는 뜻이다
        let render = |hz: f64| {
            let mut body = BodyResonance::new(FS);
            body.set(1.0, 100.0);
            let mut x = tone(hz, 0.6);
            let dry = settled(&x);
            body.process(&mut x);
            settled(&x) / dry
        };
        let on_resonance = render(100.0);
        let off_resonance = render(700.0);
        assert!(
            on_resonance > off_resonance * 1.3,
            "공진 음정이 더 울리지 않는다: {on_resonance:.2} vs {off_resonance:.2}"
        );
    }

    #[test]
    fn body_size_moves_the_resonance() {
        // 작은 통은 공진이 위로 간다 — 우쿨렐레와 기타가 달라야 한다
        let gain_at = |helmholtz: f64, hz: f64| {
            let mut body = BodyResonance::new(FS);
            body.set(1.0, helmholtz);
            let mut x = tone(hz, 0.6);
            let dry = settled(&x);
            body.process(&mut x);
            settled(&x) / dry
        };
        // 250Hz 는 작은 통(헬름홀츠 250)에서 울리고 큰 통(100)에서는 덜 울린다
        assert!(gain_at(250.0, 250.0) > gain_at(100.0, 250.0));
    }

    #[test]
    fn keeps_the_direct_sound() {
        // 몸통만 남으면 먹먹해진다. 줄의 직접음이 함께 들려야 한다
        let mut body = BodyResonance::new(FS);
        body.set(1.0, 100.0);
        let mut x = tone(3000.0, 0.4); // 어떤 공진과도 멀다
        let dry = settled(&x);
        body.process(&mut x);
        let wet = settled(&x);
        assert!(
            wet > dry * 0.8,
            "공진에서 먼 음이 사라졌다: {dry:e} → {wet:e}"
        );
    }

    #[test]
    fn stays_finite_at_extremes() {
        // 극단 파라미터에서 발산하면 그 시점부터 트랙 전체가 망가진다 (sound.md 6-5)
        for helmholtz in [20.0, 100.0, 2000.0, 12000.0] {
            let mut body = BodyResonance::new(FS);
            body.set(1.0, helmholtz);
            let mut x = tone(helmholtz, 1.0);
            body.process(&mut x);
            assert!(
                x.iter().all(|v| v.is_finite()),
                "{helmholtz}Hz 에서 발산했다"
            );
            assert!(rms(&x) < 10.0, "{helmholtz}Hz 에서 터졌다");
        }
    }
}

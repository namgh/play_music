//! 바이쿼드 — RBJ 오디오 EQ 쿡북 공식. 상태는 f64 (저역 필터가 f32 에서 잡음을 낸다).
//! 직접형 II 전치(TDF-II) — 계수를 바꿔도 덜 튄다.

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    LowPass,
    HighPass,
    BandPass,
    Notch,
    Peak,
    LowShelf,
    HighShelf,
    AllPass,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Coefs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl Coefs {
    pub const IDENTITY: Coefs = Coefs {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    pub fn new(kind: Kind, freq: f64, q: f64, gain_db: f64, sample_rate: f64) -> Coefs {
        let f = freq.clamp(1.0, sample_rate * 0.49);
        let q = q.max(0.01);
        let w0 = 2.0 * PI * f / sample_rate;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        let a = 10f64.powf(gain_db / 40.0);
        let (b0, b1, b2, a0, a1, a2) = match kind {
            Kind::LowPass => (
                (1.0 - cos) / 2.0,
                1.0 - cos,
                (1.0 - cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
            Kind::HighPass => (
                (1.0 + cos) / 2.0,
                -(1.0 + cos),
                (1.0 + cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
            Kind::BandPass => (alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cos, 1.0 - alpha),
            Kind::Notch => (1.0, -2.0 * cos, 1.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha),
            Kind::AllPass => (
                1.0 - alpha,
                -2.0 * cos,
                1.0 + alpha,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ),
            Kind::Peak => (
                1.0 + alpha * a,
                -2.0 * cos,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos,
                1.0 - alpha / a,
            ),
            Kind::LowShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                    a * ((a + 1.0) - (a - 1.0) * cos - s),
                    (a + 1.0) + (a - 1.0) * cos + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                    (a + 1.0) + (a - 1.0) * cos - s,
                )
            }
            Kind::HighShelf => {
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                    a * ((a + 1.0) + (a - 1.0) * cos - s),
                    (a + 1.0) - (a - 1.0) * cos + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos),
                    (a + 1.0) - (a - 1.0) * cos - s,
                )
            }
        };
        Coefs {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// 주파수 응답 크기 (선형) — 테스트와 EQ 곡선 그리기에 쓴다
    pub fn magnitude(&self, freq: f64, sample_rate: f64) -> f64 {
        let w = 2.0 * PI * freq / sample_rate;
        let (s1, c1) = w.sin_cos();
        let (s2, c2) = (2.0 * w).sin_cos();
        let nr = self.b0 + self.b1 * c1 + self.b2 * c2;
        let ni = -(self.b1 * s1 + self.b2 * s2);
        let dr = 1.0 + self.a1 * c1 + self.a2 * c2;
        let di = -(self.a1 * s1 + self.a2 * s2);
        ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Biquad {
    pub c: Coefs,
    z1: f64,
    z2: f64,
}

impl Biquad {
    pub fn new(c: Coefs) -> Self {
        Self {
            c,
            z1: 0.0,
            z2: 0.0,
        }
    }

    pub fn set(&mut self, c: Coefs) {
        self.c = c;
    }

    #[inline(always)]
    pub fn tick(&mut self, x: f32) -> f32 {
        let x = x as f64;
        let y = self.c.b0 * x + self.z1;
        self.z1 = self.c.b1 * x - self.c.a1 * y + self.z2;
        self.z2 = self.c.b2 * x - self.c.a2 * y;
        if self.z1.abs() < 1e-25 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-25 {
            self.z2 = 0.0;
        }
        y as f32
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// 일차 필터 (원폴) — 톤 다듬기·레벨 감지 전처리
#[derive(Clone, Copy, Debug, Default)]
pub struct OnePole {
    a: f32,
    z: f32,
}

impl OnePole {
    pub fn lowpass(freq: f32, sample_rate: f32) -> Self {
        let mut p = Self::default();
        p.set_freq(freq, sample_rate);
        p
    }
    pub fn set_freq(&mut self, freq: f32, sample_rate: f32) {
        self.a = (-2.0 * std::f32::consts::PI * freq / sample_rate).exp();
    }
    #[inline(always)]
    pub fn lp(&mut self, x: f32) -> f32 {
        self.z = super::flush(x + (self.z - x) * self.a);
        self.z
    }
    #[inline(always)]
    pub fn hp(&mut self, x: f32) -> f32 {
        x - self.lp(x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_sine(b: &mut Biquad, freq: f64, sr: f64) -> f64 {
        let n = (sr * 0.5) as usize;
        let mut peak = 0f64;
        for i in 0..n {
            let x = (2.0 * PI * freq * i as f64 / sr).sin() as f32;
            let y = b.tick(x) as f64;
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn lowpass_passes_low_cuts_high() {
        let sr = 48000.0;
        let c = Coefs::new(Kind::LowPass, 1000.0, 0.707, 0.0, sr);
        assert!((c.magnitude(100.0, sr) - 1.0).abs() < 0.01);
        assert!((c.magnitude(1000.0, sr) - 0.707).abs() < 0.01);
        assert!(c.magnitude(10000.0, sr) < 0.02);
        let mut b = Biquad::new(c);
        assert!(run_sine(&mut b, 10000.0, sr) < 0.03);
    }

    #[test]
    fn peak_gain_matches_db() {
        let sr = 48000.0;
        let c = Coefs::new(Kind::Peak, 2000.0, 1.0, 6.0, sr);
        assert!((c.magnitude(2000.0, sr) - 10f64.powf(6.0 / 20.0)).abs() < 0.01);
        let shelf = Coefs::new(Kind::HighShelf, 4000.0, 0.707, -12.0, sr);
        assert!((20.0 * shelf.magnitude(18000.0, sr).log10() + 12.0).abs() < 0.5);
    }
}

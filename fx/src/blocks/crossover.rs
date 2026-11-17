//! 린크위츠-라일리 4차 크로스오버 — 멀티밴드 컴프·스테레오 스프레드가 쓴다.
//!
//! LR4 = 같은 버터워스 2차를 두 번. 저역+고역을 더하면 **크기는 평탄**하고 위상만 돈다.
//! 밴드가 셋 이상이면 낮은 쪽 밴드에 위쪽 분할점의 올패스를 걸어 위상을 맞춘다 —
//! 안 맞추면 밴드를 다시 더할 때 분할점 근처가 파인다.

use super::biquad::{Biquad, Coefs, Kind};

#[derive(Clone, Copy, Debug)]
pub struct Lr4 {
    lp: [Biquad; 2],
    hp: [Biquad; 2],
}

impl Lr4 {
    pub fn new(freq: f64, sample_rate: f64) -> Self {
        let mut s = Self {
            lp: [Biquad::default(); 2],
            hp: [Biquad::default(); 2],
        };
        s.set(freq, sample_rate);
        s
    }

    pub fn set(&mut self, freq: f64, sample_rate: f64) {
        let q = std::f64::consts::FRAC_1_SQRT_2;
        let lp = Coefs::new(Kind::LowPass, freq, q, 0.0, sample_rate);
        let hp = Coefs::new(Kind::HighPass, freq, q, 0.0, sample_rate);
        for b in &mut self.lp {
            b.set(lp);
        }
        for b in &mut self.hp {
            b.set(hp);
        }
    }

    /// (저역, 고역)
    #[inline(always)]
    pub fn split(&mut self, x: f32) -> (f32, f32) {
        let l = self.lp[0].tick(x);
        let l = self.lp[1].tick(l);
        let h = self.hp[0].tick(x);
        let h = self.hp[1].tick(h);
        (l, h)
    }
}

/// LR4 와 같은 위상을 내는 2차 올패스 (Q = 1/√2 두 번 = LR4 위상)
#[derive(Clone, Copy, Debug)]
pub struct Lr4AllPass {
    ap: Biquad,
}

impl Lr4AllPass {
    pub fn new(freq: f64, sample_rate: f64) -> Self {
        Self {
            ap: Biquad::new(Coefs::new(
                Kind::AllPass,
                freq,
                std::f64::consts::FRAC_1_SQRT_2,
                0.0,
                sample_rate,
            )),
        }
    }
    pub fn set(&mut self, freq: f64, sample_rate: f64) {
        self.ap.set(Coefs::new(
            Kind::AllPass,
            freq,
            std::f64::consts::FRAC_1_SQRT_2,
            0.0,
            sample_rate,
        ));
    }
    #[inline(always)]
    pub fn tick(&mut self, x: f32) -> f32 {
        self.ap.tick(x)
    }
}

/// 4밴드 분할 (분할점 3개)
#[derive(Clone, Debug)]
pub struct FourBand {
    x1: Lr4,
    x2: Lr4,
    x3: Lr4,
    /// 밴드 1·2 를 3번 분할점 위상에 맞춘다
    ap3_low: Lr4AllPass,
    ap3_mid: Lr4AllPass,
    /// 밴드 3·4 를 1번 분할점 위상에 맞춘다
    ap1_hi: Lr4AllPass,
    ap1_top: Lr4AllPass,
}

impl FourBand {
    pub fn new(f: [f64; 3], sample_rate: f64) -> Self {
        Self {
            x1: Lr4::new(f[0], sample_rate),
            x2: Lr4::new(f[1], sample_rate),
            x3: Lr4::new(f[2], sample_rate),
            ap3_low: Lr4AllPass::new(f[2], sample_rate),
            ap3_mid: Lr4AllPass::new(f[2], sample_rate),
            ap1_hi: Lr4AllPass::new(f[0], sample_rate),
            ap1_top: Lr4AllPass::new(f[0], sample_rate),
        }
    }

    pub fn set(&mut self, f: [f64; 3], sample_rate: f64) {
        self.x1.set(f[0], sample_rate);
        self.x2.set(f[1], sample_rate);
        self.x3.set(f[2], sample_rate);
        self.ap3_low.set(f[2], sample_rate);
        self.ap3_mid.set(f[2], sample_rate);
        self.ap1_hi.set(f[0], sample_rate);
        self.ap1_top.set(f[0], sample_rate);
    }

    #[inline(always)]
    pub fn split(&mut self, x: f32) -> [f32; 4] {
        let (low12, high34) = self.x2.split(x);
        let (b1, b2) = self.x1.split(low12);
        let (b3, b4) = self.x3.split(high34);
        // 아래 갈래는 x1 위상을, 위 갈래는 x3 위상을 지났다 — 서로 상대 것을 더 건다
        let b1 = self.ap3_low.tick(b1);
        let b2 = self.ap3_mid.tick(b2);
        let b3 = self.ap1_hi.tick(b3);
        let b4 = self.ap1_top.tick(b4);
        [b1, b2, b3, b4]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 네 밴드를 더하면 크기가 평탄해야 한다 (위상만 돈다)
    #[test]
    fn four_bands_sum_flat() {
        let sr = 48000.0;
        for freq in [60.0, 200.0, 800.0, 2500.0, 6000.0, 12000.0] {
            let mut fb = FourBand::new([150.0, 1000.0, 5000.0], sr);
            let n = 48000;
            // 피크가 아니라 RMS — 12kHz 는 한 주기에 4점이라 표본 피크가 위상 따라 흔들린다
            let mut energy = 0f64;
            let mut count = 0;
            for i in 0..n {
                let x = (2.0 * std::f64::consts::PI * freq * i as f64 / sr).sin() as f32;
                let s: f32 = fb.split(x).iter().sum();
                if i > n / 2 {
                    energy += (s as f64) * (s as f64);
                    count += 1;
                }
            }
            let rms = (energy / count as f64).sqrt();
            assert!(
                (rms - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.01,
                "{freq}Hz 합 RMS {rms}"
            );
        }
    }
}

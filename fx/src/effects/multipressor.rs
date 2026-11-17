//! 멀티프레서 (Logic Multipressor) — 4밴드 컴프레서.
//!
//! 린크위츠-라일리 4차로 넷으로 나눠(합이 평탄하다) 밴드마다 따로 누르고 다시 더한다.
//! 감지는 좌우 중 큰 쪽(스테레오 링크) — 따로 누르면 소리가 좌우로 흔들린다.
//!
//! 파라미터: 0~2 분할 Hz · 3 어택 ms · 4 릴리즈 ms · 5 출력 dB ·
//!           밴드 b(0..4) 마다 6+3b 스레숄드 dB · 7+3b 레이시오 · 8+3b 게인 dB
//! 미터: 0~3 밴드별 게인 감소 dB

use super::{Effect, Meters, Params};
use crate::blocks::crossover::FourBand;
use crate::blocks::db_to_gain;
use crate::blocks::env::{compress_db, Follower};
use crate::blocks::smooth::Smooth;

pub struct Multipressor {
    sr: f32,
    xl: FourBand,
    xr: FourBand,
    freqs: [f32; 3],
    det: [Follower; 4],
    threshold: [f32; 4],
    ratio: [f32; 4],
    makeup: [Smooth; 4],
    out: Smooth,
    gr: [f32; 4],
}

impl Multipressor {
    pub fn new(sr: f32, p: &Params) -> Self {
        let f = [120.0, 1000.0, 6000.0];
        let mut m = Self {
            sr,
            xl: FourBand::new(f.map(|v| v as f64), sr as f64),
            xr: FourBand::new(f.map(|v| v as f64), sr as f64),
            freqs: f,
            det: [Follower::new(sr); 4],
            threshold: [0.0; 4],
            ratio: [1.0; 4],
            makeup: [Smooth::new(20.0, sr); 4],
            out: Smooth::new(20.0, sr),
            gr: [0.0; 4],
        };
        m.set_params(p);
        m
    }
}

impl Effect for Multipressor {
    fn set_params(&mut self, p: &Params) {
        let a = p[0].clamp(30.0, 500.0);
        let b = p[1].clamp(a * 1.5, 5000.0);
        let c = p[2].clamp(b * 1.5, 16000.0);
        if [a, b, c] != self.freqs {
            self.freqs = [a, b, c];
            let f = [a as f64, b as f64, c as f64];
            self.xl.set(f, self.sr as f64);
            self.xr.set(f, self.sr as f64);
        }
        let attack = p[3].clamp(0.1, 200.0);
        let release = p[4].clamp(5.0, 2000.0);
        for (i, d) in self.det.iter_mut().enumerate() {
            // 낮은 밴드는 한 주기가 길다 — 같은 어택이면 파형을 따라 떨며 일그러진다
            let slow = [2.0, 1.0, 1.0, 1.0][i];
            d.set_times(attack * slow, release * slow, self.sr);
        }
        self.out.set(db_to_gain(p[5].clamp(-24.0, 24.0)));
        for bnd in 0..4 {
            self.threshold[bnd] = p[6 + 3 * bnd].clamp(-60.0, 0.0);
            self.ratio[bnd] = p[7 + 3 * bnd].clamp(1.0, 20.0);
            self.makeup[bnd].set(db_to_gain(p[8 + 3 * bnd].clamp(-24.0, 24.0)));
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let mut gr = [0.0f32; 4];
        for i in 0..l.len() {
            let bl = self.xl.split(l[i]);
            let br = self.xr.split(r[i]);
            let mut ol = 0.0;
            let mut or = 0.0;
            for b in 0..4 {
                let lvl = self.det[b].tick(bl[b].abs().max(br[b].abs()));
                let red = compress_db(lvl, self.threshold[b], self.ratio[b], 6.0);
                gr[b] = gr[b].min(red);
                let g = db_to_gain(red) * self.makeup[b].tick();
                ol += bl[b] * g;
                or += br[b] * g;
            }
            let o = self.out.tick();
            l[i] = ol * o;
            r[i] = or * o;
        }
        self.gr = gr;
    }

    fn meters(&self, out: &mut Meters) {
        out[..4].copy_from_slice(&self.gr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    fn neutral() -> Params {
        let mut p = [0.0; 24];
        p[0] = 120.0;
        p[1] = 1000.0;
        p[2] = 6000.0;
        p[3] = 10.0;
        p[4] = 150.0;
        for b in 0..4 {
            p[6 + 3 * b] = 0.0;
            p[7 + 3 * b] = 1.0;
        }
        p
    }

    #[test]
    fn neutral_is_transparent_in_level() {
        let sr = 48000.0;
        let p = neutral();
        let mut m = Multipressor::new(sr, &p);
        for f in [80.0, 500.0, 3000.0, 10000.0] {
            let x = sine(f, sr, 24000, 0.5);
            let (l, _) = run(&mut m, &p, &x, &x);
            assert!((peak(&l[12000..]) - 0.5).abs() < 0.02, "{f}Hz");
        }
    }

    #[test]
    fn compresses_only_the_loud_band() {
        let sr = 48000.0;
        let mut p = neutral();
        // 저역 밴드만 −30dB 에서 10:1
        p[6] = -30.0;
        p[7] = 10.0;
        let mut m = Multipressor::new(sr, &p);
        let low = sine(60.0, sr, 48000, 0.5);
        let (l, _) = run(&mut m, &p, &low, &low);
        assert!(
            peak(&l[24000..]) < 0.15,
            "저역 −6dB 입력이 크게 눌린다: {}",
            peak(&l[24000..])
        );
        let high = sine(3000.0, sr, 48000, 0.5);
        let mut m = Multipressor::new(sr, &p);
        let (h, _) = run(&mut m, &p, &high, &high);
        assert!((peak(&h[24000..]) - 0.5).abs() < 0.03, "다른 밴드는 그대로");
        let mut meters = [0.0; 16];
        m.meters(&mut meters);
        assert!(meters[2] > -0.5);
    }
}

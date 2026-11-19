//! 노이즈 게이트 (Logic Noise Gate) — 스레숄드 아래면 닫는다(`reduction` 만큼 줄인다).
//!
//! 열림/닫힘 판정에 **히스테리시스**를 둔다: 열 때는 스레숄드, 닫을 때는 스레숄드+히스테리시스(음수).
//! 없으면 스레숄드 근처 소리에서 게이트가 떨며 "채터링"한다.
//! **홀드**: 닫힘 판정 뒤에도 그 시간만큼 열어 둔다 — 드럼 꼬리가 잘리지 않게.
//! 사이드체인 필터(로우컷·하이컷)는 감지 신호에만 건다 — 킥 새는 소리에 하이햇 게이트가 열리지 않게.
//!
//! 파라미터: 0 스레숄드 dB · 1 줄임 dB(음수) · 2 어택 ms · 3 홀드 ms · 4 릴리즈 ms ·
//!           5 히스테리시스 dB(음수) · 6 감지 로우컷 Hz · 7 감지 하이컷 Hz
//! 미터: 0 게인 감소 dB · 1 감지 레벨 dB · 2 열림(1)/닫힘(0)

use super::{Effect, Meters, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind};
use crate::blocks::db_to_gain;
use crate::blocks::env::GainSmoother;

pub struct Gate {
    sr: f32,
    threshold: f32,
    reduction: f32,
    hysteresis: f32,
    hold: usize,
    held: usize,
    open: bool,
    level_db: f32,
    peak_coef: f32,
    smoother: GainSmoother,
    sc_hp: Biquad,
    sc_lp: Biquad,
    sc: (f32, f32),
}

impl Gate {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut g = Self {
            sr,
            threshold: -40.0,
            reduction: -60.0,
            hysteresis: -3.0,
            hold: 0,
            held: 0,
            open: false,
            level_db: -120.0,
            peak_coef: crate::blocks::time_coef(2.0, sr),
            smoother: GainSmoother::new(),
            sc_hp: Biquad::default(),
            sc_lp: Biquad::default(),
            sc: (-1.0, -1.0),
        };
        g.set_params(p);
        // 처음엔 닫힌 상태에서 시작 — 무음 앞부분의 잡음이 새지 않게
        g.smoother.tick(g.reduction);
        g
    }
}

impl Effect for Gate {
    fn set_params(&mut self, p: &Params) {
        self.threshold = p[0].clamp(-100.0, 0.0);
        self.reduction = p[1].clamp(-100.0, 0.0);
        let attack = p[2].clamp(0.01, 200.0);
        self.hold = (p[3].clamp(0.0, 2000.0) * 0.001 * self.sr) as usize;
        let release = p[4].clamp(1.0, 5000.0);
        self.hysteresis = p[5].clamp(-30.0, 0.0);
        // 게이트의 어택은 **여는** 속도, 릴리즈는 닫는 속도 — 컴프와 반대 방향이다
        self.smoother.set_times(release, attack, self.sr);
        let hp = p[6].clamp(20.0, 8000.0);
        let lp = p[7].clamp(200.0, 20000.0);
        if (hp, lp) != self.sc {
            self.sc = (hp, lp);
            let sr = self.sr as f64;
            self.sc_hp
                .set(Coefs::new(Kind::HighPass, hp as f64, 0.707, 0.0, sr));
            self.sc_lp
                .set(Coefs::new(Kind::LowPass, lp as f64, 0.707, 0.0, sr));
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.run(l, r, None);
    }

    fn process_keyed(&mut self, l: &mut [f32], r: &mut [f32], kl: &[f32], kr: &[f32]) {
        self.run(l, r, Some((kl, kr)));
    }

    fn meters(&self, out: &mut Meters) {
        self.write_meters(out);
    }
}

impl Gate {
    fn run(&mut self, l: &mut [f32], r: &mut [f32], key: Option<(&[f32], &[f32])>) {
        for i in 0..l.len() {
            let (a, b) = key.map_or((l[i], r[i]), |(kl, kr)| (kl[i], kr[i]));
            let key = self.sc_lp.tick(self.sc_hp.tick(0.5 * (a + b)));
            // 피크 감지 — 빠른 어택, 2ms 릴리즈(판정용이라 짧게)
            let m = crate::blocks::gain_to_db(key.abs() * 2.0);
            self.level_db = if m > self.level_db {
                m
            } else {
                m + (self.level_db - m) * self.peak_coef
            };
            if self.level_db >= self.threshold {
                self.open = true;
                self.held = self.hold;
            } else if self.level_db < self.threshold + self.hysteresis {
                if self.held > 0 {
                    self.held -= 1;
                } else {
                    self.open = false;
                }
            }
            let g = db_to_gain(
                self.smoother
                    .tick(if self.open { 0.0 } else { self.reduction }),
            );
            l[i] *= g;
            r[i] *= g;
        }
    }

    fn write_meters(&self, out: &mut Meters) {
        out[0] = self.smoother.db();
        out[1] = self.level_db;
        out[2] = if self.open { 1.0 } else { 0.0 };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    fn params(threshold: f32) -> Params {
        let mut p = [0.0; 24];
        p[0] = threshold;
        p[1] = -80.0;
        p[2] = 0.5;
        p[3] = 20.0;
        p[4] = 50.0;
        p[5] = -3.0;
        p[6] = 20.0;
        p[7] = 20000.0;
        p
    }

    #[test]
    fn closes_on_quiet_opens_on_loud() {
        let sr = 48000.0;
        let p = params(-30.0);
        let mut g = Gate::new(sr, &p);
        let quiet = sine(440.0, sr, 9600, 0.003); // 약 −50dB
        let (ql, _) = run(&mut g, &p, &quiet, &quiet);
        assert!(peak(&ql[4800..]) < 0.0001, "작은 소리는 닫혀 −80dB");
        let loud = sine(440.0, sr, 9600, 0.5);
        let (ll, _) = run(&mut g, &p, &loud, &loud);
        assert!((peak(&ll[2400..]) - 0.5).abs() < 0.01, "큰 소리는 그대로");
    }

    #[test]
    fn hold_keeps_tail() {
        let sr = 48000.0;
        let mut p = params(-30.0);
        p[3] = 100.0;
        let mut g = Gate::new(sr, &p);
        let mut x = sine(440.0, sr, 4800, 0.5);
        x.extend(sine(440.0, sr, 9600, 0.003)); // 갑자기 작아짐
        let (l, _) = run(&mut g, &p, &x, &x);
        // 작아진 뒤 50ms 지점 — 홀드 100ms 라 아직 열려 있다
        assert!(peak(&l[4800 + 2000..4800 + 2400]) > 0.002);
        let mut m = [0.0; 16];
        g.meters(&mut m);
        assert_eq!(m[2], 0.0, "100ms 지나면 닫힌다");
    }
}

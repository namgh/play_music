//! 음정 감지 (YIN, 드 슈베이니·가와하라 2002) — 피치 보정·튜너가 쓴다.
//!
//! 비용을 줄이려고 **4분의 1 로 솎은 신호**(12kHz)에서 잰다: 창 512(약 43ms), 최대 지연 300(40Hz).
//! 솎기 전에 저역통과(4차)로 접힘을 막는다. 256 샘플마다 한 번 잰다.

use super::biquad::{Biquad, Coefs, Kind};

const DEC: usize = 4;
const W: usize = 512;
const MAX_LAG: usize = 300;
const MIN_LAG: usize = 6; // 2kHz 위는 안 잰다
const EVERY: usize = 256;

pub struct Yin {
    sr: f32,
    lp: [Biquad; 2],
    buf: Vec<f32>,
    pos: usize,
    phase: usize,
    since: usize,
    diff: Vec<f32>,
    /// 마지막으로 잰 주파수 (못 쟀으면 0)
    pub hz: f32,
    /// 확신 (0..1, 1 이 확실)
    pub clarity: f32,
    pub threshold: f32,
}

impl Yin {
    pub fn new(sr: f32) -> Self {
        let c = Coefs::new(
            Kind::LowPass,
            (sr / DEC as f32 * 0.4) as f64,
            0.707,
            0.0,
            sr as f64,
        );
        Self {
            sr,
            lp: [Biquad::new(c); 2],
            buf: vec![0.0; 2 * (W + MAX_LAG)],
            pos: 0,
            phase: 0,
            since: 0,
            diff: vec![0.0; MAX_LAG + 1],
            hz: 0.0,
            clarity: 0.0,
            threshold: 0.15,
        }
    }

    /// 한 샘플. 새로 쟀으면 true
    #[inline]
    pub fn tick(&mut self, x: f32) -> bool {
        let a = self.lp[0].tick(x);
        let y = self.lp[1].tick(a);
        self.phase += 1;
        if self.phase < DEC {
            return false;
        }
        self.phase = 0;
        let n = W + MAX_LAG;
        self.buf[self.pos] = y;
        self.buf[self.pos + n] = y;
        self.pos = (self.pos + 1) % n;
        self.since += DEC;
        if self.since < EVERY {
            return false;
        }
        self.since = 0;
        self.measure();
        true
    }

    fn measure(&mut self) {
        let n = W + MAX_LAG;
        // 가장 오래된 표본부터 연속 구간
        let s = &self.buf[self.pos..self.pos + n];
        let mut energy = 0.0;
        for v in &s[..W] {
            energy += v * v;
        }
        if energy < 1e-6 {
            self.hz = 0.0;
            self.clarity = 0.0;
            return;
        }
        // 차이 함수 d(τ) 와 누적 평균 정규화 d'(τ)
        self.diff[0] = 1.0;
        let mut running = 0.0;
        for tau in 1..=MAX_LAG {
            let mut d = 0.0;
            for i in 0..W {
                let e = s[i] - s[i + tau];
                d += e * e;
            }
            running += d;
            self.diff[tau] = if running > 0.0 {
                d * tau as f32 / running
            } else {
                1.0
            };
        }
        // 문턱 아래로 처음 내려간 골의 바닥
        let mut best = 0;
        let mut tau = MIN_LAG;
        while tau < MAX_LAG {
            if self.diff[tau] < self.threshold {
                while tau + 1 < MAX_LAG && self.diff[tau + 1] < self.diff[tau] {
                    tau += 1;
                }
                best = tau;
                break;
            }
            tau += 1;
        }
        if best == 0 {
            self.hz = 0.0;
            self.clarity = 0.0;
            return;
        }
        // 포물선 보간으로 분수 지연
        let (a, b, c) = (self.diff[best - 1], self.diff[best], self.diff[best + 1]);
        let denom = a - 2.0 * b + c;
        let shift = if denom.abs() > 1e-9 {
            0.5 * (a - c) / denom
        } else {
            0.0
        };
        let lag = (best as f32 + shift.clamp(-1.0, 1.0)) * DEC as f32;
        self.hz = self.sr / lag;
        self.clarity = (1.0 - b).clamp(0.0, 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_pitch_within_a_few_cents() {
        let sr = 48000.0;
        for f in [82.4f32, 110.0, 220.0, 440.0, 659.3, 1000.0] {
            let mut y = Yin::new(sr);
            for n in 0..24000 {
                // 배음이 있는 소리 (톱니 근사)
                let t = std::f32::consts::TAU * f * n as f32 / sr;
                let x = t.sin() + 0.5 * (2.0 * t).sin() + 0.3 * (3.0 * t).sin();
                y.tick(x * 0.3);
            }
            let cents = 1200.0 * (y.hz / f).log2();
            assert!(cents.abs() < 8.0, "{f}Hz → {}Hz ({cents}¢)", y.hz);
        }
    }

    #[test]
    fn silence_is_unvoiced() {
        let mut y = Yin::new(48000.0);
        for _ in 0..10000 {
            y.tick(0.0);
        }
        assert_eq!(y.hz, 0.0);
    }
}

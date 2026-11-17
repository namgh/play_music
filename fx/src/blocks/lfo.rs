//! LFO 와 힐베르트 변환 (주파수 시프터·링 모듈레이터·로터가 쓴다).

use std::f32::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    Sine,
    Triangle,
    /// 모서리를 둥글린 사각 (딸깍 소리 방지)
    Square,
    SawUp,
}

impl Shape {
    pub fn from_index(i: f32) -> Shape {
        match i.round() as i32 {
            1 => Shape::Triangle,
            2 => Shape::Square,
            3 => Shape::SawUp,
            _ => Shape::Sine,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Lfo {
    /// 0 … 1
    pub phase: f32,
    inc: f32,
}

impl Lfo {
    pub fn new(phase: f32) -> Self {
        Self {
            phase: phase.rem_euclid(1.0),
            inc: 0.0,
        }
    }

    pub fn set_rate(&mut self, hz: f32, sample_rate: f32) {
        self.inc = hz / sample_rate;
    }

    /// −1 … 1, 그리고 위상을 한 칸 민다
    #[inline(always)]
    pub fn tick(&mut self, shape: Shape) -> f32 {
        let v = value(shape, self.phase);
        self.phase += self.inc;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        v
    }
}

/// 위상(0…1) → −1…1
#[inline(always)]
pub fn value(shape: Shape, phase: f32) -> f32 {
    match shape {
        Shape::Sine => (TAU * phase).sin(),
        Shape::Triangle => 1.0 - 4.0 * (phase - 0.5).abs(),
        Shape::Square => ((TAU * phase).sin() * 6.0).tanh(),
        Shape::SawUp => 2.0 * phase - 1.0,
    }
}

/// 사인 오실레이터 (회전자) — 샘플마다 sin 을 부르지 않는다. 주기적으로 크기를 1 로 되돌린다
#[derive(Clone, Copy, Debug)]
pub struct Rotor {
    c: f32,
    s: f32,
    cos_d: f32,
    sin_d: f32,
    n: u32,
}

impl Rotor {
    pub fn new() -> Self {
        Self {
            c: 1.0,
            s: 0.0,
            cos_d: 1.0,
            sin_d: 0.0,
            n: 0,
        }
    }
    pub fn set_freq(&mut self, hz: f32, sample_rate: f32) {
        let w = TAU * hz / sample_rate;
        self.cos_d = w.cos();
        self.sin_d = w.sin();
    }
    /// (cos, sin)
    #[inline(always)]
    pub fn tick(&mut self) -> (f32, f32) {
        let out = (self.c, self.s);
        let c = self.c * self.cos_d - self.s * self.sin_d;
        let s = self.c * self.sin_d + self.s * self.cos_d;
        self.c = c;
        self.s = s;
        self.n += 1;
        if self.n >= 1024 {
            self.n = 0;
            let m = 1.0 / (c * c + s * s).sqrt();
            self.c *= m;
            self.s *= m;
        }
        out
    }
}

impl Default for Rotor {
    fn default() -> Self {
        Self::new()
    }
}

/// 힐베르트 변환 — 올패스 두 갈래(각 4단)의 위상차가 20Hz…20kHz 에서 90°.
/// 계수는 올리 니에미탈로의 공개 설계(폴리페이즈 IIR 하프밴드)를 따른다.
#[derive(Clone, Copy, Debug, Default)]
pub struct Hilbert {
    a: [Ap1; 4],
    b: [Ap1; 4],
    delay: f32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Ap1 {
    k: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Ap1 {
    #[inline(always)]
    fn tick(&mut self, x: f32) -> f32 {
        // 2차 지연 올패스: y = k(x + y[n-2]) − x[n-2]
        let y = self.k * (x + self.y2) - self.x2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = super::flush(y);
        y
    }
}

const HA: [f32; 4] = [0.692_387_8, 0.936_065_4, 0.988_229_5, 0.998_748_8];
const HB: [f32; 4] = [0.402_192_1, 0.856_171_1, 0.972_291, 0.995_288_5];

impl Hilbert {
    pub fn new() -> Self {
        let mut h = Self::default();
        for i in 0..4 {
            h.a[i].k = HA[i] * HA[i];
            h.b[i].k = HB[i] * HB[i];
        }
        h
    }

    /// (동상 I, 직교 Q)
    #[inline(always)]
    pub fn tick(&mut self, x: f32) -> (f32, f32) {
        let mut i = x;
        for s in &mut self.a {
            i = s.tick(i);
        }
        let mut q = x;
        for s in &mut self.b {
            q = s.tick(q);
        }
        // A 갈래를 한 샘플 늦춰 맞춘다 (설계가 그렇게 짝지어져 있다)
        let id = self.delay;
        self.delay = i;
        (id, q)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hilbert_outputs_are_in_quadrature() {
        let sr = 48000.0;
        for f in [100.0f32, 1000.0, 8000.0] {
            let mut h = Hilbert::new();
            let mut dot = 0f64;
            let mut ei = 0f64;
            let mut eq = 0f64;
            for n in 0..48000 {
                let x = (TAU * f * n as f32 / sr).sin();
                let (i, q) = h.tick(x);
                if n > 24000 {
                    dot += (i * q) as f64;
                    ei += (i * i) as f64;
                    eq += (q * q) as f64;
                }
            }
            // 90° 면 내적이 0, 크기는 같다
            assert!(
                (dot / (ei * eq).sqrt()).abs() < 0.03,
                "{f}Hz 상관 {}",
                dot / (ei * eq).sqrt()
            );
            assert!((ei / eq - 1.0).abs() < 0.02);
        }
    }

    #[test]
    fn rotor_is_stable() {
        let mut r = Rotor::new();
        r.set_freq(440.0, 48000.0);
        for _ in 0..1_000_000 {
            r.tick();
        }
        let (c, s) = r.tick();
        assert!(((c * c + s * s) - 1.0).abs() < 1e-3);
    }
}

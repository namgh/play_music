//! 4배 오버샘플링 (`CLAUDE.md` 절대 타협 불가 — 비선형 단계 오버샘플링).
//!
//! 올림·내림 모두 68탭 선형 위상 FIR(카이저 창 sinc, 차단 0.45·원래 fs).
//! 4배 속도에서 올림+내림 군지연 67 샘플 + 솎는 자리(넷 중 마지막) 3 = 70 → 원래 속도 **정확히 16 샘플**.
//! 탭 수를 65 로 하면 15.25 샘플이라 지연 보정이 4분의 1 샘플 어긋난다 — 그래서 68 이다.
//! 폴리페이즈로 올림은 탭 1/4 만 곱한다.

const TAPS: usize = 68;
const FACTOR: usize = 4;
/// 올림+내림 전체 지연 (원래 속도 샘플)
pub const LATENCY: usize = (TAPS - 4) / FACTOR;
const _: () = assert!(
    (TAPS - 1) % FACTOR == FACTOR - 1,
    "지연이 정수 샘플이 아니다"
);

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    for k in 1..30 {
        term *= (x / (2.0 * k as f64)).powi(2);
        sum += term;
    }
    sum
}

fn design() -> [f32; TAPS] {
    let mut h = [0f32; TAPS];
    let fc = 0.45 / FACTOR as f64; // 4배 속도 기준 정규화 차단
    let beta = 8.0;
    let mid = (TAPS - 1) as f64 / 2.0;
    let mut sum = 0.0;
    for (n, v) in h.iter_mut().enumerate() {
        let t = n as f64 - mid;
        let sinc = if t == 0.0 {
            2.0 * fc
        } else {
            (2.0 * std::f64::consts::PI * fc * t).sin() / (std::f64::consts::PI * t)
        };
        let w = bessel_i0(beta * (1.0 - (t / mid).powi(2)).max(0.0).sqrt()) / bessel_i0(beta);
        *v = (sinc * w) as f32;
        sum += sinc * w;
    }
    for v in h.iter_mut() {
        *v /= sum as f32;
    }
    h
}

/// 히스토리를 두 벌(앞·뒤) 써서 내적이 언제나 연속 구간이 되게 한다 — 나머지 연산(%)이 루프 안에 없다.
#[derive(Clone, Debug)]
pub struct Oversampler {
    h: [f32; TAPS],
    /// 폴리페이즈 갈래별 탭 (갈래 p 는 h[p], h[p+4], …)
    poly: [[f32; TAPS.div_ceil(FACTOR)]; FACTOR],
    /// 원래 속도 입력 히스토리 (올림용) — 길이 2·L
    up_hist: [f32; 2 * TAPS.div_ceil(FACTOR)],
    up_pos: usize,
    down_hist: [f32; 2 * TAPS],
    down_pos: usize,
}

const PL: usize = TAPS.div_ceil(FACTOR);

impl Default for Oversampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Oversampler {
    pub fn new() -> Self {
        let h = design();
        let mut poly = [[0f32; PL]; FACTOR];
        for (p, row) in poly.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate() {
                *v = *h.get(p + j * FACTOR).unwrap_or(&0.0) * FACTOR as f32;
            }
        }
        Self {
            h,
            poly,
            up_hist: [0.0; 2 * PL],
            up_pos: 0,
            down_hist: [0.0; 2 * TAPS],
            down_pos: 0,
        }
    }

    /// 한 샘플 → 4배 속도 네 샘플 (0 을 끼워 넣고 저역통과, 이득 4 로 보상)
    #[inline]
    pub fn up(&mut self, x: f32) -> [f32; FACTOR] {
        self.up_pos = if self.up_pos == 0 {
            PL - 1
        } else {
            self.up_pos - 1
        };
        self.up_hist[self.up_pos] = x;
        self.up_hist[self.up_pos + PL] = x;
        let hist = &self.up_hist[self.up_pos..self.up_pos + PL];
        let mut out = [0f32; FACTOR];
        for (p, o) in out.iter_mut().enumerate() {
            let mut acc = 0.0;
            for (c, v) in self.poly[p].iter().zip(hist) {
                acc += c * v;
            }
            *o = acc;
        }
        out
    }

    /// 4배 속도 네 샘플 → 한 샘플 (저역통과 후 솎기)
    #[inline]
    pub fn down(&mut self, xs: [f32; FACTOR]) -> f32 {
        for x in xs {
            self.down_pos = if self.down_pos == 0 {
                TAPS - 1
            } else {
                self.down_pos - 1
            };
            let v = super::flush(x);
            self.down_hist[self.down_pos] = v;
            self.down_hist[self.down_pos + TAPS] = v;
        }
        let hist = &self.down_hist[self.down_pos..self.down_pos + TAPS];
        let mut acc = 0.0;
        for (c, v) in self.h.iter().zip(hist) {
            acc += c * v;
        }
        acc
    }
}

/// 비선형 함수를 4배로 돌린다
#[inline]
pub fn process<F: FnMut(f32) -> f32>(os: &mut Oversampler, x: f32, mut f: F) -> f32 {
    let up = os.up(x);
    os.down(up.map(&mut f))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_delayed_copy() {
        let mut os = Oversampler::new();
        let x: Vec<f32> = (0..400).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        let y: Vec<f32> = x.iter().map(|&v| process(&mut os, v, |s| s)).collect();
        for n in 100..400 {
            assert!(
                (y[n] - x[n - LATENCY]).abs() < 2e-3,
                "{n}: {} vs {}",
                y[n],
                x[n - LATENCY]
            );
        }
    }

    /// 하드 클립 10kHz — 오버샘플링하면 접힌 성분(에일리어스)이 크게 준다
    #[test]
    fn reduces_aliasing() {
        let sr = 48000.0f32;
        let f = 9000.0;
        let n = 16384;
        let x: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * f * i as f32 / sr).sin())
            .collect();
        let clip = |s: f32| (s * 4.0).clamp(-1.0, 1.0);
        let naive: Vec<f32> = x.iter().map(|&v| clip(v)).collect();
        let mut os = Oversampler::new();
        let over: Vec<f32> = x.iter().map(|&v| process(&mut os, v, clip)).collect();
        // 3차 고조파 27kHz 는 48k 에서 21kHz 로 접힌다 — 그 자리의 에너지를 비교
        let probe = |y: &[f32], hz: f32| {
            let (mut re, mut im) = (0f64, 0f64);
            for (i, v) in y.iter().enumerate().skip(1000) {
                let ph = 2.0 * std::f64::consts::PI * hz as f64 * i as f64 / sr as f64;
                re += *v as f64 * ph.cos();
                im += *v as f64 * ph.sin();
            }
            (re * re + im * im).sqrt()
        };
        let alias_naive = probe(&naive, 21000.0);
        let alias_over = probe(&over, 21000.0);
        assert!(
            alias_over < alias_naive * 0.1,
            "naive {alias_naive} over {alias_over}"
        );
    }
}

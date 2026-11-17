//! 단시간 푸리에 변환 틀 — 2048 창 · 512 홉(75% 겹침) · 사인 창(분석·합성 둘 다, 곱이 한 창).
//! 지연은 정확히 창 길이(2048 샘플). 좌우를 복소수 하나에 담아 FFT 한 번.
//!
//! 쓰는 쪽은 홉마다 좌·우 반쪽 스펙트럼(0..=N/2)을 받아 고친다.

use super::fft::{join_two_real, split_two_real, Fft};

pub const N: usize = 2048;
pub const HOP: usize = 512;
pub const BINS: usize = N / 2 + 1;
pub const LATENCY: usize = N;

pub struct Spectrum<'a> {
    pub lr: &'a mut [f32],
    pub li: &'a mut [f32],
    pub rr: &'a mut [f32],
    pub ri: &'a mut [f32],
}

pub struct Stft {
    fft: Fft,
    win: Vec<f32>,
    in_l: Vec<f32>,
    in_r: Vec<f32>,
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    emit_l: Vec<f32>,
    emit_r: Vec<f32>,
    fill: usize,
    re: Vec<f32>,
    im: Vec<f32>,
    spec: [Vec<f32>; 4],
    norm: f32,
}

impl Default for Stft {
    fn default() -> Self {
        Self::new()
    }
}

impl Stft {
    pub fn new() -> Self {
        let win: Vec<f32> = (0..N)
            .map(|i| (std::f32::consts::PI * (i as f32 + 0.5) / N as f32).sin())
            .collect();
        // 사인² 를 홉 N/4 로 겹치면 합이 2 — 그만큼 나눈다
        let norm = 1.0 / 2.0;
        Self {
            fft: Fft::new(N),
            win,
            in_l: vec![0.0; N],
            in_r: vec![0.0; N],
            out_l: vec![0.0; N],
            out_r: vec![0.0; N],
            emit_l: vec![0.0; HOP],
            emit_r: vec![0.0; HOP],
            fill: 0,
            re: vec![0.0; N],
            im: vec![0.0; N],
            spec: [
                vec![0.0; BINS],
                vec![0.0; BINS],
                vec![0.0; BINS],
                vec![0.0; BINS],
            ],
            norm,
        }
    }

    /// 한 샘플 넣고 한 샘플 받는다 (N 샘플 늦게). 홉마다 `f` 로 스펙트럼을 고친다
    #[inline]
    pub fn tick<F: FnMut(Spectrum)>(&mut self, l: f32, r: f32, f: &mut F) -> (f32, f32) {
        let y = (self.emit_l[self.fill], self.emit_r[self.fill]);
        self.in_l[N - HOP + self.fill] = l;
        self.in_r[N - HOP + self.fill] = r;
        self.fill += 1;
        if self.fill == HOP {
            self.fill = 0;
            self.frame(f);
        }
        y
    }

    fn frame<F: FnMut(Spectrum)>(&mut self, f: &mut F) {
        for i in 0..N {
            self.re[i] = self.in_l[i] * self.win[i];
            self.im[i] = self.in_r[i] * self.win[i];
        }
        self.fft.run(&mut self.re, &mut self.im, false);
        let [lr, li, rr, ri] = &mut self.spec;
        split_two_real(&self.re, &self.im, lr, li, rr, ri);
        f(Spectrum { lr, li, rr, ri });
        join_two_real(lr, li, rr, ri, &mut self.re, &mut self.im);
        self.fft.run(&mut self.re, &mut self.im, true);
        // 겹쳐 더하기
        self.out_l.copy_within(HOP.., 0);
        self.out_r.copy_within(HOP.., 0);
        for i in N - HOP..N {
            self.out_l[i] = 0.0;
            self.out_r[i] = 0.0;
        }
        for i in 0..N {
            self.out_l[i] += self.re[i] * self.win[i] * self.norm;
            self.out_r[i] += self.im[i] * self.win[i] * self.norm;
        }
        self.emit_l.copy_from_slice(&self.out_l[..HOP]);
        self.emit_r.copy_from_slice(&self.out_r[..HOP]);
        self.in_l.copy_within(HOP.., 0);
        self.in_r.copy_within(HOP.., 0);
    }
}

/// 빈 번호 → 주파수
#[inline(always)]
pub fn bin_hz(k: usize, sr: f32) -> f32 {
    k as f32 * sr / N as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_exact_delay() {
        let mut s = Stft::new();
        let x: Vec<f32> = (0..20000)
            .map(|i| ((i * 37 % 101) as f32 - 50.0) * 0.01)
            .collect();
        let mut nop = |_: Spectrum| {};
        let y: Vec<(f32, f32)> = x.iter().map(|&v| s.tick(v, -v, &mut nop)).collect();
        for n in 3 * N..x.len() {
            assert!(
                (y[n].0 - x[n - LATENCY]).abs() < 1e-3,
                "{n}: {} vs {}",
                y[n].0,
                x[n - LATENCY]
            );
            assert!((y[n].1 + x[n - LATENCY]).abs() < 1e-3);
        }
    }
}

//! 반복형 radix-2 복소 FFT. 실수 신호 둘(좌·우)을 한 번에 — 실수부 L, 허수부 R 로 넣고
//! `split_two_real` 로 두 스펙트럼을 갈라낸다 (FFT 한 번으로 스테레오).

use std::f64::consts::PI;

#[derive(Clone, Debug)]
pub struct Fft {
    pub n: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
    rev: Vec<u32>,
}

impl Fft {
    pub fn new(n: usize) -> Self {
        assert!(n.is_power_of_two() && n >= 2);
        let bits = n.trailing_zeros();
        let rev = (0..n as u32)
            .map(|i| i.reverse_bits() >> (32 - bits))
            .collect();
        let cos = (0..n / 2)
            .map(|k| (2.0 * PI * k as f64 / n as f64).cos() as f32)
            .collect();
        let sin = (0..n / 2)
            .map(|k| (2.0 * PI * k as f64 / n as f64).sin() as f32)
            .collect();
        Self { n, cos, sin, rev }
    }

    /// 제자리 변환. `inverse` 면 1/n 까지 곱한다
    pub fn run(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        let n = self.n;
        for i in 0..n {
            let j = self.rev[i] as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let sign = if inverse { 1.0 } else { -1.0 };
        let mut size = 2;
        while size <= n {
            let half = size / 2;
            let step = n / size;
            let mut start = 0;
            while start < n {
                for k in 0..half {
                    let wr = self.cos[k * step];
                    let wi = sign * self.sin[k * step];
                    let a = start + k;
                    let b = a + half;
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
                start += size;
            }
            size *= 2;
        }
        if inverse {
            let s = 1.0 / n as f32;
            for i in 0..n {
                re[i] *= s;
                im[i] *= s;
            }
        }
    }
}

/// z = FFT(l + i·r) 에서 L·R 반쪽 스펙트럼(0..=n/2)을 꺼낸다
pub fn split_two_real(
    re: &[f32],
    im: &[f32],
    lr: &mut [f32],
    li: &mut [f32],
    rr: &mut [f32],
    ri: &mut [f32],
) {
    let n = re.len();
    for k in 0..=n / 2 {
        let j = (n - k) & (n - 1);
        // X_L = (Z[k] + conj Z[n-k]) / 2,  X_R = (Z[k] − conj Z[n-k]) / 2i
        lr[k] = 0.5 * (re[k] + re[j]);
        li[k] = 0.5 * (im[k] - im[j]);
        rr[k] = 0.5 * (im[k] + im[j]);
        ri[k] = -0.5 * (re[k] - re[j]);
    }
}

/// 반쪽 스펙트럼 둘(Y_L, Y_R) → 전체 z = Y_L + i·Y_R (역변환하면 실수부 L, 허수부 R)
pub fn join_two_real(
    lr: &[f32],
    li: &[f32],
    rr: &[f32],
    ri: &[f32],
    re: &mut [f32],
    im: &mut [f32],
) {
    let n = re.len();
    for k in 0..=n / 2 {
        re[k] = lr[k] - ri[k];
        im[k] = li[k] + rr[k];
    }
    for k in n / 2 + 1..n {
        let j = n - k;
        // conj(Y_L[j]) + i·conj(Y_R[j])
        re[k] = lr[j] + ri[j];
        im[k] = -li[j] + rr[j];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_two_real_split() {
        let n = 64;
        let fft = Fft::new(n);
        let l: Vec<f32> = (0..n).map(|i| ((i * 7) % 11) as f32 - 5.0).collect();
        let r: Vec<f32> = (0..n).map(|i| ((i * 3) % 5) as f32 * 0.5).collect();
        let mut re = l.clone();
        let mut im = r.clone();
        fft.run(&mut re, &mut im, false);
        let h = n / 2 + 1;
        let (mut lr, mut li, mut rr, mut ri) =
            (vec![0.0; h], vec![0.0; h], vec![0.0; h], vec![0.0; h]);
        split_two_real(&re, &im, &mut lr, &mut li, &mut rr, &mut ri);
        // L 의 직류 성분 = 합
        let sum_l: f32 = l.iter().sum();
        assert!((lr[0] - sum_l).abs() < 1e-3);
        assert!(li[0].abs() < 1e-3);
        let mut re2 = vec![0.0; n];
        let mut im2 = vec![0.0; n];
        join_two_real(&lr, &li, &rr, &ri, &mut re2, &mut im2);
        fft.run(&mut re2, &mut im2, true);
        for i in 0..n {
            assert!((re2[i] - l[i]).abs() < 1e-3);
            assert!((im2[i] - r[i]).abs() < 1e-3);
        }
    }
}

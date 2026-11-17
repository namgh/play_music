//! 블록 분할 컨볼루션 (uniformly partitioned overlap-save) — 스테레오 IR.
//!
//! 블록 B 마다 FFT 한 번·역FFT 한 번(스테레오를 복소수 하나에 담는다). 지연은 B 샘플이고
//! 이펙트가 그 값을 보고해 지연 보정이 맞춘다. B 가 크면 싸고 늦다 — 1024(21ms)로 둔다.

use super::fft::{join_two_real, split_two_real, Fft};

pub struct Convolver {
    b: usize,
    fft: Fft,
    /// IR 파티션 스펙트럼 (좌·우), 각 P × (B+1)
    hl_re: Vec<f32>,
    hl_im: Vec<f32>,
    hr_re: Vec<f32>,
    hr_im: Vec<f32>,
    /// 입력 파티션 스펙트럼 지연선(FDL), 원형
    xl_re: Vec<f32>,
    xl_im: Vec<f32>,
    xr_re: Vec<f32>,
    xr_im: Vec<f32>,
    parts: usize,
    head: usize,
    /// 지난 블록 + 이번 블록 (2B)
    win_l: Vec<f32>,
    win_r: Vec<f32>,
    fill: usize,
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    acc: [Vec<f32>; 4],
}

impl Convolver {
    pub fn new(block: usize, ir_l: &[f32], ir_r: &[f32]) -> Self {
        let b = block;
        let n = 2 * b;
        let h = b + 1;
        let len = ir_l.len().max(ir_r.len()).max(1);
        let parts = len.div_ceil(b);
        let fft = Fft::new(n);
        let mut s = Self {
            b,
            fft,
            hl_re: vec![0.0; parts * h],
            hl_im: vec![0.0; parts * h],
            hr_re: vec![0.0; parts * h],
            hr_im: vec![0.0; parts * h],
            xl_re: vec![0.0; parts * h],
            xl_im: vec![0.0; parts * h],
            xr_re: vec![0.0; parts * h],
            xr_im: vec![0.0; parts * h],
            parts,
            head: 0,
            win_l: vec![0.0; n],
            win_r: vec![0.0; n],
            fill: 0,
            out_l: vec![0.0; b],
            out_r: vec![0.0; b],
            re: vec![0.0; n],
            im: vec![0.0; n],
            acc: [vec![0.0; h], vec![0.0; h], vec![0.0; h], vec![0.0; h]],
        };
        for p in 0..parts {
            s.re.iter_mut().for_each(|v| *v = 0.0);
            s.im.iter_mut().for_each(|v| *v = 0.0);
            for i in 0..b {
                s.re[i] = *ir_l.get(p * b + i).unwrap_or(&0.0);
                s.im[i] = *ir_r.get(p * b + i).unwrap_or(&0.0);
            }
            s.fft.run(&mut s.re, &mut s.im, false);
            let o = p * h;
            split_two_real(
                &s.re,
                &s.im,
                &mut s.hl_re[o..o + h],
                &mut s.hl_im[o..o + h],
                &mut s.hr_re[o..o + h],
                &mut s.hr_im[o..o + h],
            );
        }
        s
    }

    pub fn latency(&self) -> usize {
        self.b
    }

    /// 한 샘플 — 출력은 B 샘플 늦게 나온다
    #[inline]
    pub fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        let b = self.b;
        let y = (self.out_l[self.fill], self.out_r[self.fill]);
        self.win_l[b + self.fill] = l;
        self.win_r[b + self.fill] = r;
        self.fill += 1;
        if self.fill == b {
            self.fill = 0;
            self.block();
        }
        y
    }

    fn block(&mut self) {
        let b = self.b;
        let h = b + 1;
        self.re.copy_from_slice(&self.win_l);
        self.im.copy_from_slice(&self.win_r);
        self.fft.run(&mut self.re, &mut self.im, false);
        self.head = (self.head + self.parts - 1) % self.parts;
        let o = self.head * h;
        split_two_real(
            &self.re,
            &self.im,
            &mut self.xl_re[o..o + h],
            &mut self.xl_im[o..o + h],
            &mut self.xr_re[o..o + h],
            &mut self.xr_im[o..o + h],
        );
        for a in &mut self.acc {
            a.iter_mut().for_each(|v| *v = 0.0);
        }
        let [ylr, yli, yrr, yri] = &mut self.acc;
        for p in 0..self.parts {
            let xo = ((self.head + p) % self.parts) * h;
            let ho = p * h;
            let (xlr, xli) = (&self.xl_re[xo..xo + h], &self.xl_im[xo..xo + h]);
            let (xrr, xri) = (&self.xr_re[xo..xo + h], &self.xr_im[xo..xo + h]);
            let (hlr, hli) = (&self.hl_re[ho..ho + h], &self.hl_im[ho..ho + h]);
            let (hrr, hri) = (&self.hr_re[ho..ho + h], &self.hr_im[ho..ho + h]);
            for k in 0..h {
                ylr[k] += xlr[k] * hlr[k] - xli[k] * hli[k];
                yli[k] += xlr[k] * hli[k] + xli[k] * hlr[k];
                yrr[k] += xrr[k] * hrr[k] - xri[k] * hri[k];
                yri[k] += xrr[k] * hri[k] + xri[k] * hrr[k];
            }
        }
        join_two_real(ylr, yli, yrr, yri, &mut self.re, &mut self.im);
        self.fft.run(&mut self.re, &mut self.im, true);
        // overlap-save: 뒤쪽 B 개가 유효
        for i in 0..b {
            self.out_l[i] = super::flush(self.re[b + i]);
            self.out_r[i] = super::flush(self.im[b + i]);
        }
        self.win_l.copy_within(b.., 0);
        self.win_r.copy_within(b.., 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 직접 컨볼루션과 같은 결과 (B 샘플 늦게)
    #[test]
    fn matches_direct_convolution() {
        let b = 16;
        let ir_l: Vec<f32> = (0..50).map(|i| ((i * 13 % 7) as f32 - 3.0) * 0.1).collect();
        let ir_r: Vec<f32> = (0..37).map(|i| ((i * 5 % 9) as f32 - 4.0) * 0.05).collect();
        let x: Vec<f32> = (0..300)
            .map(|i| ((i * 31 % 17) as f32 - 8.0) * 0.1)
            .collect();
        let mut c = Convolver::new(b, &ir_l, &ir_r);
        let mut got_l = vec![];
        let mut got_r = vec![];
        for &v in &x {
            let (l, r) = c.tick(v, -v);
            got_l.push(l);
            got_r.push(r);
        }
        for n in 0..x.len() - b {
            let mut dl = 0.0;
            let mut dr = 0.0;
            for (k, h) in ir_l.iter().enumerate() {
                if n >= k {
                    dl += h * x[n - k];
                }
            }
            for (k, h) in ir_r.iter().enumerate() {
                if n >= k {
                    dr += h * -x[n - k];
                }
            }
            assert!(
                (got_l[n + b] - dl).abs() < 1e-3,
                "L {n}: {} vs {dl}",
                got_l[n + b]
            );
            assert!((got_r[n + b] - dr).abs() < 1e-3, "R {n}");
        }
    }
}

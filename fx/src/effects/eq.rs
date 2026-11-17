//! EQ — 채널 EQ(8밴드) · 리니어 페이즈 EQ · 빈티지 튜브 EQ · 틸트 EQ (1단계).

use super::{Effect, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind};
use crate::blocks::conv::Convolver;
use crate::blocks::db_to_gain;
use crate::blocks::delay::DelayLine;
use crate::blocks::fft::Fft;
use crate::blocks::oversample::{self, Oversampler};
use crate::blocks::smooth::Smooth;

// ---------------------------------------------------------------------------
// 밴드 구성 — 채널 EQ 와 리니어 페이즈 EQ 가 같은 손잡이를 쓴다 (Logic 도 그렇다)
// 파라미터: 0 로우컷 Hz(10 = 끔) · 1 로우컷 기울기(0 12dB/1 24dB) · 2 로우 셸프 Hz · 3 로우 셸프 dB ·
//           4~15 피크 넷 (Hz·dB·Q) · 16 하이 셸프 Hz · 17 하이 셸프 dB ·
//           18 하이컷 Hz(22000 = 끔) · 19 하이컷 기울기 · 20 출력 dB
// ---------------------------------------------------------------------------

pub const EQ_PARAMS: usize = 21;

/// 걸어야 할 바이쿼드 목록 (꺼진 밴드는 뺀다)
pub fn eq_sections(p: &Params, sr: f64) -> Vec<Coefs> {
    let mut out = Vec::with_capacity(12);
    let q = std::f64::consts::FRAC_1_SQRT_2;
    let hp = p[0].clamp(10.0, 4000.0) as f64;
    if hp > 10.5 {
        let n = if p[1] >= 0.5 { 2 } else { 1 };
        for _ in 0..n {
            out.push(Coefs::new(Kind::HighPass, hp, q, 0.0, sr));
        }
    }
    let ls = p[3].clamp(-24.0, 24.0) as f64;
    if ls.abs() > 0.01 {
        out.push(Coefs::new(
            Kind::LowShelf,
            p[2].clamp(20.0, 2000.0) as f64,
            q,
            ls,
            sr,
        ));
    }
    for b in 0..4 {
        let g = p[5 + 3 * b].clamp(-24.0, 24.0) as f64;
        if g.abs() > 0.01 {
            let f = p[4 + 3 * b].clamp(20.0, 20000.0) as f64;
            let bq = p[6 + 3 * b].clamp(0.1, 12.0) as f64;
            out.push(Coefs::new(Kind::Peak, f, bq, g, sr));
        }
    }
    let hs = p[17].clamp(-24.0, 24.0) as f64;
    if hs.abs() > 0.01 {
        out.push(Coefs::new(
            Kind::HighShelf,
            p[16].clamp(500.0, 20000.0) as f64,
            q,
            hs,
            sr,
        ));
    }
    let lp = p[18].clamp(500.0, 22000.0) as f64;
    if lp < 21500.0 {
        let n = if p[19] >= 0.5 { 2 } else { 1 };
        for _ in 0..n {
            out.push(Coefs::new(Kind::LowPass, lp, q, 0.0, sr));
        }
    }
    out
}

fn eq_key(p: &Params) -> [f32; EQ_PARAMS] {
    let mut k = [0.0; EQ_PARAMS];
    k.copy_from_slice(&p[..EQ_PARAMS]);
    k
}

pub struct ChannelEq {
    sr: f32,
    key: [f32; EQ_PARAMS],
    l: Vec<Biquad>,
    r: Vec<Biquad>,
    out: Smooth,
}

impl ChannelEq {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut e = Self {
            sr,
            key: [f32::NAN; EQ_PARAMS],
            l: vec![],
            r: vec![],
            out: Smooth::new(20.0, sr),
        };
        e.set_params(p);
        e
    }
}

impl Effect for ChannelEq {
    fn set_params(&mut self, p: &Params) {
        let key = eq_key(p);
        if key != self.key {
            let secs = eq_sections(p, self.sr as f64);
            // 밴드 수가 같으면 상태를 살린 채 계수만 바꾼다 — 오토메이션 중 딸깍 소리 방지
            if secs.len() == self.l.len() {
                for (i, c) in secs.iter().enumerate() {
                    self.l[i].set(*c);
                    self.r[i].set(*c);
                }
            } else {
                self.l = secs.iter().map(|c| Biquad::new(*c)).collect();
                self.r = self.l.clone();
            }
            self.key = key;
        }
        self.out.set(db_to_gain(p[20].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let mut a = l[i];
            let mut b = r[i];
            for (fl, fr) in self.l.iter_mut().zip(self.r.iter_mut()) {
                a = fl.tick(a);
                b = fr.tick(b);
            }
            let o = self.out.tick();
            l[i] = a * o;
            r[i] = b * o;
        }
    }
}

// ---------------------------------------------------------------------------
// 리니어 페이즈 EQ (Logic Linear Phase EQ) — 같은 손잡이의 **크기 응답만** 가져와
// 위상이 돌지 않는 FIR(4096)로 만든다. 마스터링에서 저역이 번지지 않게.
// 지연 = FIR 가운데(2048) + 컨볼루션 블록(1024) = 3072 샘플.
// 손잡이를 바꾸면 FIR 을 다시 만든다 — 그래서 TS 쪽은 오토메이션 대상에서 뺐다.
// ---------------------------------------------------------------------------

const LP_N: usize = 4096;
const LP_BLOCK: usize = 1024;
pub const LINEAR_PHASE_LATENCY: usize = LP_N / 2 + LP_BLOCK;

pub fn linear_phase_fir(p: &Params, sr: f64) -> Vec<f32> {
    let secs = eq_sections(p, sr);
    let fft = Fft::new(LP_N);
    let mut re = vec![0f32; LP_N];
    let mut im = vec![0f32; LP_N];
    for k in 0..=LP_N / 2 {
        let f = k as f64 * sr / LP_N as f64;
        let mut m = 1.0;
        for c in &secs {
            m *= c.magnitude(f.max(1.0), sr);
        }
        re[k] = m as f32;
        if k > 0 && k < LP_N / 2 {
            re[LP_N - k] = m as f32;
        }
    }
    fft.run(&mut re, &mut im, true);
    // 0 위상 → 가운데로 옮기고 블랙만 창
    let mut h = vec![0f32; LP_N];
    for (n, v) in h.iter_mut().enumerate() {
        let src = (n + LP_N / 2) % LP_N;
        let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / LP_N as f64).cos()
            + 0.08 * (4.0 * std::f64::consts::PI * n as f64 / LP_N as f64).cos();
        *v = re[src] * w as f32;
    }
    h
}

pub struct LinearPhaseEq {
    sr: f32,
    key: [f32; EQ_PARAMS],
    conv: Convolver,
    out: Smooth,
}

impl LinearPhaseEq {
    pub fn new(sr: f32, p: &Params) -> Self {
        let h = linear_phase_fir(p, sr as f64);
        let mut e = Self {
            sr,
            key: eq_key(p),
            conv: Convolver::new(LP_BLOCK, &h, &h),
            out: Smooth::new(20.0, sr),
        };
        e.set_params(p);
        e
    }
}

impl Effect for LinearPhaseEq {
    fn set_params(&mut self, p: &Params) {
        let key = eq_key(p);
        if key != self.key {
            self.key = key;
            let h = linear_phase_fir(p, self.sr as f64);
            self.conv = Convolver::new(LP_BLOCK, &h, &h);
        }
        self.out.set(db_to_gain(p[20].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let (a, b) = self.conv.tick(l[i], r[i]);
            let o = self.out.tick();
            l[i] = a * o;
            r[i] = b * o;
        }
    }

    fn latency(&self) -> usize {
        LINEAR_PHASE_LATENCY
    }
}

// ---------------------------------------------------------------------------
// 빈티지 튜브 EQ (Logic Vintage Tube EQ — 패시브 프로그램 EQ 형태).
// 같은 저역 주파수에서 올리기와 깎기를 **동시에** 걸 수 있다 — 올림은 셸프, 깎기는 그보다 살짝
// 위에서 좁게 걸려 "저역은 두껍고 웅웅거림은 덜한" 특유의 곡선이 나온다.
// 고역 올림은 폭 손잡이가 있는 피크, 고역 깎기는 셸프. 마지막에 튜브 포화(4배 오버샘플링).
// 파라미터: 0 저역 주파수(20/30/60/100) · 1 저역 올림 0..10 · 2 저역 깎기 0..10 ·
//           3 고역 올림 주파수(3k/4k/5k/8k/10k/12k/16k) · 4 고역 올림 0..10 · 5 고역 폭 0..1 ·
//           6 고역 깎기 주파수(5k/10k/20k) · 7 고역 깎기 0..10 · 8 드라이브 0..1 · 9 출력 dB
// ---------------------------------------------------------------------------

const LOW_FREQS: [f64; 4] = [20.0, 30.0, 60.0, 100.0];
const HIGH_BOOST_FREQS: [f64; 7] = [3000.0, 4000.0, 5000.0, 8000.0, 10000.0, 12000.0, 16000.0];
const HIGH_CUT_FREQS: [f64; 3] = [5000.0, 10000.0, 20000.0];

pub struct VintageEq {
    sr: f32,
    key: [f32; 8],
    l: Vec<Biquad>,
    r: Vec<Biquad>,
    drive: f32,
    os_l: Oversampler,
    os_r: Oversampler,
    out: Smooth,
}

impl VintageEq {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut e = Self {
            sr,
            key: [f32::NAN; 8],
            l: vec![],
            r: vec![],
            drive: 0.0,
            os_l: Oversampler::new(),
            os_r: Oversampler::new(),
            out: Smooth::new(20.0, sr),
        };
        e.set_params(p);
        e
    }

    fn sections(p: &Params, sr: f64) -> Vec<Coefs> {
        let pick = |v: f32, list: &[f64]| list[(v.round().max(0.0) as usize).min(list.len() - 1)];
        let lf = pick(p[0], &LOW_FREQS);
        let boost = p[1].clamp(0.0, 10.0) as f64 * 1.35; // 10 → 13.5dB
        let cut = p[2].clamp(0.0, 10.0) as f64 * 1.75; //  10 → 17.5dB
        let hf = pick(p[3], &HIGH_BOOST_FREQS);
        let hboost = p[4].clamp(0.0, 10.0) as f64 * 1.6;
        let bw = 0.4 + 2.6 * (1.0 - p[5].clamp(0.0, 1.0) as f64); // 폭이 넓을수록 Q 작게
        let cf = pick(p[6], &HIGH_CUT_FREQS);
        let hcut = p[7].clamp(0.0, 10.0) as f64 * 1.6;
        vec![
            Coefs::new(Kind::LowShelf, lf, 0.6, boost, sr),
            // 깎기는 올림 주파수의 약 2.5배에서 좁게 — 저역 아래는 두껍고 위의 웅웅거림은 덜하게
            Coefs::new(Kind::Peak, lf * 2.5, 1.1, -cut, sr),
            Coefs::new(Kind::Peak, hf, bw, hboost, sr),
            Coefs::new(Kind::HighShelf, cf.min(sr * 0.45), 0.7, -hcut, sr),
        ]
    }
}

impl Effect for VintageEq {
    fn set_params(&mut self, p: &Params) {
        let mut key = [0f32; 8];
        key.copy_from_slice(&p[..8]);
        if key != self.key {
            self.key = key;
            let secs = Self::sections(p, self.sr as f64);
            if self.l.len() == secs.len() {
                for (i, c) in secs.iter().enumerate() {
                    self.l[i].set(*c);
                    self.r[i].set(*c);
                }
            } else {
                self.l = secs.iter().map(|c| Biquad::new(*c)).collect();
                self.r = self.l.clone();
            }
        }
        self.drive = p[8].clamp(0.0, 1.0);
        self.out.set(db_to_gain(p[9].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let d = 1.0 + 6.0 * self.drive;
        // 튜브: 비대칭(짝수 배음) — 바이어스를 빼서 0 은 0 으로
        let bias = 0.15 * self.drive;
        let off = (bias * d).tanh();
        let norm = 1.0 / ((d * (1.0 + bias)).tanh() - off).max(1e-3);
        let drive = self.drive;
        let tube = move |s: f32| {
            if drive > 0.0 {
                (((s + bias) * d).tanh() - off) * norm
            } else {
                s
            }
        };
        for i in 0..l.len() {
            let mut a = l[i];
            let mut b = r[i];
            for (fl, fr) in self.l.iter_mut().zip(self.r.iter_mut()) {
                a = fl.tick(a);
                b = fr.tick(b);
            }
            let o = self.out.tick();
            l[i] = oversample::process(&mut self.os_l, a, tube) * o;
            r[i] = oversample::process(&mut self.os_r, b, tube) * o;
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 틸트 EQ — 중심 주파수를 축으로 아래와 위를 시소처럼 반대로 기울인다.
// 파라미터: 0 중심 Hz · 1 기울기 dB(+ 면 밝게) · 2 출력 dB
// ---------------------------------------------------------------------------

pub struct TiltEq {
    sr: f32,
    key: (f32, f32),
    l: [Biquad; 2],
    r: [Biquad; 2],
    out: Smooth,
}

impl TiltEq {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut e = Self {
            sr,
            key: (f32::NAN, 0.0),
            l: [Biquad::default(); 2],
            r: [Biquad::default(); 2],
            out: Smooth::new(20.0, sr),
        };
        e.set_params(p);
        e
    }
}

impl Effect for TiltEq {
    fn set_params(&mut self, p: &Params) {
        let key = (p[0].clamp(100.0, 8000.0), p[1].clamp(-12.0, 12.0));
        if key != self.key {
            self.key = key;
            let sr = self.sr as f64;
            let lo = Coefs::new(Kind::LowShelf, key.0 as f64, 0.5, -(key.1 as f64) / 2.0, sr);
            let hi = Coefs::new(Kind::HighShelf, key.0 as f64, 0.5, key.1 as f64 / 2.0, sr);
            for f in [&mut self.l, &mut self.r] {
                f[0].set(lo);
                f[1].set(hi);
            }
        }
        self.out.set(db_to_gain(p[2].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let o = self.out.tick();
            let a = self.l[0].tick(l[i]);
            l[i] = self.l[1].tick(a) * o;
            let b = self.r[0].tick(r[i]);
            r[i] = self.r[1].tick(b) * o;
        }
    }
}

/// 드라이를 지연에 맞춰 늦추는 작은 도우미 (다른 이펙트도 쓴다)
pub struct DryDelay {
    l: DelayLine,
    r: DelayLine,
    n: usize,
}

impl DryDelay {
    pub fn new(n: usize) -> Self {
        Self {
            l: DelayLine::new(n + 4),
            r: DelayLine::new(n + 4),
            n,
        }
    }
    #[inline]
    pub fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        self.l.push(l);
        self.r.push(r);
        (self.l.tap(self.n), self.r.tap(self.n))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::gain_to_db;
    use crate::effects::testing::*;

    fn flat() -> Params {
        let mut p = [0.0; 24];
        p[0] = 10.0;
        p[2] = 100.0;
        for b in 0..4 {
            p[4 + 3 * b] = [250.0, 800.0, 2500.0, 6000.0][b];
            p[6 + 3 * b] = 1.0;
        }
        p[16] = 8000.0;
        p[18] = 22000.0;
        p
    }

    fn gain_at(fx: &mut dyn Effect, p: &Params, f: f32, latency: usize) -> f32 {
        let sr = 48000.0;
        let x = sine(f, sr, 24000, 0.25);
        let (l, _) = run(fx, p, &x, &x);
        gain_to_db(rms(&l[12000 + latency..]) / rms(&x[12000..]))
    }

    #[test]
    fn channel_eq_peak_and_flat() {
        let sr = 48000.0;
        let mut p = flat();
        let mut e = ChannelEq::new(sr, &p);
        assert!(
            gain_at(&mut e, &p, 1000.0, 0).abs() < 0.05,
            "꺼진 EQ 는 평탄"
        );
        p[8] = 6.0; // 피크 2 (800Hz) +6
        let mut e = ChannelEq::new(sr, &p);
        assert!((gain_at(&mut e, &p, 800.0, 0) - 6.0).abs() < 0.3);
        p[0] = 200.0; // 로우컷
        p[1] = 1.0;
        let mut e = ChannelEq::new(sr, &p);
        assert!(gain_at(&mut e, &p, 50.0, 0) < -20.0);
    }

    #[test]
    fn linear_phase_matches_minimum_phase_magnitude() {
        let sr = 48000.0;
        let mut p = flat();
        p[5] = -6.0; // 250Hz −6
        p[17] = 4.0; // 하이 셸프 +4
        let mut a = ChannelEq::new(sr, &p);
        let mut b = LinearPhaseEq::new(sr, &p);
        for f in [100.0, 250.0, 1000.0, 12000.0] {
            let ga = gain_at(&mut a, &p, f, 0);
            let gb = gain_at(&mut b, &p, f, LINEAR_PHASE_LATENCY);
            assert!((ga - gb).abs() < 0.4, "{f}Hz 최소위상 {ga} 선형위상 {gb}");
        }
    }

    #[test]
    fn linear_phase_impulse_is_symmetric_and_delayed() {
        let sr = 48000.0;
        let mut p = flat();
        p[11] = 8.0;
        let mut e = LinearPhaseEq::new(sr, &p);
        let mut x = vec![0.0; 12000];
        x[0] = 1.0;
        let (l, _) = run(&mut e, &p, &x, &x);
        let at = l
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .unwrap()
            .0;
        assert_eq!(at, LINEAR_PHASE_LATENCY, "가장 큰 탭이 지연 자리");
        for k in 1..200 {
            assert!((l[at - k] - l[at + k]).abs() < 1e-4, "대칭 {k}");
        }
    }

    #[test]
    fn vintage_eq_boost_and_cut_shape() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 2.0; // 60Hz
        p[1] = 6.0;
        p[3] = 3.0;
        p[5] = 0.5;
        p[6] = 1.0;
        let mut e = VintageEq::new(sr, &p);
        let low = gain_at(&mut e, &p, 40.0, oversample::LATENCY);
        assert!(low > 5.0, "저역 올림 {low}");
        p[2] = 8.0; // 깎기를 같이
        let mut e = VintageEq::new(sr, &p);
        let mid = gain_at(&mut e, &p, 150.0, oversample::LATENCY);
        let low2 = gain_at(&mut e, &p, 30.0, oversample::LATENCY);
        assert!(
            low2 > mid + 3.0,
            "30Hz 는 두껍고 150Hz 는 덜하다: {low2} vs {mid}"
        );
    }

    #[test]
    fn tilt_is_symmetric() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 800.0;
        p[1] = 6.0;
        let mut e = TiltEq::new(sr, &p);
        let lo = gain_at(&mut e, &p, 40.0, 0);
        let hi = gain_at(&mut e, &p, 16000.0, 0);
        assert!(
            (lo + 3.0).abs() < 0.6 && (hi - 3.0).abs() < 0.6,
            "lo {lo} hi {hi}"
        );
    }
}

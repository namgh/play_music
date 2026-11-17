//! 스펙트럼 (5단계) — 스펙트럼 게이트 · 디노이저 · 매치 EQ(목표 곡선) · 프리즈.

use super::{Effect, Meters, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind};
use crate::blocks::delay::DelayLine;
use crate::blocks::rng::Rng;
use crate::blocks::smooth::Smooth;
use crate::blocks::stft::{self, Stft, BINS};
use crate::blocks::{db_to_gain, gain_to_db};

fn equal_power(mix: f32) -> (f32, f32) {
    let m = mix.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    (m.cos(), m.sin())
}

/// STFT 이펙트 공통 출구 — 드라이를 2048 늦춰 맞춘다
struct Latent {
    l: DelayLine,
    r: DelayLine,
    dry: Smooth,
    wet: Smooth,
}

impl Latent {
    fn new(sr: f32) -> Self {
        Self {
            l: DelayLine::new(stft::LATENCY + 8),
            r: DelayLine::new(stft::LATENCY + 8),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        }
    }
    fn set(&mut self, mix: f32) {
        let (d, w) = equal_power(mix);
        self.dry.set(d);
        self.wet.set(w);
    }
    #[inline(always)]
    fn mix(&mut self, xl: f32, xr: f32, wl: f32, wr: f32) -> (f32, f32) {
        self.l.push(xl);
        self.r.push(xr);
        let (d, w) = (self.dry.tick(), self.wet.tick());
        (
            self.l.tap(stft::LATENCY) * d + wl * w,
            self.r.tap(stft::LATENCY) * d + wr * w,
        )
    }
}

// ---------------------------------------------------------------------------
// 스펙트럼 게이트 (Logic Spectral Gate) — 빈마다 따로 여닫는 게이트. 정한 주파수 구간 안에서
// 스레숄드보다 작은 빈을 줄인다. 열고 닫는 속도는 프레임 단위 스무딩.
// 파라미터: 0 스레숄드 dB · 1 줄임 dB · 2 구간 아래 Hz · 3 구간 위 Hz · 4 속도(0 느림..1 빠름) · 5 섞기
// ---------------------------------------------------------------------------

pub struct SpectralGate {
    sr: f32,
    stft: Stft,
    gains: Vec<f32>,
    threshold: f32,
    floor: f32,
    lo: f32,
    hi: f32,
    speed: f32,
    out: Latent,
}

impl SpectralGate {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut g = Self {
            sr,
            stft: Stft::new(),
            gains: vec![1.0; BINS],
            threshold: -50.0,
            floor: 0.0,
            lo: 0.0,
            hi: 0.0,
            speed: 0.5,
            out: Latent::new(sr),
        };
        g.set_params(p);
        g
    }
}

impl Effect for SpectralGate {
    fn set_params(&mut self, p: &Params) {
        self.threshold = p[0].clamp(-100.0, 0.0);
        self.floor = db_to_gain(p[1].clamp(-100.0, 0.0));
        self.lo = p[2].clamp(20.0, 20000.0);
        self.hi = p[3].clamp(self.lo, 24000.0);
        self.speed = 0.1 + 0.85 * p[4].clamp(0.0, 1.0);
        self.out.set(p[5]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let (sr, th, floor, lo, hi, sp) = (
            self.sr,
            self.threshold,
            self.floor,
            self.lo,
            self.hi,
            self.speed,
        );
        let gains = &mut self.gains;
        // FFT 크기 → 사인 창 진폭 기준 dBFS 로 맞추는 배율
        let scale = 4.0 / stft::N as f32;
        let mut f = |s: stft::Spectrum| {
            for k in 0..BINS {
                let hz = stft::bin_hz(k, sr);
                let target = if hz < lo || hz > hi {
                    1.0
                } else {
                    let m = (s.lr[k] * s.lr[k] + s.li[k] * s.li[k])
                        .max(s.rr[k] * s.rr[k] + s.ri[k] * s.ri[k])
                        .sqrt()
                        * scale;
                    if gain_to_db(m) > th {
                        1.0
                    } else {
                        floor
                    }
                };
                gains[k] += (target - gains[k]) * sp;
                let g = gains[k];
                s.lr[k] *= g;
                s.li[k] *= g;
                s.rr[k] *= g;
                s.ri[k] *= g;
            }
        };
        for i in 0..l.len() {
            let (wl, wr) = self.stft.tick(l[i], r[i], &mut f);
            (l[i], r[i]) = self.out.mix(l[i], r[i], wl, wr);
        }
    }

    fn latency(&self) -> usize {
        stft::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 디노이저 — 빈마다 잡음 바닥을 **최솟값 추적**으로 배우고(조용한 순간의 크기), 그보다 크게 넘지 않는
// 빈을 줄인다(위너 필터 모양). 음악 소음("뾰록") 을 줄이려고 게인을 시간·주파수로 매끄럽게.
// 파라미터: 0 줄임 dB · 1 민감도 dB(바닥 위 얼마까지 잡음으로 보나) · 2 매끄러움 · 3 섞기
// 미터: 0 평균 잡음 바닥 dB
// ---------------------------------------------------------------------------

pub struct Denoiser {
    stft: Stft,
    smooth_pow: Vec<f32>,
    floor_pow: Vec<f32>,
    gains: Vec<f32>,
    reduce: f32,
    sens: f32,
    smooth: f32,
    frames: u32,
    floor_db: f32,
    out: Latent,
}

impl Denoiser {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut d = Self {
            stft: Stft::new(),
            smooth_pow: vec![0.0; BINS],
            floor_pow: vec![f32::MAX; BINS],
            gains: vec![1.0; BINS],
            reduce: 0.1,
            sens: 2.0,
            smooth: 0.5,
            frames: 0,
            floor_db: -120.0,
            out: Latent::new(sr),
        };
        d.set_params(p);
        d
    }
}

impl Effect for Denoiser {
    fn set_params(&mut self, p: &Params) {
        self.reduce = db_to_gain(p[0].clamp(-60.0, 0.0));
        self.sens = db_to_gain(p[1].clamp(0.0, 20.0)).powi(2);
        self.smooth = p[2].clamp(0.0, 0.95);
        self.out.set(p[3]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let (red, sens, sm) = (self.reduce, self.sens, self.smooth);
        let sp = &mut self.smooth_pow;
        let fl = &mut self.floor_pow;
        let gains = &mut self.gains;
        let frames = &mut self.frames;
        let floor_db = &mut self.floor_db;
        let mut f = |s: stft::Spectrum| {
            *frames += 1;
            let mut sum = 0f64;
            for k in 0..BINS {
                let pw =
                    s.lr[k] * s.lr[k] + s.li[k] * s.li[k] + s.rr[k] * s.rr[k] + s.ri[k] * s.ri[k];
                // 첫 프레임은 그대로 — 0 에서 차오르는 동안의 작은 값을 바닥으로 배우면 영영 못 올라온다
                sp[k] = if *frames <= 1 {
                    pw
                } else {
                    0.85 * sp[k] + 0.15 * pw
                };
                // 최솟값 추적: 내려갈 때는 바로, 올라갈 때는 아주 천천히(약 2초에 2배) — 잡음이 커져도 따라간다
                if *frames > 4 {
                    fl[k] = if sp[k] < fl[k] { sp[k] } else { fl[k] * 1.0035 };
                }
                sum += fl[k] as f64;
            }
            *floor_db = 10.0 * ((sum / BINS as f64).max(1e-24)).log10() as f32;
            for k in 0..BINS {
                // 처음 몇 프레임은 바닥을 모른다 — 건드리지 않는다
                let target = if *frames < 8 {
                    1.0
                } else {
                    // 최솟값은 평균보다 늘 낮다(잡음 세기는 프레임마다 출렁인다) — 평균으로 되돌리는 배율 3
                    let snr = sp[k] / (fl[k] * 3.0 * sens + 1e-20);
                    // 위너 모양: 신호가 바닥보다 충분히 크면 1, 비슷하면 줄임 한도까지
                    ((snr - 1.0) / snr).clamp(red, 1.0)
                };
                gains[k] = gains[k] * sm + target * (1.0 - sm);
            }
            // 주파수 방향으로도 조금 번지게 (외톨이 빈이 뾰록거리지 않게)
            let mut prev = gains[0];
            for k in 1..BINS - 1 {
                let cur = gains[k];
                gains[k] = 0.25 * prev + 0.5 * cur + 0.25 * gains[k + 1];
                prev = cur;
            }
            for k in 0..BINS {
                let g = gains[k];
                s.lr[k] *= g;
                s.li[k] *= g;
                s.rr[k] *= g;
                s.ri[k] *= g;
            }
        };
        for i in 0..l.len() {
            let (wl, wr) = self.stft.tick(l[i], r[i], &mut f);
            (l[i], r[i]) = self.out.mix(l[i], r[i], wl, wr);
        }
    }

    fn latency(&self) -> usize {
        stft::LATENCY
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.floor_db;
    }
}

// ---------------------------------------------------------------------------
// 매치 EQ (Logic Match EQ 의 "목표 곡선" 방식) — 들어오는 소리의 장기 평균 스펙트럼(옥타브 10대역)을
// 재서, 고른 목표 곡선과의 차이를 피크 EQ 10 개로 메운다. **배우기** 를 끄면 지금 보정을 그대로 둔다.
// 레퍼런스 곡의 스펙트럼을 직접 넣는 방식은 이 곡선 자리를 바꾸면 된다(화면에서 곡선 값을 넣는 일).
// 파라미터: 0 목표(핑크/팝 밝게/따뜻하게/힙합/록/어쿠스틱) · 1 양 0..1 · 2 배우기(0/1) · 3 최대 보정 dB · 4 출력 dB
// 미터: 0~9 대역별 지금 보정 dB
// ---------------------------------------------------------------------------

const BANDS: [f32; 10] = [
    31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// 목표 곡선 — 1kHz 기준 상대 dB (핑크 노이즈 = 옥타브마다 같은 에너지 = 0 평탄)
const TARGETS: [[f32; 10]; 6] = [
    [0.0; 10],
    [1.0, 2.0, 1.5, 0.0, -1.0, 0.0, 0.5, 1.5, 2.5, 2.0], // 팝 밝게
    [2.0, 3.0, 2.0, 1.0, 0.0, 0.0, -1.0, -2.0, -3.0, -4.0], // 따뜻하게
    [5.0, 5.0, 2.0, -0.5, -1.5, 0.0, 0.0, 0.5, 1.0, 0.0], // 힙합 (저역 무겁게)
    [1.0, 2.0, 1.0, 0.0, 0.0, 0.5, 1.5, 1.0, 0.0, -1.0], // 록 (중고역 앞으로)
    [-2.0, -1.0, 0.0, 0.5, 0.5, 0.0, 0.5, 1.0, 1.0, 0.0], // 어쿠스틱 (저역 가볍게)
];

pub struct MatchEq {
    sr: f32,
    meter: [Biquad; 10],
    energy: [f32; 10],
    coef: f32,
    eq_l: [Biquad; 10],
    eq_r: [Biquad; 10],
    correction: [f32; 10],
    applied: [f32; 10],
    target: usize,
    amount: f32,
    learn: bool,
    max: f32,
    out: Smooth,
    n: usize,
}

impl MatchEq {
    pub fn new(sr: f32, p: &Params) -> Self {
        let s = sr as f64;
        let mut m = Self {
            sr,
            meter: BANDS.map(|f| {
                Biquad::new(Coefs::new(
                    Kind::BandPass,
                    f.min(sr * 0.45) as f64,
                    1.41,
                    0.0,
                    s,
                ))
            }),
            energy: [1e-9; 10],
            coef: crate::blocks::time_coef(3000.0, sr),
            eq_l: [Biquad::new(Coefs::IDENTITY); 10],
            eq_r: [Biquad::new(Coefs::IDENTITY); 10],
            correction: [0.0; 10],
            applied: [f32::NAN; 10],
            target: 0,
            amount: 0.5,
            learn: true,
            max: 6.0,
            out: Smooth::new(20.0, sr),
            n: 0,
        };
        m.set_params(p);
        m
    }

    fn refresh(&mut self) {
        // 잰 에너지(dB) − 1kHz 대역 기준 → 핑크 기준 상대값
        let db: Vec<f32> = self
            .energy
            .iter()
            .map(|e| 10.0 * e.max(1e-20).log10())
            .collect();
        let reference = db[5];
        let target = TARGETS[self.target.min(TARGETS.len() - 1)];
        for b in 0..10 {
            let measured = db[b] - reference;
            self.correction[b] = ((target[b] - measured) * self.amount).clamp(-self.max, self.max);
        }
        let s = self.sr as f64;
        for b in 0..10 {
            if (self.correction[b] - self.applied[b]).abs() > 0.05 || self.applied[b].is_nan() {
                self.applied[b] = self.correction[b];
                let f = BANDS[b].min(self.sr * 0.45) as f64;
                let c = Coefs::new(Kind::Peak, f, 1.0, self.correction[b] as f64, s);
                self.eq_l[b].set(c);
                self.eq_r[b].set(c);
            }
        }
    }
}

impl Effect for MatchEq {
    fn set_params(&mut self, p: &Params) {
        self.target = p[0].clamp(0.0, 5.0).round() as usize;
        self.amount = p[1].clamp(0.0, 1.0);
        self.learn = p[2] >= 0.5;
        self.max = p[3].clamp(1.0, 12.0);
        self.out.set(db_to_gain(p[4].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            if self.learn {
                let x = 0.5 * (l[i] + r[i]);
                for b in 0..10 {
                    let y = self.meter[b].tick(x);
                    // 옥타브 대역 에너지 — 대역 폭이 옥타브마다 두 배라, 핑크 기준으로 맞추면 평탄
                    self.energy[b] = y * y + (self.energy[b] - y * y) * self.coef;
                }
            }
            self.n += 1;
            // 0.25초마다 보정을 다시 계산 (계수가 매 샘플 바뀌면 소리가 흔들린다)
            if self.n >= (self.sr * 0.25) as usize {
                self.n = 0;
                self.refresh();
            }
            let o = self.out.tick();
            let mut a = l[i];
            let mut b = r[i];
            for k in 0..10 {
                a = self.eq_l[k].tick(a);
                b = self.eq_r[k].tick(b);
            }
            l[i] = a * o;
            r[i] = b * o;
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[..10].copy_from_slice(&self.correction);
    }
}

// ---------------------------------------------------------------------------
// 프리즈 — 얼리는 순간의 스펙트럼 크기를 잡아 두고, 위상을 계속 돌려 끝없이 이어지는 소리로.
// 얼리기 손잡이를 켤 때마다 그 순간을 다시 잡는다(오토메이션으로 박자에 맞춰 얼릴 수 있다).
// 파라미터: 0 얼리기(0/1) · 1 번짐(크기를 이웃 빈과 섞기) · 2 섞기
// ---------------------------------------------------------------------------

pub struct Freeze {
    stft: Stft,
    mag_l: Vec<f32>,
    mag_r: Vec<f32>,
    phase: Vec<f32>,
    frozen: bool,
    want: bool,
    blur: f32,
    rng: Rng,
    out: Latent,
}

impl Freeze {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut f = Self {
            stft: Stft::new(),
            mag_l: vec![0.0; BINS],
            mag_r: vec![0.0; BINS],
            phase: vec![0.0; BINS],
            frozen: false,
            want: false,
            blur: 0.0,
            rng: Rng::new(0xf2ee),
            out: Latent::new(sr),
        };
        f.set_params(p);
        f
    }
}

impl Effect for Freeze {
    fn set_params(&mut self, p: &Params) {
        self.want = p[0] >= 0.5;
        self.blur = p[1].clamp(0.0, 1.0);
        self.out.set(p[2]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let want = self.want;
        let blur = self.blur;
        let (ml, mr, ph) = (&mut self.mag_l, &mut self.mag_r, &mut self.phase);
        let frozen = &mut self.frozen;
        let rng = &mut self.rng;
        let mut f = |s: stft::Spectrum| {
            if want && !*frozen {
                for k in 0..BINS {
                    ml[k] = (s.lr[k] * s.lr[k] + s.li[k] * s.li[k]).sqrt();
                    mr[k] = (s.rr[k] * s.rr[k] + s.ri[k] * s.ri[k]).sqrt();
                }
                if blur > 0.0 {
                    for m in [&mut *ml, &mut *mr] {
                        let copy = m.clone();
                        for k in 1..BINS - 1 {
                            m[k] =
                                copy[k] * (1.0 - blur) + 0.5 * blur * (copy[k - 1] + copy[k + 1]);
                        }
                    }
                }
                *frozen = true;
            } else if !want {
                *frozen = false;
            }
            if *frozen {
                for k in 0..BINS {
                    // 빈 중심 주파수만큼 홉마다 위상이 돈다 + 아주 약간의 무작위(줄무늬 방지)
                    ph[k] = (ph[k] + std::f32::consts::PI * 0.5 * k as f32 + 0.3 * rng.bipolar())
                        .rem_euclid(std::f32::consts::TAU);
                    let (sn, cs) = ph[k].sin_cos();
                    s.lr[k] = ml[k] * cs;
                    s.li[k] = ml[k] * sn;
                    s.rr[k] = mr[k] * cs;
                    s.ri[k] = mr[k] * sn;
                }
            }
        };
        for i in 0..l.len() {
            let (wl, wr) = self.stft.tick(l[i], r[i], &mut f);
            (l[i], r[i]) = self.out.mix(l[i], r[i], wl, wr);
        }
    }

    fn latency(&self) -> usize {
        stft::LATENCY
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    #[test]
    fn spectral_gate_removes_quiet_hiss_keeps_tone() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = -45.0;
        p[1] = -80.0;
        p[2] = 20.0;
        p[3] = 24000.0;
        p[4] = 0.8;
        p[5] = 1.0;
        // 작은 잡음만 있으면 거의 다 사라진다
        let mut g = SpectralGate::new(sr, &p);
        let mut rng = Rng::new(3);
        let hiss: Vec<f32> = (0..48000).map(|_| rng.bipolar() * 0.0005).collect();
        let (y, _) = run(&mut g, &p, &hiss, &hiss);
        assert!(rms(&y[24000..]) < rms(&hiss[24000..]) * 0.1);
        // 큰 음은 그대로 지난다 (게이트가 음을 깎지 않는다)
        let mut g = SpectralGate::new(sr, &p);
        let tone = sine(1000.0, sr, 48000, 0.3);
        let (t, _) = run(&mut g, &p, &tone, &tone);
        let ratio = rms(&t[24000..]) / rms(&tone[24000..]);
        assert!((ratio - 1.0).abs() < 0.05, "{ratio}");
    }

    #[test]
    fn denoiser_lowers_steady_noise() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = -30.0;
        p[1] = 6.0;
        p[2] = 0.5;
        p[3] = 1.0;
        let mut d = Denoiser::new(sr, &p);
        let mut rng = Rng::new(5);
        let x: Vec<f32> = (0..96000).map(|_| rng.bipolar() * 0.05).collect();
        let (y, _) = run(&mut d, &p, &x, &x);
        assert!(
            rms(&y[72000..]) < rms(&x[72000..]) * 0.3,
            "{} vs {}",
            rms(&y[72000..]),
            rms(&x[72000..])
        );
    }

    #[test]
    fn match_eq_moves_toward_target() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 0.0; // 평탄(핑크) 목표
        p[1] = 1.0;
        p[2] = 1.0;
        p[3] = 12.0;
        let mut m = MatchEq::new(sr, &p);
        // 저역이 엄청 큰 소리 → 저역을 깎는 보정
        let x: Vec<f32> = (0..96000)
            .map(|n| {
                0.5 * (std::f32::consts::TAU * 60.0 * n as f32 / sr).sin()
                    + 0.02 * (std::f32::consts::TAU * 1000.0 * n as f32 / sr).sin()
            })
            .collect();
        run(&mut m, &p, &x, &x);
        let mut meters = [0.0; 16];
        m.meters(&mut meters);
        assert!(meters[1] < -3.0, "63Hz 대역을 깎는다 {}", meters[1]);
    }

    #[test]
    fn freeze_sustains_after_input_stops() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 0.0;
        p[2] = 1.0;
        let mut f = Freeze::new(sr, &p);
        let x = sine(440.0, sr, 24000, 0.3);
        run(&mut f, &p, &x, &x);
        p[0] = 1.0;
        let (_, _) = run(&mut f, &p, &x[..4800], &x[..4800]);
        let silence = vec![0.0; 24000];
        let (y, _) = run(&mut f, &p, &silence, &silence);
        assert!(
            rms(&y[12000..]) > 0.02,
            "얼린 소리가 계속 {}",
            rms(&y[12000..])
        );
    }
}

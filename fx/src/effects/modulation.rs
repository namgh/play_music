//! 모듈레이션 — 앙상블 · 모듈레이션 딜레이 · 로터 · 오토팬 · 링 모듈레이터 · 주파수 시프터 ·
//! 비브라토 · 페이저(12단) (2단계).

use super::{Effect, Params};
use crate::blocks::crossover::Lr4;
use crate::blocks::delay::DelayLine;
use crate::blocks::lfo::{Hilbert, Lfo, Rotor, Shape};
use crate::blocks::oversample::{self, Oversampler};
use crate::blocks::rng::Rng;
use crate::blocks::smooth::Smooth;
use crate::blocks::{flush, time_coef};

fn equal_power(mix: f32) -> (f32, f32) {
    let m = mix.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    (m.cos(), m.sin())
}

// ---------------------------------------------------------------------------
// 앙상블 (Logic Ensemble) — 목소리 2~8 개, 각자 다른 위상의 LFO + 느린 무작위 표류.
// 좌우로 고르게 벌려 놓아 두껍고 넓다.
// 파라미터: 0 목소리 수 · 1 속도 Hz · 2 깊이 ms · 3 기본 지연 ms · 4 폭 · 5 섞기
// ---------------------------------------------------------------------------

const MAX_VOICES: usize = 8;

pub struct Ensemble {
    sr: f32,
    dl: DelayLine,
    dr: DelayLine,
    voices: usize,
    lfos: [Lfo; MAX_VOICES],
    drift: [f32; MAX_VOICES],
    rng: Rng,
    depth: Smooth,
    base: Smooth,
    width: f32,
    dry: Smooth,
    wet: Smooth,
}

impl Ensemble {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut e = Self {
            sr,
            dl: DelayLine::new((0.08 * sr) as usize),
            dr: DelayLine::new((0.08 * sr) as usize),
            voices: 4,
            lfos: std::array::from_fn(|k| Lfo::new(k as f32 / MAX_VOICES as f32)),
            drift: [0.0; MAX_VOICES],
            rng: Rng::new(0xe5e),
            depth: Smooth::new(30.0, sr),
            base: Smooth::new(30.0, sr),
            width: 1.0,
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        e.set_params(p);
        e
    }
}

impl Effect for Ensemble {
    fn set_params(&mut self, p: &Params) {
        self.voices = (p[0].clamp(2.0, 8.0).round() as usize).clamp(2, MAX_VOICES);
        let rate = p[1].clamp(0.02, 8.0);
        for (k, lfo) in self.lfos.iter_mut().enumerate() {
            // 목소리마다 속도를 조금씩 달리 — 같으면 한 덩어리로 움직여 얇게 들린다
            lfo.set_rate(rate * (1.0 + 0.11 * k as f32), self.sr);
        }
        self.depth.set(p[2].clamp(0.0, 15.0) * 0.001 * self.sr);
        self.base.set(p[3].clamp(3.0, 40.0) * 0.001 * self.sr);
        self.width = p[4].clamp(0.0, 1.0);
        let (d, w) = equal_power(p[5]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = self.voices;
        let norm = 1.0 / (n as f32).sqrt();
        for i in 0..l.len() {
            self.dl.push(l[i]);
            self.dr.push(r[i]);
            let (depth, base) = (self.depth.tick(), self.base.tick());
            let mut ol = 0.0;
            let mut or = 0.0;
            for k in 0..n {
                self.drift[k] = self.drift[k] * 0.9999 + self.rng.bipolar() * 0.0004;
                let m = self.lfos[k].tick(Shape::Sine) * 0.8 + self.drift[k] * 10.0;
                let d = base + depth * (0.5 + 0.5 * m.clamp(-1.0, 1.0));
                // 목소리 k 의 자리: −1 … 1 고르게
                let pos = if n > 1 {
                    -1.0 + 2.0 * k as f32 / (n - 1) as f32
                } else {
                    0.0
                } * self.width;
                let s = 0.5 * (self.dl.read(d) + self.dr.read(d));
                let a = (pos + 1.0) * std::f32::consts::FRAC_PI_4;
                ol += s * a.cos();
                or += s * a.sin();
            }
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * dg + ol * norm * wg * std::f32::consts::SQRT_2;
            r[i] = r[i] * dg + or * norm * wg * std::f32::consts::SQRT_2;
        }
    }
}

// ---------------------------------------------------------------------------
// 모듈레이션 딜레이 (Logic Modulation Delay) — 코러스·플랜저를 다 만드는 일반형.
// 파라미터: 0 지연 ms · 1 깊이 ms · 2 속도 Hz · 3 되먹임(−0.95..0.95) · 4 LFO 모양 ·
//           5 좌우 위상 차 ° · 6 섞기
// ---------------------------------------------------------------------------

pub struct ModDelay {
    sr: f32,
    dl: DelayLine,
    dr: DelayLine,
    delay: Smooth,
    depth: Smooth,
    fb: Smooth,
    shape: Shape,
    lfo_l: Lfo,
    lfo_r: Lfo,
    offset: f32,
    dry: Smooth,
    wet: Smooth,
    yl: f32,
    yr: f32,
}

impl ModDelay {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut m = Self {
            sr,
            dl: DelayLine::new((0.12 * sr) as usize),
            dr: DelayLine::new((0.12 * sr) as usize),
            delay: Smooth::new(30.0, sr),
            depth: Smooth::new(30.0, sr),
            fb: Smooth::new(20.0, sr),
            shape: Shape::Sine,
            lfo_l: Lfo::new(0.0),
            lfo_r: Lfo::new(0.25),
            offset: 0.25,
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            yl: 0.0,
            yr: 0.0,
        };
        m.set_params(p);
        m
    }
}

impl Effect for ModDelay {
    fn set_params(&mut self, p: &Params) {
        self.delay.set(p[0].clamp(0.2, 50.0) * 0.001 * self.sr);
        self.depth.set(p[1].clamp(0.0, 20.0) * 0.001 * self.sr);
        let rate = p[2].clamp(0.01, 20.0);
        self.lfo_l.set_rate(rate, self.sr);
        self.lfo_r.set_rate(rate, self.sr);
        self.fb.set(p[3].clamp(-0.95, 0.95));
        self.shape = Shape::from_index(p[4].clamp(0.0, 1.0));
        let off = p[5].clamp(0.0, 180.0) / 360.0;
        if (off - self.offset).abs() > 1e-4 {
            self.lfo_r.phase = (self.lfo_l.phase + off).rem_euclid(1.0);
            self.offset = off;
        }
        let (d, w) = equal_power(p[6]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let (base, depth, fb) = (self.delay.tick(), self.depth.tick(), self.fb.tick());
            self.dl.push(l[i] + self.yl * fb);
            self.dr.push(r[i] + self.yr * fb);
            let ml = self.lfo_l.tick(self.shape);
            let mr = self.lfo_r.tick(self.shape);
            self.yl = flush(self.dl.read(base + depth * 0.5 * (1.0 + ml)));
            self.yr = flush(self.dr.read(base + depth * 0.5 * (1.0 + mr)));
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * dg + self.yl * wg;
            r[i] = r[i] * dg + self.yr * wg;
        }
    }
}

// ---------------------------------------------------------------------------
// 로터 (Logic Rotor Cabinet — 레슬리 스피커). 800Hz 로 나눠 혼(고역)과 드럼(저역)이 따로 돈다.
// 도는 스피커 = 도플러(지연 흔들림) + 크기 흔들림 + 좌우 이동. 속도를 바꾸면 **관성**으로 천천히 따라간다
// (혼은 가벼워 빨리, 드럼은 무거워 늦게) — 이게 레슬리 소리의 핵심이다.
// 입력은 모노로 합친다 — 진짜 레슬리도 앰프 하나로 들어간다.
// 파라미터: 0 속도(느림/빠름/정지) · 1 혼·드럼 균형(−1..1) · 2 마이크 거리(0 가까이..1 멀리) · 3 가속 배율
// ---------------------------------------------------------------------------

pub struct RotorCab {
    sr: f32,
    split: Lr4,
    horn_d: DelayLine,
    drum_d: DelayLine,
    horn_rate: f32,
    drum_rate: f32,
    horn_target: f32,
    drum_target: f32,
    horn_phase: f32,
    drum_phase: f32,
    accel: f32,
    balance: Smooth,
    dist: Smooth,
}

const HORN: (f32, f32) = (0.83, 6.7); // (느림, 빠름) Hz
const DRUM: (f32, f32) = (0.67, 5.8);

impl RotorCab {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut r = Self {
            sr,
            split: Lr4::new(800.0, sr as f64),
            horn_d: DelayLine::new((0.01 * sr) as usize),
            drum_d: DelayLine::new((0.01 * sr) as usize),
            horn_rate: 0.0,
            drum_rate: 0.0,
            horn_target: 0.0,
            drum_target: 0.0,
            horn_phase: 0.0,
            drum_phase: 0.3,
            accel: 1.0,
            balance: Smooth::new(20.0, sr),
            dist: Smooth::new(20.0, sr),
        };
        r.set_params(p);
        r.horn_rate = r.horn_target;
        r.drum_rate = r.drum_target;
        r
    }
}

impl Effect for RotorCab {
    fn set_params(&mut self, p: &Params) {
        let speed = p[0].clamp(0.0, 2.0).round() as u32;
        (self.horn_target, self.drum_target) = match speed {
            0 => (HORN.0, DRUM.0),
            1 => (HORN.1, DRUM.1),
            _ => (0.0, 0.0),
        };
        self.balance.set(p[1].clamp(-1.0, 1.0));
        self.dist.set(p[2].clamp(0.0, 1.0));
        self.accel = p[3].clamp(0.25, 4.0);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        // 관성: 혼 0.8초, 드럼 4초 시간상수 (가속 배율로 나눈다)
        let hc = time_coef(800.0 / self.accel, self.sr);
        let dc = time_coef(4000.0 / self.accel, self.sr);
        let tau = std::f32::consts::TAU;
        for i in 0..l.len() {
            self.horn_rate = self.horn_target + (self.horn_rate - self.horn_target) * hc;
            self.drum_rate = self.drum_target + (self.drum_rate - self.drum_target) * dc;
            self.horn_phase = (self.horn_phase + self.horn_rate / self.sr).fract();
            self.drum_phase = (self.drum_phase + self.drum_rate / self.sr).fract();
            let (lo, hi) = self.split.split(0.5 * (l[i] + r[i]));
            let (bal, dist) = (self.balance.tick(), self.dist.tick());
            self.horn_d.push(hi);
            self.drum_d.push(lo);
            let (hs, hcn) = (tau * self.horn_phase).sin_cos();
            let (ds, dcn) = (tau * self.drum_phase).sin_cos();
            // 도플러: 혼은 반지름이 커서 지연 흔들림이 크다 (±0.35ms), 드럼은 작다
            let h = self.horn_d.read(1.0 + 0.0005 * self.sr * (1.0 + hs) * 0.7);
            let d = self.drum_d.read(1.0 + 0.0005 * self.sr * (1.0 + ds) * 0.25);
            // 크기 흔들림 — 가까울수록 크다 (마이크 거리)
            let am = 1.0 - 0.5 * dist;
            let ha = 1.0 - 0.35 * am * (1.0 - hcn) * 0.5;
            let da = 1.0 - 0.15 * am * (1.0 - dcn) * 0.5;
            let (hg, dg) = ((1.0 + bal).min(1.0), (1.0 - bal).min(1.0));
            // 좌우 — 혼과 드럼은 반대 방향으로 돈다
            let hp = 0.5 + 0.45 * am * hs;
            let dp = 0.5 - 0.3 * am * ds;
            l[i] = h * ha * hg * (1.0 - hp).sqrt() * 1.2 + d * da * dg * (1.0 - dp).sqrt() * 1.2;
            r[i] = h * ha * hg * hp.sqrt() * 1.2 + d * da * dg * dp.sqrt() * 1.2;
        }
    }
}

// ---------------------------------------------------------------------------
// 오토팬 — 파라미터: 0 속도 Hz · 1 깊이 · 2 모양 · 3 좌우 위상차(0 = 같이, 180 = 반대)
// ---------------------------------------------------------------------------

pub struct AutoPan {
    sr: f32,
    lfo: Lfo,
    depth: Smooth,
    shape: Shape,
}

impl AutoPan {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut a = Self {
            sr,
            lfo: Lfo::new(0.0),
            depth: Smooth::new(20.0, sr),
            shape: Shape::Sine,
        };
        a.set_params(p);
        a
    }
}

impl Effect for AutoPan {
    fn set_params(&mut self, p: &Params) {
        self.lfo.set_rate(p[0].clamp(0.02, 20.0), self.sr);
        self.depth.set(p[1].clamp(0.0, 1.0));
        self.shape = Shape::from_index(p[2].clamp(0.0, 2.0));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let m = self.lfo.tick(self.shape) * self.depth.tick();
            // 등가 파워 — 가운데에서 작아지지 않게
            let a = (m + 1.0) * std::f32::consts::FRAC_PI_4;
            let (gl, gr) = (
                a.cos() * std::f32::consts::SQRT_2,
                a.sin() * std::f32::consts::SQRT_2,
            );
            l[i] *= gl;
            r[i] *= gr;
        }
    }
}

// ---------------------------------------------------------------------------
// 링 모듈레이터 (Logic Ringshifter 의 링 모드) — 입력 × 사인. 곱셈은 합 주파수를 만들어
// 나이퀴스트를 넘길 수 있다 → 4배 오버샘플링 안에서 곱한다 (지연 16).
// 파라미터: 0 반송 Hz · 1 LFO 속도 · 2 LFO 깊이(옥타브) · 3 섞기
// ---------------------------------------------------------------------------

pub struct RingMod {
    sr: f32,
    freq: Smooth,
    lfo: Lfo,
    lfo_depth: f32,
    phase: f32,
    os_l: Oversampler,
    os_r: Oversampler,
    dry_l: DelayLine,
    dry_r: DelayLine,
    dry: Smooth,
    wet: Smooth,
}

impl RingMod {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut m = Self {
            sr,
            freq: Smooth::new(20.0, sr),
            lfo: Lfo::new(0.0),
            lfo_depth: 0.0,
            phase: 0.0,
            os_l: Oversampler::new(),
            os_r: Oversampler::new(),
            dry_l: DelayLine::new(64),
            dry_r: DelayLine::new(64),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        m.set_params(p);
        m
    }
}

impl Effect for RingMod {
    fn set_params(&mut self, p: &Params) {
        self.freq.set(p[0].clamp(1.0, 5000.0));
        self.lfo.set_rate(p[1].clamp(0.0, 20.0), self.sr);
        self.lfo_depth = p[2].clamp(0.0, 4.0);
        let (d, w) = equal_power(p[3]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let hi_sr = self.sr * 4.0;
        for i in 0..l.len() {
            let f = self.freq.tick() * 2f32.powf(self.lfo_depth * self.lfo.tick(Shape::Sine));
            let inc = f / hi_sr;
            let ul = self.os_l.up(l[i]);
            let ur = self.os_r.up(r[i]);
            let mut ml = [0f32; 4];
            let mut mr = [0f32; 4];
            for k in 0..4 {
                let c = (std::f32::consts::TAU * self.phase).sin();
                self.phase = (self.phase + inc).fract();
                ml[k] = ul[k] * c;
                mr[k] = ur[k] * c;
            }
            let wl = self.os_l.down(ml);
            let wr = self.os_r.down(mr);
            self.dry_l.push(l[i]);
            self.dry_r.push(r[i]);
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = self.dry_l.tap(oversample::LATENCY) * dg + wl * wg;
            r[i] = self.dry_r.tap(oversample::LATENCY) * dg + wr * wg;
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 주파수 시프터 (Logic Frequency Shifter) — 모든 주파수를 같은 Hz 만큼 민다(배음 관계가 깨져
// 금속성으로). 힐베르트로 단측파대를 만든다. 되먹임을 걸면 계단처럼 올라가는 "바버폴".
// 파라미터: 0 이동 Hz(−2000..2000) · 1 되먹임 · 2 섞기 · 3 좌우 반대 방향(0/1)
// ---------------------------------------------------------------------------

pub struct FreqShifter {
    sr: f32,
    hl: Hilbert,
    hr: Hilbert,
    osc: Rotor,
    shift: Smooth,
    fb: Smooth,
    dry: Smooth,
    wet: Smooth,
    mirror: bool,
    yl: f32,
    yr: f32,
    last_shift: f32,
}

impl FreqShifter {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut f = Self {
            sr,
            hl: Hilbert::new(),
            hr: Hilbert::new(),
            osc: Rotor::new(),
            shift: Smooth::new(30.0, sr),
            fb: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            mirror: false,
            yl: 0.0,
            yr: 0.0,
            last_shift: f32::NAN,
        };
        f.set_params(p);
        f
    }
}

impl Effect for FreqShifter {
    fn set_params(&mut self, p: &Params) {
        self.shift.set(p[0].clamp(-5000.0, 5000.0));
        self.fb.set(p[1].clamp(0.0, 0.9));
        let (d, w) = equal_power(p[2]);
        self.dry.set(d);
        self.wet.set(w);
        self.mirror = p[3] >= 0.5;
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let s = self.shift.tick();
            if s != self.last_shift {
                self.osc.set_freq(s.abs(), self.sr);
                self.last_shift = s;
            }
            let (c, sn) = self.osc.tick();
            let sn = if s < 0.0 { -sn } else { sn };
            let fb = self.fb.tick();
            let (il, ql) = self.hl.tick(l[i] + self.yl * fb);
            let (ir, qr) = self.hr.tick(r[i] + self.yr * fb);
            // 이 힐베르트 짝(Q 가 I 보다 90° 앞선다)에서는 위로: I·cos + Q·sin (시험이 방향을 확인한다)
            self.yl = flush(il * c + ql * sn);
            let sr_sign = if self.mirror { -sn } else { sn };
            self.yr = flush(ir * c + qr * sr_sign);
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * dg + self.yl * wg;
            r[i] = r[i] * dg + self.yr * wg;
        }
    }
}

// ---------------------------------------------------------------------------
// 비브라토 — 지연을 흔들어 음정을 떨게 한다. 깊이는 센트로 받는다
// (지연 흔들림 진폭 = 센트 → 음정비 − 1 을 LFO 각속도로 나눈 값).
// 파라미터: 0 속도 Hz · 1 깊이 센트 · 2 섞기
// ---------------------------------------------------------------------------

pub struct Vibrato {
    sr: f32,
    dl: DelayLine,
    dr: DelayLine,
    lfo: Lfo,
    amp: Smooth,
    dry: Smooth,
    wet: Smooth,
}

impl Vibrato {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut v = Self {
            sr,
            dl: DelayLine::new((0.05 * sr) as usize),
            dr: DelayLine::new((0.05 * sr) as usize),
            lfo: Lfo::new(0.0),
            amp: Smooth::new(30.0, sr),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        v.set_params(p);
        v
    }
}

impl Effect for Vibrato {
    fn set_params(&mut self, p: &Params) {
        let rate = p[0].clamp(0.1, 14.0);
        self.lfo.set_rate(rate, self.sr);
        let cents = p[1].clamp(0.0, 200.0);
        // 지연 d(t) = A·sin(ωt) → 음정비 1 − A·ω·cos → 최대 편차 A·ω = 2^(c/1200) − 1
        let ratio = 2f32.powf(cents / 1200.0) - 1.0;
        let a = ratio / (std::f32::consts::TAU * rate) * self.sr;
        self.amp.set(a.min(0.02 * self.sr));
        let (d, w) = equal_power(p[2]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            self.dl.push(l[i]);
            self.dr.push(r[i]);
            let a = self.amp.tick();
            let d = 2.0 + a * (1.0 + self.lfo.tick(Shape::Sine));
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * dg + self.dl.read(d) * wg;
            r[i] = r[i] * dg + self.dr.read(d) * wg;
        }
    }
}

// ---------------------------------------------------------------------------
// 페이저 (Logic Microphaser/Phaser 의 다단형) — 올패스 4·6·8·12 단을 LFO 로 쓴다.
// 파라미터: 0 단 수(4/6/8/12) · 1 속도 · 2 깊이(옥타브) · 3 중심 Hz · 4 되먹임 · 5 좌우 위상차 ° · 6 섞기
// ---------------------------------------------------------------------------

const MAX_STAGES: usize = 12;

#[derive(Clone, Copy, Default)]
struct Ap1st {
    z: f32,
}

impl Ap1st {
    #[inline(always)]
    fn tick(&mut self, x: f32, a: f32) -> f32 {
        let y = a * x + self.z;
        self.z = flush(x - a * y);
        y
    }
}

pub struct Phaser12 {
    sr: f32,
    stages: usize,
    al: [Ap1st; MAX_STAGES],
    ar: [Ap1st; MAX_STAGES],
    lfo_l: Lfo,
    lfo_r: Lfo,
    depth: Smooth,
    center: Smooth,
    fb: Smooth,
    dry: Smooth,
    wet: Smooth,
    yl: f32,
    yr: f32,
    offset: f32,
}

impl Phaser12 {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut f = Self {
            sr,
            stages: 8,
            al: [Ap1st::default(); MAX_STAGES],
            ar: [Ap1st::default(); MAX_STAGES],
            lfo_l: Lfo::new(0.0),
            lfo_r: Lfo::new(0.25),
            depth: Smooth::new(30.0, sr),
            center: Smooth::new(30.0, sr),
            fb: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            yl: 0.0,
            yr: 0.0,
            offset: 0.25,
        };
        f.set_params(p);
        f
    }
}

#[inline(always)]
fn ap_coef(freq: f32, sr: f32) -> f32 {
    let t = (std::f32::consts::PI * freq.clamp(20.0, sr * 0.45) / sr).tan();
    (t - 1.0) / (t + 1.0)
}

impl Effect for Phaser12 {
    fn set_params(&mut self, p: &Params) {
        self.stages = [4, 6, 8, 12][(p[0].clamp(0.0, 3.0).round() as usize).min(3)];
        let rate = p[1].clamp(0.01, 10.0);
        self.lfo_l.set_rate(rate, self.sr);
        self.lfo_r.set_rate(rate, self.sr);
        self.depth.set(p[2].clamp(0.0, 5.0));
        self.center.set(p[3].clamp(100.0, 8000.0).ln());
        self.fb.set(p[4].clamp(-0.9, 0.9));
        let off = p[5].clamp(0.0, 180.0) / 360.0;
        if (off - self.offset).abs() > 1e-4 {
            self.lfo_r.phase = (self.lfo_l.phase + off).rem_euclid(1.0);
            self.offset = off;
        }
        let (d, w) = equal_power(p[6]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = self.stages;
        for i in 0..l.len() {
            let (depth, center, fb) = (self.depth.tick(), self.center.tick().exp(), self.fb.tick());
            let fl = center * 2f32.powf(depth * 0.5 * self.lfo_l.tick(Shape::Triangle));
            let fr = center * 2f32.powf(depth * 0.5 * self.lfo_r.tick(Shape::Triangle));
            let (cl, cr) = (ap_coef(fl, self.sr), ap_coef(fr, self.sr));
            let mut xl = l[i] + self.yl * fb;
            let mut xr = r[i] + self.yr * fb;
            for k in 0..n {
                xl = self.al[k].tick(xl, cl);
                xr = self.ar[k].tick(xr, cr);
            }
            self.yl = xl;
            self.yr = xr;
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * dg + xl * wg;
            r[i] = r[i] * dg + xr * wg;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    /// 주파수 하나의 세기 (괴르첼)
    fn tone(y: &[f32], hz: f32, sr: f32) -> f32 {
        let (mut re, mut im) = (0f64, 0f64);
        for (i, v) in y.iter().enumerate() {
            let ph = std::f64::consts::TAU * hz as f64 * i as f64 / sr as f64;
            re += *v as f64 * ph.cos();
            im += *v as f64 * ph.sin();
        }
        ((re * re + im * im).sqrt() / y.len() as f64 * 2.0) as f32
    }

    #[test]
    fn freq_shifter_moves_tone() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 200.0;
        p[2] = 1.0;
        let mut f = FreqShifter::new(sr, &p);
        let x = sine(1000.0, sr, 48000, 0.5);
        let (l, _) = run(&mut f, &p, &x, &x);
        let tail = &l[24000..];
        assert!(
            tone(tail, 1200.0, sr) > 0.4,
            "1200Hz 로 갔다 {}",
            tone(tail, 1200.0, sr)
        );
        assert!(
            tone(tail, 800.0, sr) < 0.03,
            "반대쪽 측파대는 없다 {}",
            tone(tail, 800.0, sr)
        );
        assert!(tone(tail, 1000.0, sr) < 0.03);
    }

    #[test]
    fn ring_mod_makes_sum_and_difference() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 300.0;
        p[3] = 1.0;
        let mut m = RingMod::new(sr, &p);
        let x = sine(1000.0, sr, 48000, 0.5);
        let (l, _) = run(&mut m, &p, &x, &x);
        let tail = &l[24000..];
        assert!(tone(tail, 700.0, sr) > 0.2 && tone(tail, 1300.0, sr) > 0.2);
        assert!(tone(tail, 1000.0, sr) < 0.02);
    }

    #[test]
    fn vibrato_depth_in_cents() {
        // 깊이 50센트 → 순간 주파수가 1000·2^(±50/1200) 안에서 흔들린다 — 영점 교차로 잰다
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 5.0;
        p[1] = 50.0;
        p[2] = 1.0;
        let mut v = Vibrato::new(sr, &p);
        let x = sine(1000.0, sr, 96000, 0.5);
        let (l, _) = run(&mut v, &p, &x, &x);
        let mut last = None;
        let (mut lo, mut hi) = (f32::MAX, 0f32);
        for i in 48000..96000 {
            if l[i - 1] < 0.0 && l[i] >= 0.0 {
                let t = i as f32 - l[i] / (l[i] - l[i - 1]);
                if let Some(prev) = last {
                    let f = sr / (t - prev);
                    lo = lo.min(f);
                    hi = hi.max(f);
                }
                last = Some(t);
            }
        }
        let cents_hi = 1200.0 * (hi / 1000.0).log2();
        let cents_lo = 1200.0 * (lo / 1000.0).log2();
        assert!(
            (cents_hi - 50.0).abs() < 8.0 && (cents_lo + 50.0).abs() < 8.0,
            "{cents_lo} … {cents_hi}"
        );
    }

    #[test]
    fn autopan_keeps_power() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 2.0;
        p[1] = 1.0;
        let mut a = AutoPan::new(sr, &p);
        let x = vec![0.5; 48000];
        let (l, r) = run(&mut a, &p, &x, &x);
        for i in (0..48000).step_by(997) {
            let pw = l[i] * l[i] + r[i] * r[i];
            assert!((pw - 0.5).abs() < 0.02, "{i}: {pw}");
        }
        assert!(peak(&l) > 0.69 && l.iter().any(|v| *v < 0.05));
    }

    #[test]
    fn phaser_and_moddelay_and_ensemble_change_the_sound() {
        let sr = 48000.0;
        let noise: Vec<f32> = {
            let mut r = Rng::new(9);
            (0..48000).map(|_| r.bipolar() * 0.3).collect()
        };
        let mut p = [0.0; 24];
        p[0] = 3.0;
        p[1] = 0.5;
        p[2] = 3.0;
        p[3] = 800.0;
        p[4] = 0.5;
        p[6] = 0.5;
        let mut ph = Phaser12::new(sr, &p);
        let (y, _) = run(&mut ph, &p, &noise, &noise);
        let diff: f32 = y
            .iter()
            .zip(&noise)
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / noise.len() as f32;
        assert!(diff > 0.02);
        let mut p = [0.0; 24];
        p[0] = 4.0;
        p[1] = 0.8;
        p[2] = 4.0;
        p[3] = 12.0;
        p[4] = 1.0;
        p[5] = 0.5;
        let mut e = Ensemble::new(sr, &p);
        let (el, er) = run(&mut e, &p, &noise, &noise);
        let side: f32 =
            el.iter().zip(&er).map(|(a, b)| (a - b).abs()).sum::<f32>() / noise.len() as f32;
        assert!(side > 0.01, "앙상블은 좌우가 달라진다 {side}");
    }

    #[test]
    fn rotor_speeds_up_with_inertia() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 0.0;
        let mut r = RotorCab::new(sr, &p);
        assert!((r.horn_rate - HORN.0).abs() < 1e-3);
        p[0] = 1.0;
        let x = sine(2000.0, sr, 4800, 0.5);
        run(&mut r, &p, &x, &x);
        assert!(
            r.horn_rate > HORN.0 && r.horn_rate < HORN.1,
            "0.1초에는 아직 가속 중 {}",
            r.horn_rate
        );
        assert!(
            r.drum_rate - DRUM.0 < r.horn_rate - HORN.0,
            "드럼이 더 무겁다"
        );
    }
}

//! 피치 (5단계) — 피치 시프터 · 피치 보정 · 보컬 트랜스포머 · 하모나이저 · 옥타버 · 보코더.

use super::{Effect, Meters, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind, OnePole};
use crate::blocks::delay::DelayLine;
use crate::blocks::env::Follower;
use crate::blocks::pitch::PitchShifter;
use crate::blocks::rng::Rng;
use crate::blocks::smooth::Smooth;
use crate::blocks::stft::{self, Stft};
use crate::blocks::yin::Yin;
use crate::blocks::{db_to_gain, time_coef};

fn equal_power(mix: f32) -> (f32, f32) {
    let m = mix.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    (m.cos(), m.sin())
}

/// 창 길이(ms) — 0 드럼(짧게) · 1 말소리 · 2 노래 · 3 패드(길게)
const WINDOWS: [f32; 4] = [18.0, 30.0, 45.0, 80.0];

// ---------------------------------------------------------------------------
// 피치 시프터 (Logic Pitch Shifter) — 파라미터: 0 반음 · 1 센트 · 2 창(드럼/말/노래/패드) · 3 섞기
// ---------------------------------------------------------------------------

pub struct PitchShift {
    sr: f32,
    ps: [PitchShifter; 2],
    dry: Smooth,
    wet: Smooth,
}

impl PitchShift {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut s = Self {
            sr,
            ps: [PitchShifter::new(sr, 100.0), PitchShifter::new(sr, 100.0)],
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        s.set_params(p);
        s
    }
}

impl Effect for PitchShift {
    fn set_params(&mut self, p: &Params) {
        let semis = p[0].clamp(-24.0, 24.0) + p[1].clamp(-100.0, 100.0) / 100.0;
        let w = WINDOWS[(p[2].clamp(0.0, 3.0).round() as usize).min(3)];
        for ps in &mut self.ps {
            ps.set_semitones(semis);
            ps.set_window(w, self.sr);
        }
        let (d, wv) = equal_power(p[3]);
        self.dry.set(d);
        self.wet.set(wv);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let (d, w) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * d + self.ps[0].tick(l[i]) * w;
            r[i] = r[i] * d + self.ps[1].tick(r[i]) * w;
        }
    }
}

// ---------------------------------------------------------------------------
// 피치 보정 (Logic Pitch Correction) — 음정을 재서 가장 가까운 음계 음으로 당긴다.
// 응답이 빠르면 "기계 같은" 효과, 느리면 자연스럽게. 비브라토는 응답 시간보다 빠르면 살아남는다.
// 파라미터: 0 으뜸음(C=0..B=11) · 1 음계(반음계/장/단/펜타/블루스) · 2 응답 ms · 3 보정 양 0..1 ·
//           4 기준 A Hz · 5 섞기
// 미터: 0 감지 Hz · 1 목표 Hz · 2 벗어남 센트
// ---------------------------------------------------------------------------

const SCALES: [&[u8]; 5] = [
    &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    &[0, 2, 4, 5, 7, 9, 11],
    &[0, 2, 3, 5, 7, 8, 10],
    &[0, 2, 4, 7, 9],
    &[0, 3, 5, 6, 7, 10],
];

/// 감지한 주파수 → 음계 안에서 가장 가까운 음의 주파수
pub fn nearest_in_scale(hz: f32, root: u32, scale: usize, a4: f32) -> f32 {
    let midi = 69.0 + 12.0 * (hz / a4).log2();
    let notes = SCALES[scale.min(SCALES.len() - 1)];
    let mut best = midi.round();
    let mut best_d = f32::MAX;
    let base = (midi.floor() as i32) - 12;
    for n in base..base + 25 {
        let pc = (n - root as i32).rem_euclid(12) as u8;
        if notes.contains(&pc) {
            let d = (n as f32 - midi).abs();
            if d < best_d {
                best_d = d;
                best = n as f32;
            }
        }
    }
    a4 * 2f32.powf((best - 69.0) / 12.0)
}

pub struct PitchCorrection {
    sr: f32,
    yin: Yin,
    ps: [PitchShifter; 2],
    root: u32,
    scale: usize,
    a4: f32,
    amount: f32,
    resp: f32,
    ratio: f32,
    target_ratio: f32,
    detected: f32,
    target: f32,
    dry: Smooth,
    wet: Smooth,
}

impl PitchCorrection {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut c = Self {
            sr,
            yin: Yin::new(sr),
            ps: [PitchShifter::new(sr, 100.0), PitchShifter::new(sr, 100.0)],
            root: 0,
            scale: 0,
            a4: 440.0,
            amount: 1.0,
            resp: 0.0,
            ratio: 1.0,
            target_ratio: 1.0,
            detected: 0.0,
            target: 0.0,
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        c.set_params(p);
        c
    }
}

impl Effect for PitchCorrection {
    fn set_params(&mut self, p: &Params) {
        self.root = p[0].clamp(0.0, 11.0).round() as u32;
        self.scale = p[1].clamp(0.0, 4.0).round() as usize;
        self.resp = time_coef(p[2].clamp(0.0, 400.0), self.sr);
        self.amount = p[3].clamp(0.0, 1.0);
        self.a4 = p[4].clamp(400.0, 480.0);
        let (d, w) = equal_power(p[5]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            if self.yin.tick(0.5 * (l[i] + r[i])) {
                if self.yin.hz > 50.0 && self.yin.clarity > 0.6 {
                    self.detected = self.yin.hz;
                    self.target = nearest_in_scale(self.detected, self.root, self.scale, self.a4);
                    // 보정 양만큼만 당긴다 (로그 공간)
                    self.target_ratio = (self.target / self.detected).powf(self.amount);
                    // 창은 감지 주기의 두 배쯤 — 짧을수록 알갱이 소리가 덜하다
                    let w = (2.5 * 1000.0 / self.detected).clamp(12.0, 40.0);
                    for ps in &mut self.ps {
                        ps.set_window(w, self.sr);
                    }
                } else {
                    self.target_ratio = 1.0;
                }
            }
            self.ratio = self.target_ratio + (self.ratio - self.target_ratio) * self.resp;
            for ps in &mut self.ps {
                ps.set_ratio(self.ratio);
            }
            let (d, w) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * d + self.ps[0].tick(l[i]) * w;
            r[i] = r[i] * d + self.ps[1].tick(r[i]) * w;
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.detected;
        out[1] = self.target;
        out[2] = if self.detected > 0.0 && self.target > 0.0 {
            1200.0 * (self.detected / self.target).log2()
        } else {
            0.0
        };
    }
}

// ---------------------------------------------------------------------------
// 보컬 트랜스포머 (Logic Vocal Transformer) — 음정과 포먼트(목소리 크기·성별 느낌)를 따로.
// 1) 시간 영역 피치 시프터로 음정을 옮긴다(포먼트도 같이 움직인다)
// 2) STFT 에서 스펙트럼 포락선을 재고, 원하는 포먼트 자리로 다시 칠한다
//    원하는 포락선 E_d(f) = E_y(f · 음정비 / 포먼트비)
// 지연: STFT 2048.
// 파라미터: 0 음정 반음 · 1 포먼트 반음 · 2 섞기
// ---------------------------------------------------------------------------

pub struct VocalTransformer {
    ps: [PitchShifter; 2],
    stft: Stft,
    pitch_ratio: f32,
    formant_ratio: f32,
    env: Vec<f32>,
    mag: Vec<f32>,
    dry_l: DelayLine,
    dry_r: DelayLine,
    dry: Smooth,
    wet: Smooth,
}

impl VocalTransformer {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut v = Self {
            ps: [PitchShifter::new(sr, 40.0), PitchShifter::new(sr, 40.0)],
            stft: Stft::new(),
            pitch_ratio: 1.0,
            formant_ratio: 1.0,
            env: vec![0.0; stft::BINS],
            mag: vec![0.0; stft::BINS],
            dry_l: DelayLine::new(stft::LATENCY + 8),
            dry_r: DelayLine::new(stft::LATENCY + 8),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        v.set_params(p);
        v
    }
}

/// 크기 스펙트럼의 포락선 — 1/6 옥타브 이동 평균 (배음 사이 골을 메운다)
fn envelope(mag: &[f32], out: &mut [f32]) {
    let n = mag.len();
    for k in 0..n {
        let half = ((k as f32) * 0.06).max(2.0) as usize;
        let (a, b) = (k.saturating_sub(half), (k + half).min(n - 1));
        let mut s = 0.0;
        for v in &mag[a..=b] {
            s += v;
        }
        out[k] = s / (b - a + 1) as f32 + 1e-9;
    }
}

/// 분수 빈 위치에서 포락선 값 (직선 보간)
#[inline]
fn env_at(env: &[f32], pos: f32) -> f32 {
    let p = pos.clamp(0.0, (env.len() - 1) as f32);
    let i = p as usize;
    let f = p - i as f32;
    let j = (i + 1).min(env.len() - 1);
    env[i] * (1.0 - f) + env[j] * f
}

impl Effect for VocalTransformer {
    fn set_params(&mut self, p: &Params) {
        let semis = p[0].clamp(-24.0, 24.0);
        self.pitch_ratio = 2f32.powf(semis / 12.0);
        for ps in &mut self.ps {
            ps.set_semitones(semis);
        }
        self.formant_ratio = 2f32.powf(p[1].clamp(-12.0, 12.0) / 12.0);
        let (d, w) = equal_power(p[2]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let shift = self.pitch_ratio / self.formant_ratio;
        // 오디오 스레드에서 할당하지 않게 버퍼는 미리 들고 있는다
        let env = &mut self.env;
        let mag = &mut self.mag;
        let mut fix = |s: stft::Spectrum| {
            for (re, im) in [(&mut *s.lr, &mut *s.li), (&mut *s.rr, &mut *s.ri)] {
                for k in 0..stft::BINS {
                    mag[k] = (re[k] * re[k] + im[k] * im[k]).sqrt();
                }
                envelope(mag, env);
                for k in 0..stft::BINS {
                    let want = env_at(env, k as f32 * shift);
                    let g = (want / env[k]).clamp(0.0, 16.0);
                    re[k] *= g;
                    im[k] *= g;
                }
            }
        };
        for i in 0..l.len() {
            let yl = self.ps[0].tick(l[i]);
            let yr = self.ps[1].tick(r[i]);
            let (wl, wr) = self.stft.tick(yl, yr, &mut fix);
            self.dry_l.push(l[i]);
            self.dry_r.push(r[i]);
            let (d, w) = (self.dry.tick(), self.wet.tick());
            l[i] = self.dry_l.tap(stft::LATENCY) * d + wl * w;
            r[i] = self.dry_r.tap(stft::LATENCY) * d + wr * w;
        }
    }

    fn latency(&self) -> usize {
        stft::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 하모나이저 — 목소리 둘을 정한 음정만큼 올리거나 내려 좌우에 둔다.
// 파라미터: 0 목소리1 반음 · 1 목소리1 크기 · 2 목소리1 좌우 · 3 목소리2 반음 · 4 크기 · 5 좌우 ·
//           6 원음 크기 · 7 창
// ---------------------------------------------------------------------------

pub struct Harmonizer {
    sr: f32,
    ps: [PitchShifter; 2],
    gains: [(Smooth, Smooth); 2],
    dry: Smooth,
}

impl Harmonizer {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut h = Self {
            sr,
            ps: [PitchShifter::new(sr, 100.0), PitchShifter::new(sr, 100.0)],
            gains: [(Smooth::new(20.0, sr), Smooth::new(20.0, sr)); 2],
            dry: Smooth::new(20.0, sr),
        };
        h.set_params(p);
        h
    }
}

impl Effect for Harmonizer {
    fn set_params(&mut self, p: &Params) {
        let w = WINDOWS[(p[7].clamp(0.0, 3.0).round() as usize).min(3)];
        for v in 0..2 {
            self.ps[v].set_semitones(p[3 * v].clamp(-24.0, 24.0));
            self.ps[v].set_window(w * (1.0 + 0.13 * v as f32), self.sr);
            let lvl = p[3 * v + 1].clamp(0.0, 1.0);
            let pan = (p[3 * v + 2].clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
            self.gains[v].0.set(lvl * pan.cos());
            self.gains[v].1.set(lvl * pan.sin());
        }
        self.dry.set(p[6].clamp(0.0, 1.0));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let x = 0.5 * (l[i] + r[i]);
            let d = self.dry.tick();
            let mut ol = l[i] * d;
            let mut or = r[i] * d;
            for v in 0..2 {
                let y = self.ps[v].tick(x);
                ol += y * self.gains[v].0.tick();
                or += y * self.gains[v].1.tick();
            }
            l[i] = ol;
            r[i] = or;
        }
    }
}

// ---------------------------------------------------------------------------
// 옥타버 — 한 옥타브 아래 · 두 옥타브 아래 · 한 옥타브 위를 섞는다.
// 파라미터: 0 −1 옥타브 · 1 −2 옥타브 · 2 +1 옥타브 · 3 원음 · 4 아래 소리 로우패스 Hz
// ---------------------------------------------------------------------------

pub struct Octaver {
    sr: f32,
    down1: PitchShifter,
    down2: PitchShifter,
    up1: PitchShifter,
    g: [Smooth; 4],
    lp: [OnePole; 2],
}

impl Octaver {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut d1 = PitchShifter::new(sr, 60.0);
        d1.set_semitones(-12.0);
        let mut d2 = PitchShifter::new(sr, 80.0);
        d2.set_semitones(-24.0);
        let mut u1 = PitchShifter::new(sr, 30.0);
        u1.set_semitones(12.0);
        let mut o = Self {
            sr,
            down1: d1,
            down2: d2,
            up1: u1,
            g: [Smooth::new(20.0, sr); 4],
            lp: [OnePole::default(); 2],
        };
        o.set_params(p);
        o
    }
}

impl Effect for Octaver {
    fn set_params(&mut self, p: &Params) {
        for k in 0..4 {
            self.g[k].set(p[k].clamp(0.0, 1.5));
        }
        for f in &mut self.lp {
            f.set_freq(p[4].clamp(100.0, 4000.0), self.sr);
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let x = 0.5 * (l[i] + r[i]);
            let d1 = self.lp[0].lp(self.down1.tick(x)) * self.g[0].tick();
            let d2 = self.lp[1].lp(self.down2.tick(x)) * self.g[1].tick();
            let u1 = self.up1.tick(x) * self.g[2].tick();
            let d = self.g[3].tick();
            let s = d1 + d2 + u1;
            l[i] = l[i] * d + s;
            r[i] = r[i] * d + s;
        }
    }
}

// ---------------------------------------------------------------------------
// 보코더 (Logic EVOC 20 의 내장 신스 방식) — 들어온 소리(말)의 대역별 크기로 **내장 캐리어**(톱니 화음+노이즈)의
// 같은 대역을 여닫는다. 사이드체인이 없어도 쓸 수 있게 캐리어를 이펙트 안에 둔다.
// 캐리어 톱니는 PolyBLEP 으로 대역 제한 — 그냥 톱니는 고역이 접힌다.
// 파라미터: 0 캐리어 음(MIDI) · 1 화음(단음/5도/장/단) · 2 노이즈 섞기 · 3 대역 수(8..20) · 4 Q ·
//           5 어택 ms · 6 릴리즈 ms · 7 포먼트 이동(반음) · 8 치찰음 통과 · 9 섞기
// ---------------------------------------------------------------------------

const MAX_BANDS: usize = 20;
const CHORDS: [&[f32]; 4] = [&[0.0], &[0.0, 7.0], &[0.0, 4.0, 7.0], &[0.0, 3.0, 7.0]];

#[inline(always)]
fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

pub struct Vocoder {
    sr: f32,
    bands: usize,
    an: [Biquad; MAX_BANDS],
    syn_l: [Biquad; MAX_BANDS],
    syn_r: [Biquad; MAX_BANDS],
    env: [Follower; MAX_BANDS],
    phases: [f32; 3],
    incs: [f32; 3],
    voices: usize,
    noise: f32,
    rng: Rng,
    sib_hp: Biquad,
    sib: f32,
    key: [i32; 5],
    dry: Smooth,
    wet: Smooth,
}

impl Vocoder {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut v = Self {
            sr,
            bands: 16,
            an: [Biquad::default(); MAX_BANDS],
            syn_l: [Biquad::default(); MAX_BANDS],
            syn_r: [Biquad::default(); MAX_BANDS],
            env: [Follower::new(sr); MAX_BANDS],
            phases: [0.0, 0.33, 0.66],
            incs: [0.0; 3],
            voices: 1,
            noise: 0.1,
            rng: Rng::new(0x70c),
            sib_hp: Biquad::new(Coefs::new(Kind::HighPass, 5000.0, 0.7, 0.0, sr as f64)),
            sib: 0.0,
            key: [i32::MIN; 5],
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        v.set_params(p);
        v
    }
}

impl Effect for Vocoder {
    fn set_params(&mut self, p: &Params) {
        let note = p[0].clamp(24.0, 96.0);
        let chord = CHORDS[(p[1].clamp(0.0, 3.0).round() as usize).min(3)];
        self.voices = chord.len();
        for (k, iv) in chord.iter().enumerate() {
            self.incs[k] = 440.0 * 2f32.powf((note + iv - 69.0) / 12.0) / self.sr;
        }
        self.noise = p[2].clamp(0.0, 1.0);
        let bands = p[3].clamp(8.0, 20.0).round() as usize;
        let key = [
            bands as i32,
            (p[4] * 100.0) as i32,
            (p[5] * 10.0) as i32,
            (p[6] * 10.0) as i32,
            (p[7] * 100.0) as i32,
        ];
        if key != self.key {
            self.key = key;
            self.bands = bands;
            let q = p[4].clamp(2.0, 30.0) as f64;
            let shift = 2f64.powf(p[7].clamp(-12.0, 12.0) as f64 / 12.0);
            let sr = self.sr as f64;
            for b in 0..bands {
                // 100Hz … 8kHz 로그 간격
                let f = 100.0 * (80.0f64).powf(b as f64 / (bands - 1) as f64);
                self.an[b].set(Coefs::new(Kind::BandPass, f, q, 0.0, sr));
                let c = Coefs::new(Kind::BandPass, (f * shift).min(sr * 0.45), q, 0.0, sr);
                self.syn_l[b].set(c);
                self.syn_r[b].set(c);
                self.env[b].set_times(p[5].clamp(0.5, 100.0), p[6].clamp(5.0, 1000.0), self.sr);
            }
        }
        self.sib = p[8].clamp(0.0, 1.0);
        let (d, w) = equal_power(p[9]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = self.bands;
        // 대역 수가 많을수록 하나하나가 좁아 작아진다 — 보정
        let norm = 3.0 * (n as f32).sqrt();
        for i in 0..l.len() {
            let x = 0.5 * (l[i] + r[i]);
            // 캐리어: 대역 제한 톱니 화음 + 노이즈
            let mut car = 0.0;
            for k in 0..self.voices {
                let t = self.phases[k];
                car += (2.0 * t - 1.0) - poly_blep(t, self.incs[k]);
                self.phases[k] = (t + self.incs[k]).fract();
            }
            car = car / self.voices as f32 * (1.0 - self.noise) + self.rng.bipolar() * self.noise;
            let mut ol = 0.0;
            let mut or = 0.0;
            for b in 0..n {
                let a = self.an[b].tick(x);
                let e = db_to_gain(self.env[b].tick(a.abs()));
                ol += self.syn_l[b].tick(car) * e;
                or += self.syn_r[b].tick(car) * e;
            }
            let s = self.sib_hp.tick(x) * self.sib;
            let (d, w) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * d + (ol * norm + s) * w;
            r[i] = r[i] * d + (or * norm + s) * w;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    fn zero_cross_hz(y: &[f32], sr: f32) -> f32 {
        let mut zc = 0;
        for i in 1..y.len() {
            if y[i - 1] < 0.0 && y[i] >= 0.0 {
                zc += 1;
            }
        }
        zc as f32 * sr / y.len() as f32
    }

    #[test]
    fn scale_snapping() {
        // 450Hz(A4 보다 39센트 위) → 반음계에선 A4
        assert!((nearest_in_scale(450.0, 0, 0, 440.0) - 440.0).abs() < 0.1);
        // C 장조에서 C#4(277Hz) 근처 → C4 나 D4 중 가까운 쪽
        let t = nearest_in_scale(280.0, 0, 1, 440.0);
        assert!((t - 293.66).abs() < 0.5 || (t - 261.63).abs() < 0.5, "{t}");
    }

    #[test]
    fn pitch_correction_pulls_to_note() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[1] = 0.0;
        p[2] = 5.0;
        p[3] = 1.0;
        p[4] = 440.0;
        p[5] = 1.0;
        let mut c = PitchCorrection::new(sr, &p);
        // 450Hz 로 부른 소리 (배음 있음) → 440Hz 로
        let f = 450.0;
        let x: Vec<f32> = (0..96000)
            .map(|n| {
                let t = std::f32::consts::TAU * f * n as f32 / sr;
                0.3 * (t.sin() + 0.4 * (2.0 * t).sin())
            })
            .collect();
        let (l, _) = run(&mut c, &p, &x, &x);
        let hz = zero_cross_hz(&l[48000..], sr);
        assert!((hz - 440.0).abs() < 4.0, "보정된 음 {hz}Hz");
        let mut m = [0.0; 16];
        c.meters(&mut m);
        assert!((m[0] - 450.0).abs() < 5.0 && (m[1] - 440.0).abs() < 0.5);
    }

    #[test]
    fn vocal_transformer_pitch_moves_and_latency_reported() {
        let sr = 48000.0;
        // 음정과 포먼트를 같이 옮기면 = 그냥 피치 시프트 → 한 옥타브 위
        let mut p = [0.0; 24];
        p[0] = 12.0;
        p[1] = 12.0;
        p[2] = 1.0;
        let mut v = VocalTransformer::new(sr, &p);
        let x = sine(200.0, sr, 96000, 0.4);
        let (l, _) = run(&mut v, &p, &x, &x);
        let hz = zero_cross_hz(&l[48000..], sr);
        assert!((hz - 400.0).abs() < 25.0, "{hz}");
        assert_eq!(v.latency(), stft::LATENCY);
        // 포먼트만 옮기면 음정(배음 간격)은 그대로 — 배음 많은 소리에서
        let mut p = [0.0; 24];
        p[1] = 5.0;
        p[2] = 1.0;
        let mut v = VocalTransformer::new(sr, &p);
        let rich: Vec<f32> = (0..96000)
            .map(|n| {
                let t = std::f32::consts::TAU * 200.0 * n as f32 / sr;
                0.2 * (t.sin() + 0.6 * (2.0 * t).sin() + 0.4 * (3.0 * t).sin())
            })
            .collect();
        let (l, _) = run(&mut v, &p, &rich, &rich);
        let tail = &l[48000..];
        let probe = |hz: f32| {
            let (mut re, mut im) = (0f64, 0f64);
            for (i, v) in tail.iter().enumerate() {
                let ph = std::f64::consts::TAU * hz as f64 * i as f64 / sr as f64;
                re += *v as f64 * ph.cos();
                im += *v as f64 * ph.sin();
            }
            (re * re + im * im).sqrt()
        };
        assert!(probe(200.0) > probe(250.0) * 5.0, "기본음 200Hz 는 그대로");
    }

    #[test]
    fn vocoder_follows_modulator() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 48.0;
        p[2] = 0.0;
        p[3] = 16.0;
        p[4] = 8.0;
        p[5] = 5.0;
        p[6] = 50.0;
        p[9] = 1.0;
        let mut v = Vocoder::new(sr, &p);
        let silent = vec![0.0; 24000];
        let (q, _) = run(&mut v, &p, &silent, &silent);
        assert!(peak(&q[12000..]) < 1e-3, "말이 없으면 조용");
        let voice = sine(600.0, sr, 24000, 0.5);
        let (y, _) = run(&mut v, &p, &voice, &voice);
        assert!(
            rms(&y[12000..]) > 0.01,
            "말이 있으면 캐리어가 들린다 {}",
            rms(&y[12000..])
        );
    }

    #[test]
    fn harmonizer_and_octaver_bounded() {
        let sr = 48000.0;
        let x = sine(220.0, sr, 48000, 0.5);
        let mut p = [0.0; 24];
        p[0] = 4.0;
        p[1] = 0.7;
        p[2] = -0.5;
        p[3] = 7.0;
        p[4] = 0.7;
        p[5] = 0.5;
        p[6] = 1.0;
        p[7] = 2.0;
        let mut h = Harmonizer::new(sr, &p);
        let (l, _) = run(&mut h, &p, &x, &x);
        assert!(peak(&l) < 2.0 && rms(&l) > 0.3);
        let mut p = [0.0; 24];
        p[0] = 1.0;
        p[3] = 0.0;
        p[4] = 1000.0;
        let mut o = Octaver::new(sr, &p);
        let (l, _) = run(&mut o, &p, &x, &x);
        let hz = zero_cross_hz(&l[24000..], sr);
        assert!((hz - 110.0).abs() < 12.0, "한 옥타브 아래 {hz}");
    }
}

//! 미터·유틸 (6단계) — 튜너 · 라우드니스 · 레벨 · 상관 · 분석기 · BPM 카운터 · 유틸리티 · 방향 믹서 ·
//! 스테레오 스프레드. 미터는 소리를 바꾸지 않는다(통과) — 값은 `meters()` 로 화면에 간다.

use super::{Effect, Meters, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind};
use crate::blocks::oversample::Oversampler;
use crate::blocks::smooth::Smooth;
use crate::blocks::yin::Yin;
use crate::blocks::{db_to_gain, gain_to_db, time_coef};

// ---------------------------------------------------------------------------
// 튜너 (Logic Tuner) — 미터: 0 감지 Hz · 1 가까운 음(MIDI) · 2 벗어남 센트 · 3 확신
// 파라미터: 0 기준 A Hz
// ---------------------------------------------------------------------------

pub struct Tuner {
    yin: Yin,
    a4: f32,
    hz: f32,
    clarity: f32,
}

impl Tuner {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut t = Self {
            yin: Yin::new(sr),
            a4: 440.0,
            hz: 0.0,
            clarity: 0.0,
        };
        t.set_params(p);
        t
    }
}

impl Effect for Tuner {
    fn set_params(&mut self, p: &Params) {
        self.a4 = p[0].clamp(400.0, 480.0);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            if self.yin.tick(0.5 * (l[i] + r[i])) {
                // 확신이 낮으면 마지막 값을 붙잡아 둔다 — 바늘이 덜 떤다
                if self.yin.hz > 0.0 && self.yin.clarity > 0.5 {
                    self.hz = self.yin.hz;
                }
                self.clarity = self.yin.clarity;
            }
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.hz;
        if self.hz > 0.0 {
            let midi = 69.0 + 12.0 * (self.hz / self.a4).log2();
            out[1] = midi.round();
            out[2] = (midi - midi.round()) * 100.0;
        } else {
            out[1] = 0.0;
            out[2] = 0.0;
        }
        out[3] = self.clarity;
    }
}

// ---------------------------------------------------------------------------
// 라우드니스 미터 (Logic Loudness Meter, ITU-R BS.1770 / EBU R128)
// K 가중(고역 셸프 + 하이패스) → 400ms 블록(100ms 마다) → 순간(M)·단기(3초, S)·통합(I, 게이트 −70 LUFS
// 절대 + −10 LU 상대). 통합은 0.1 LU 칸 히스토그램에 모아 오디오 스레드에서 할당하지 않는다.
// 트루 피크는 4배 보간 최대값.
// 미터: 0 M · 1 S · 2 I (LUFS) · 3 트루 피크 dBTP(최대 유지) · 4 M 최대
// 파라미터: 0 다시 재기(값이 바뀔 때마다 통합·최대를 비운다)
// ---------------------------------------------------------------------------

const HIST_MIN: f32 = -70.0;
const HIST_BINS: usize = 800; // −70 … +10 LUFS, 0.1 LU

pub struct Loudness {
    k: [[Biquad; 2]; 2],
    block: usize,
    hop: usize,
    /// 100ms 조각 에너지 (최근 30개 = 3초)
    chunks: [f64; 30],
    chunk_pos: usize,
    chunk_count: usize,
    acc: f64,
    acc_n: usize,
    hist_count: Vec<u32>,
    hist_energy: Vec<f64>,
    os: [Oversampler; 2],
    m: f32,
    s: f32,
    i: f32,
    tp: f32,
    m_max: f32,
    reset_key: f32,
}

fn k_weighting(sr: f64) -> [Biquad; 2] {
    // BS.1770 의 두 단 (48kHz 계수를 낳는 아날로그 원형을 그대로 쓴다)
    [
        Biquad::new(Coefs::new(
            Kind::HighShelf,
            1681.974,
            0.707_175,
            3.999_843,
            sr,
        )),
        Biquad::new(Coefs::new(Kind::HighPass, 38.135_47, 0.500_327, 0.0, sr)),
    ]
}

impl Loudness {
    pub fn new(sr: f32, p: &Params) -> Self {
        let kw = k_weighting(sr as f64);
        let mut l = Self {
            k: [kw, kw],
            block: 0,
            hop: (0.1 * sr) as usize,
            chunks: [0.0; 30],
            chunk_pos: 0,
            chunk_count: 0,
            acc: 0.0,
            acc_n: 0,
            hist_count: vec![0; HIST_BINS],
            hist_energy: vec![0.0; HIST_BINS],
            os: [Oversampler::new(), Oversampler::new()],
            m: -120.0,
            s: -120.0,
            i: -120.0,
            tp: -120.0,
            m_max: -120.0,
            reset_key: p[0],
        };
        l.set_params(p);
        l
    }

    fn reset(&mut self) {
        self.hist_count.iter_mut().for_each(|v| *v = 0);
        self.hist_energy.iter_mut().for_each(|v| *v = 0.0);
        self.i = -120.0;
        self.tp = -120.0;
        self.m_max = -120.0;
    }

    fn integrated(&self) -> f32 {
        // 절대 게이트(−70)를 넘은 블록 평균 → 그보다 10 LU 아래를 버리고 다시 평균
        let (mut e, mut n) = (0f64, 0u64);
        for b in 0..HIST_BINS {
            e += self.hist_energy[b];
            n += self.hist_count[b] as u64;
        }
        if n == 0 {
            return -120.0;
        }
        let ungated = lufs(e / n as f64);
        let gate = ungated - 10.0;
        let (mut e2, mut n2) = (0f64, 0u64);
        for b in 0..HIST_BINS {
            let lvl = HIST_MIN + b as f32 * 0.1;
            if lvl >= gate {
                e2 += self.hist_energy[b];
                n2 += self.hist_count[b] as u64;
            }
        }
        if n2 == 0 {
            -120.0
        } else {
            lufs(e2 / n2 as f64)
        }
    }
}

#[inline]
fn lufs(mean_square: f64) -> f32 {
    (-0.691 + 10.0 * mean_square.max(1e-20).log10()) as f32
}

impl Effect for Loudness {
    fn set_params(&mut self, p: &Params) {
        if p[0] != self.reset_key {
            self.reset_key = p[0];
            self.reset();
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let mut e = 0f64;
            for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                let a = self.k[c][0].tick(x);
                let y = self.k[c][1].tick(a);
                e += (y as f64) * (y as f64);
                for s in self.os[c].up(x) {
                    let d = gain_to_db(s.abs());
                    if d > self.tp {
                        self.tp = d;
                    }
                }
            }
            self.acc += e;
            self.acc_n += 1;
            self.block += 1;
            if self.block >= self.hop {
                self.block = 0;
                self.chunks[self.chunk_pos] = self.acc / self.acc_n as f64;
                self.chunk_pos = (self.chunk_pos + 1) % 30;
                self.chunk_count = (self.chunk_count + 1).min(30);
                self.acc = 0.0;
                self.acc_n = 0;
                // 순간 = 최근 4조각(400ms), 단기 = 최근 30조각(3초)
                let recent = |n: usize, chunks: &[f64; 30], pos: usize| -> f64 {
                    let mut s = 0.0;
                    for k in 0..n {
                        s += chunks[(pos + 30 - 1 - k) % 30];
                    }
                    s / n as f64
                };
                if self.chunk_count >= 4 {
                    let ms = recent(4, &self.chunks, self.chunk_pos);
                    self.m = lufs(ms);
                    self.m_max = self.m_max.max(self.m);
                    if self.m > HIST_MIN {
                        let b = (((self.m - HIST_MIN) * 10.0) as usize).min(HIST_BINS - 1);
                        self.hist_count[b] += 1;
                        self.hist_energy[b] += ms;
                    }
                    self.i = self.integrated();
                }
                if self.chunk_count >= 30 {
                    self.s = lufs(recent(30, &self.chunks, self.chunk_pos));
                }
            }
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.m;
        out[1] = self.s;
        out[2] = self.i;
        out[3] = self.tp;
        out[4] = self.m_max;
    }
}

// ---------------------------------------------------------------------------
// 레벨 미터 — 미터: 0 왼 피크 · 1 오른 피크 · 2 왼 RMS · 3 오른 RMS · 4 피크 유지(최대) dBFS
// 파라미터: 0 RMS 시간 ms
// ---------------------------------------------------------------------------

pub struct LevelMeter {
    sr: f32,
    peak: [f32; 2],
    ms: [f32; 2],
    coef: f32,
    fall: f32,
    hold: f32,
}

impl LevelMeter {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut m = Self {
            sr,
            peak: [0.0; 2],
            ms: [0.0; 2],
            coef: 0.0,
            fall: time_coef(300.0, sr),
            hold: 0.0,
        };
        m.set_params(p);
        m
    }
}

impl Effect for LevelMeter {
    fn set_params(&mut self, p: &Params) {
        self.coef = time_coef(p[0].clamp(10.0, 3000.0), self.sr);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                let a = x.abs();
                self.peak[c] = if a > self.peak[c] {
                    a
                } else {
                    self.peak[c] * self.fall
                };
                self.ms[c] = x * x + (self.ms[c] - x * x) * self.coef;
                self.hold = self.hold.max(a);
            }
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = gain_to_db(self.peak[0]);
        out[1] = gain_to_db(self.peak[1]);
        out[2] = gain_to_db(self.ms[0].sqrt());
        out[3] = gain_to_db(self.ms[1].sqrt());
        out[4] = gain_to_db(self.hold);
    }
}

// ---------------------------------------------------------------------------
// 상관 미터 (Logic Correlation Meter) — +1 모노 같음, 0 무관, −1 위상 반대(모노로 합치면 사라진다).
// 미터: 0 상관 · 1 좌우 균형(−1 왼..1 오른) · 2 폭(사이드/미드 dB)
// 파라미터: 0 반응 ms
// ---------------------------------------------------------------------------

pub struct Correlation {
    sr: f32,
    coef: f32,
    lr: f32,
    ll: f32,
    rr: f32,
}

impl Correlation {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut c = Self {
            sr,
            coef: 0.0,
            lr: 0.0,
            ll: 0.0,
            rr: 0.0,
        };
        c.set_params(p);
        c
    }
}

impl Effect for Correlation {
    fn set_params(&mut self, p: &Params) {
        self.coef = time_coef(p[0].clamp(10.0, 3000.0), self.sr);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let c = self.coef;
        for i in 0..l.len() {
            let (a, b) = (l[i], r[i]);
            self.lr = a * b + (self.lr - a * b) * c;
            self.ll = a * a + (self.ll - a * a) * c;
            self.rr = b * b + (self.rr - b * b) * c;
        }
    }

    fn meters(&self, out: &mut Meters) {
        let den = (self.ll * self.rr).sqrt();
        out[0] = if den > 1e-12 {
            (self.lr / den).clamp(-1.0, 1.0)
        } else {
            0.0
        };
        let (l, r) = (self.ll.sqrt(), self.rr.sqrt());
        out[1] = if l + r > 1e-9 { (r - l) / (l + r) } else { 0.0 };
        let mid = (self.ll + self.rr + 2.0 * self.lr) * 0.25;
        let side = (self.ll + self.rr - 2.0 * self.lr) * 0.25;
        out[2] = 10.0 * (side.max(1e-20) / mid.max(1e-20)).log10();
    }
}

// ---------------------------------------------------------------------------
// 분석기 (Logic Multimeter 의 분석기) — 16 대역(30Hz…16kHz 로그) RMS dB.
// 파라미터: 0 반응 ms
// 미터: 0~15 대역 dB
// ---------------------------------------------------------------------------

pub const ANALYZER_BANDS: usize = 16;

pub struct Analyzer {
    sr: f32,
    f: [Biquad; ANALYZER_BANDS],
    ms: [f32; ANALYZER_BANDS],
    coef: f32,
}

impl Analyzer {
    pub fn new(sr: f32, p: &Params) -> Self {
        let f = std::array::from_fn(|b| {
            let hz = 30.0 * (16000.0f64 / 30.0).powf(b as f64 / (ANALYZER_BANDS - 1) as f64);
            Biquad::new(Coefs::new(
                Kind::BandPass,
                hz.min(sr as f64 * 0.45),
                2.2,
                0.0,
                sr as f64,
            ))
        });
        let mut a = Self {
            sr,
            f,
            ms: [0.0; ANALYZER_BANDS],
            coef: 0.0,
        };
        a.set_params(p);
        a
    }
}

impl Effect for Analyzer {
    fn set_params(&mut self, p: &Params) {
        self.coef = time_coef(p[0].clamp(20.0, 2000.0), self.sr);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let c = self.coef;
        for i in 0..l.len() {
            let x = 0.5 * (l[i] + r[i]);
            for b in 0..ANALYZER_BANDS {
                let y = self.f[b].tick(x);
                self.ms[b] = y * y + (self.ms[b] - y * y) * c;
            }
        }
    }

    fn meters(&self, out: &mut Meters) {
        for b in 0..ANALYZER_BANDS {
            // 사인 진폭 기준 dBFS (RMS → 피크 +3dB)
            out[b] = gain_to_db((2.0 * self.ms[b]).sqrt());
        }
    }
}

// ---------------------------------------------------------------------------
// BPM 카운터 (Logic BPM Counter) — 저역 에너지가 갑자기 늘어나는 순간(온셋)을 세고,
// 온셋 신호의 자기상관에서 60~200 BPM 사이 가장 강한 주기를 고른다. 1초마다 다시 잰다.
// 미터: 0 BPM · 1 확신(0..1)
// ---------------------------------------------------------------------------

const ONSET_RATE_DIV: usize = 256;
const ONSET_LEN: usize = 1024; // 48k 기준 약 5.5초

pub struct BpmCounter {
    sr: f32,
    lp: Biquad,
    env: f32,
    prev: f32,
    acc: f32,
    n: usize,
    onset: Vec<f32>,
    pos: usize,
    filled: usize,
    since: usize,
    bpm: f32,
    conf: f32,
    scores: Vec<f32>,
}

impl BpmCounter {
    pub fn new(sr: f32, _p: &Params) -> Self {
        Self {
            sr,
            lp: Biquad::new(Coefs::new(Kind::LowPass, 200.0, 0.707, 0.0, sr as f64)),
            env: 0.0,
            prev: 0.0,
            acc: 0.0,
            n: 0,
            onset: vec![0.0; ONSET_LEN],
            pos: 0,
            filled: 0,
            since: 0,
            bpm: 0.0,
            conf: 0.0,
            scores: vec![0.0; ONSET_LEN],
        }
    }

    fn estimate(&mut self) {
        let fps = self.sr / ONSET_RATE_DIV as f32;
        let lag_min = (fps * 60.0 / 200.0) as usize;
        let lag_max = ((fps * 60.0 / 60.0) as usize).min(self.filled / 2);
        if lag_max <= lag_min + 2 {
            return;
        }
        let n = self.filled;
        let at = |k: usize| self.onset[(self.pos + ONSET_LEN - n + k) % ONSET_LEN];
        let mean: f32 = (0..n).map(at).sum::<f32>() / n as f32;
        let mut zero = 0.0;
        for k in 0..n {
            let v = at(k) - mean;
            zero += v * v;
        }
        if zero < 1e-12 {
            return;
        }
        let mut best = (0usize, f32::MIN);
        // 오디오 스레드에서 할당하지 않게 미리 잡아 둔 버퍼를 쓴다
        let mut scores = std::mem::take(&mut self.scores);
        for lag in lag_min..=lag_max + 1 {
            let mut s = 0.0;
            for k in 0..n - lag {
                s += (at(k) - mean) * (at(k + lag) - mean);
            }
            // 사람이 느끼는 박(120 근처)을 조금 선호 — 절반/두 배 박 혼동을 줄인다
            let bpm = 60.0 * fps / lag as f32;
            let prior = (-((bpm / 120.0).log2()).powi(2) * 0.5).exp();
            scores[lag] = s / zero;
            let score = scores[lag] * (0.7 + 0.3 * prior);
            if lag <= lag_max && score > best.1 {
                best = (lag, score);
            }
        }
        let lag = best.0;
        if lag <= lag_min {
            self.scores = scores;
            return;
        }
        // 포물선 보간
        let (a, b, c) = (scores[lag - 1], scores[lag], scores[lag + 1]);
        let d = a - 2.0 * b + c;
        let frac = if d.abs() > 1e-9 {
            (0.5 * (a - c) / d).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        self.bpm = 60.0 * fps / (lag as f32 + frac);
        self.conf = b.clamp(0.0, 1.0);
        self.scores = scores;
    }
}

impl Effect for BpmCounter {
    fn set_params(&mut self, _p: &Params) {}

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let rel = time_coef(30.0, self.sr);
        for i in 0..l.len() {
            let x = self.lp.tick(0.5 * (l[i] + r[i]));
            let a = x.abs();
            self.env = if a > self.env {
                a
            } else {
                a + (self.env - a) * rel
            };
            self.acc += self.env;
            self.n += 1;
            if self.n >= ONSET_RATE_DIV {
                let e = self.acc / self.n as f32;
                // 늘어난 만큼만 (반파 정류한 차분)
                let o = (e - self.prev).max(0.0);
                self.prev = e;
                self.acc = 0.0;
                self.n = 0;
                self.onset[self.pos] = o;
                self.pos = (self.pos + 1) % ONSET_LEN;
                self.filled = (self.filled + 1).min(ONSET_LEN);
                self.since += 1;
                if self.since as f32 >= self.sr / ONSET_RATE_DIV as f32 {
                    self.since = 0;
                    self.estimate();
                }
            }
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.bpm;
        out[1] = self.conf;
    }
}

// ---------------------------------------------------------------------------
// 유틸리티 (Logic Gain) — 파라미터: 0 게인 dB · 1 왼 위상 뒤집기 · 2 오른 위상 뒤집기 · 3 모노 ·
//                          4 좌우 바꾸기 · 5 밸런스(−1..1) · 6 폭(0..2)
// ---------------------------------------------------------------------------

pub struct Utility {
    gain: Smooth,
    inv: [f32; 2],
    mono: bool,
    swap: bool,
    bal: Smooth,
    width: Smooth,
}

impl Utility {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut u = Self {
            gain: Smooth::new(20.0, sr),
            inv: [1.0; 2],
            mono: false,
            swap: false,
            bal: Smooth::new(20.0, sr),
            width: Smooth::new(20.0, sr),
        };
        u.set_params(p);
        u
    }
}

impl Effect for Utility {
    fn set_params(&mut self, p: &Params) {
        self.gain.set(db_to_gain(p[0].clamp(-96.0, 36.0)));
        self.inv = [
            if p[1] >= 0.5 { -1.0 } else { 1.0 },
            if p[2] >= 0.5 { -1.0 } else { 1.0 },
        ];
        self.mono = p[3] >= 0.5;
        self.swap = p[4] >= 0.5;
        self.bal.set(p[5].clamp(-1.0, 1.0));
        self.width.set(p[6].clamp(0.0, 2.0));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let g = self.gain.tick();
            let (mut a, mut b) = (l[i] * self.inv[0] * g, r[i] * self.inv[1] * g);
            if self.swap {
                std::mem::swap(&mut a, &mut b);
            }
            let w = if self.mono { 0.0 } else { self.width.tick() };
            let m = 0.5 * (a + b);
            let s = 0.5 * (a - b) * w;
            let bal = self.bal.tick();
            // 밸런스: 한쪽만 줄인다 (가운데는 그대로)
            l[i] = (m + s) * (1.0 - bal).min(1.0);
            r[i] = (m - s) * (1.0 + bal).min(1.0);
        }
    }
}

// ---------------------------------------------------------------------------
// 방향 믹서 (Logic Direction Mixer) — 입력을 LR 또는 MS 로 보고, 폭을 늘이고 줄이고, 소리 상 전체를
// 왼쪽·오른쪽으로 돌린다. 파라미터: 0 입력(LR/MS) · 1 폭(0..2) · 2 방향(−90..90°)
// ---------------------------------------------------------------------------

pub struct DirectionMixer {
    ms_input: bool,
    spread: Smooth,
    dir: Smooth,
}

impl DirectionMixer {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut d = Self {
            ms_input: false,
            spread: Smooth::new(20.0, sr),
            dir: Smooth::new(20.0, sr),
        };
        d.set_params(p);
        d
    }
}

impl Effect for DirectionMixer {
    fn set_params(&mut self, p: &Params) {
        self.ms_input = p[0] >= 0.5;
        self.spread.set(p[1].clamp(0.0, 2.0));
        self.dir.set(p[2].clamp(-90.0, 90.0).to_radians());
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let (m, s) = if self.ms_input {
                (l[i], r[i])
            } else {
                (0.5 * (l[i] + r[i]), 0.5 * (l[i] - r[i]))
            };
            let s = s * self.spread.tick();
            let (a, b) = (m + s, m - s);
            // 방향: 반대쪽 채널을 cos 로 줄이고 그만큼(sin) 이쪽으로 옮긴다 — 0° 그대로, ±90° 한쪽으로 다 모인다.
            // 서로 무관한 좌우라면 전체 파워가 그대로다
            let th = self.dir.tick();
            let (sn, cs) = th.abs().sin_cos();
            if th >= 0.0 {
                l[i] = a * cs;
                r[i] = b + a * sn;
            } else {
                l[i] = a + b * sn;
                r[i] = b * cs;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 스테레오 스프레드 (Logic Stereo Spread) — 미드를 여러 대역으로 나눠 왼·오른쪽에 번갈아 더한다.
// 모노로 합치면 더한 것이 서로 상쇄되어 원래 소리 — 모노 호환이 유지된다.
// 파라미터: 0 대역 수(2..12) · 1 세기 0..1 · 2 아래 Hz · 3 위 Hz
// ---------------------------------------------------------------------------

const SPREAD_MAX: usize = 12;

pub struct StereoSpread {
    sr: f32,
    bands: usize,
    f: [Biquad; SPREAD_MAX],
    amount: Smooth,
    key: (usize, i32, i32),
}

impl StereoSpread {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut s = Self {
            sr,
            bands: 8,
            f: [Biquad::default(); SPREAD_MAX],
            amount: Smooth::new(20.0, sr),
            key: (0, 0, 0),
        };
        s.set_params(p);
        s
    }
}

impl Effect for StereoSpread {
    fn set_params(&mut self, p: &Params) {
        let bands = p[0].clamp(2.0, 12.0).round() as usize;
        let lo = p[2].clamp(50.0, 2000.0);
        let hi = p[3].clamp(lo * 2.0, 20000.0);
        let key = (bands, lo as i32, hi as i32);
        if key != self.key {
            self.key = key;
            self.bands = bands;
            for b in 0..bands {
                let hz = lo * (hi / lo).powf((b as f32 + 0.5) / bands as f32);
                self.f[b].set(Coefs::new(
                    Kind::BandPass,
                    hz as f64,
                    1.2 * bands as f64 / 4.0,
                    0.0,
                    self.sr as f64,
                ));
            }
        }
        self.amount.set(p[1].clamp(0.0, 1.0));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let m = 0.5 * (l[i] + r[i]);
            let mut s = 0.0;
            for b in 0..self.bands {
                let y = self.f[b].tick(m);
                s += if b % 2 == 0 { y } else { -y };
            }
            let a = self.amount.tick() * 0.7;
            l[i] += s * a;
            r[i] -= s * a;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    #[test]
    fn tuner_reads_note_and_cents() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 440.0;
        let mut t = Tuner::new(sr, &p);
        // A4 보다 20센트 높게
        let f = 440.0 * 2f32.powf(20.0 / 1200.0);
        let x = sine(f, sr, 24000, 0.4);
        let (l, _) = run(&mut t, &p, &x, &x);
        assert_eq!(l, x, "튜너는 소리를 바꾸지 않는다");
        let mut m = [0.0; 16];
        t.meters(&mut m);
        assert_eq!(m[1], 69.0);
        assert!((m[2] - 20.0).abs() < 4.0, "{}", m[2]);
    }

    #[test]
    fn loudness_of_1k_sine() {
        // −18dBFS 피크 1kHz 사인 (양쪽) → K 가중 1kHz ≈ +0dB → −18 −3(RMS) +3(두 채널 합) −0.691 ≈ −18.7 LUFS
        let sr = 48000.0;
        let p = [0.0; 24];
        let mut lm = Loudness::new(sr, &p);
        let x = sine(1000.0, sr, 48000 * 4, db_to_gain(-18.0));
        run(&mut lm, &p, &x, &x);
        let mut m = [0.0; 16];
        lm.meters(&mut m);
        assert!((m[0] + 18.7).abs() < 0.5, "M {}", m[0]);
        assert!((m[1] + 18.7).abs() < 0.5, "S {}", m[1]);
        assert!((m[2] + 18.7).abs() < 0.5, "I {}", m[2]);
        assert!((m[3] + 18.0).abs() < 0.3, "TP {}", m[3]);
    }

    #[test]
    fn correlation_signs() {
        let sr = 48000.0;
        let p = [0.0; 24];
        let x = sine(300.0, sr, 24000, 0.5);
        let neg: Vec<f32> = x.iter().map(|v| -v).collect();
        let mut c = Correlation::new(sr, &p);
        run(&mut c, &p, &x, &x);
        let mut m = [0.0; 16];
        c.meters(&mut m);
        assert!(m[0] > 0.99);
        let mut c = Correlation::new(sr, &p);
        run(&mut c, &p, &x, &neg);
        c.meters(&mut m);
        assert!(m[0] < -0.99);
    }

    #[test]
    fn analyzer_peaks_in_right_band() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 100.0;
        let mut a = Analyzer::new(sr, &p);
        let x = sine(1000.0, sr, 24000, 0.5);
        run(&mut a, &p, &x, &x);
        let mut m = [0.0; 16];
        a.meters(&mut m);
        let best = (0..16).max_by(|&i, &j| m[i].total_cmp(&m[j])).unwrap();
        let hz = 30.0 * (16000.0f32 / 30.0).powf(best as f32 / 15.0);
        assert!((hz / 1000.0).log2().abs() < 0.5, "가장 큰 대역 {hz}Hz");
    }

    #[test]
    fn bpm_counter_finds_tempo() {
        let sr = 48000.0;
        let p = [0.0; 24];
        let mut b = BpmCounter::new(sr, &p);
        // 128 BPM 킥 (60Hz 짧은 사인 + 빠른 감쇠)
        let period = (sr * 60.0 / 128.0) as usize;
        let x: Vec<f32> = (0..(sr as usize * 8))
            .map(|n| {
                let t = (n % period) as f32 / sr;
                (std::f32::consts::TAU * 60.0 * t).sin() * (-t * 25.0).exp() * 0.8
            })
            .collect();
        run(&mut b, &p, &x, &x);
        let mut m = [0.0; 16];
        b.meters(&mut m);
        assert!((m[0] - 128.0).abs() < 2.0, "BPM {}", m[0]);
    }

    #[test]
    fn direction_mixer_moves_image() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[1] = 1.0;
        p[2] = 90.0;
        let mut d = DirectionMixer::new(sr, &p);
        let (l, r) = run(&mut d, &p, &[0.5; 64], &[0.0; 64]);
        assert!(
            l[63].abs() < 1e-3 && (r[63] - 0.5).abs() < 1e-3,
            "왼쪽 소리가 오른쪽으로 {} {}",
            l[63],
            r[63]
        );
    }

    #[test]
    fn utility_mono_swap_invert() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[3] = 1.0;
        p[6] = 1.0;
        let mut u = Utility::new(sr, &p);
        let (l, r) = run(&mut u, &p, &[1.0, 0.0], &[0.0, 1.0]);
        assert_eq!((l[0], r[0]), (0.5, 0.5));
        let mut p = [0.0; 24];
        p[1] = 1.0;
        p[4] = 1.0;
        p[6] = 1.0;
        let mut u = Utility::new(sr, &p);
        let (l, r) = run(&mut u, &p, &[0.3], &[0.7]);
        assert!(
            (l[0] - 0.7).abs() < 1e-6 && (r[0] + 0.3).abs() < 1e-6,
            "{} {}",
            l[0],
            r[0]
        );
    }

    #[test]
    fn stereo_spread_is_mono_compatible() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 8.0;
        p[1] = 1.0;
        p[2] = 200.0;
        p[3] = 8000.0;
        let mut s = StereoSpread::new(sr, &p);
        let x = sine(700.0, sr, 24000, 0.5);
        let (l, r) = run(&mut s, &p, &x, &x);
        for n in 12000..24000 {
            assert!((0.5 * (l[n] + r[n]) - x[n]).abs() < 1e-5);
        }
        assert!(
            l.iter().zip(&r).any(|(a, b)| (a - b).abs() > 0.05),
            "좌우가 벌어졌다"
        );
    }
}

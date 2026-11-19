//! 멀티·창작 (7단계) — 트랜스 게이트 · 스텝 FX · 리믹스 FX · 비트 브레이커 · 스터터 · 테이프 스톱 ·
//! 팻 FX · 페달보드. 박자에 맞추는 것은 `transport()` 로 받은 곡 위치·템포로 칸을 센다
//! (재생을 어디서 시작해도 마디에 맞는다 — 워크렛이 곡 0 초의 프레임을 안다).

use super::{create, Effect, Meters, Params, KINDS};
use crate::blocks::delay::DelayLine;
use crate::blocks::env::Follower;
use crate::blocks::lfo::{value, Shape};
use crate::blocks::oversample::{self, Oversampler};
use crate::blocks::rng::Rng;
use crate::blocks::smooth::Smooth;
use crate::blocks::svf::Svf;
use crate::blocks::{db_to_gain, time_coef};

fn equal_power(mix: f32) -> (f32, f32) {
    let m = mix.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    (m.cos(), m.sin())
}

/// 박 나누기 — 0 1/1 · 1 1/2 · 2 1/4 · 3 1/8 · 4 1/16 · 5 1/32 · 6 1/8 셋잇 · 7 1/16 셋잇 → 한 칸의 박 수
pub const DIVISIONS: [f32; 8] = [4.0, 2.0, 1.0, 0.5, 0.25, 0.125, 1.0 / 3.0, 1.0 / 6.0];

fn division(v: f32) -> f32 {
    DIVISIONS[(v.clamp(0.0, 7.0).round() as usize).min(7)]
}

/// 곡 위치(샘플) → 박 위치
#[derive(Clone, Copy)]
struct Clock {
    sr: f32,
    pos: f64,
    bpm: f32,
}

impl Clock {
    fn new(sr: f32) -> Self {
        Self {
            sr,
            pos: 0.0,
            bpm: 120.0,
        }
    }
    #[inline(always)]
    fn beats(&self, i: usize) -> f64 {
        (self.pos + i as f64) / self.sr as f64 * self.bpm as f64 / 60.0
    }
    fn samples_per_beat(&self) -> f32 {
        self.sr * 60.0 / self.bpm
    }
}

// ---------------------------------------------------------------------------
// 트랜스 게이트 — 16 칸 켬/끔 패턴으로 소리를 자른다. 칸 경계는 어택·디케이로 둥글린다.
// 파라미터: 0~15 칸 · 16 칸 길이 · 17 어택 ms · 18 디케이(칸 안에서 줄어드는 정도 0..1) · 19 깊이 · 20 섞기
// ---------------------------------------------------------------------------

pub struct TranceGate {
    clock: Clock,
    pattern: [bool; 16],
    div: f32,
    att: f32,
    decay: f32,
    depth: f32,
    g: f32,
    dry: Smooth,
    wet: Smooth,
}

impl TranceGate {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut t = Self {
            clock: Clock::new(sr),
            pattern: [true; 16],
            div: 0.25,
            att: 0.0,
            decay: 0.0,
            depth: 1.0,
            g: 0.0,
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        t.set_params(p);
        t
    }
}

impl Effect for TranceGate {
    fn transport(&mut self, position: f64, bpm: f32) {
        self.clock.pos = position;
        self.clock.bpm = bpm;
    }

    fn set_params(&mut self, p: &Params) {
        for k in 0..16 {
            self.pattern[k] = p[k] >= 0.5;
        }
        self.div = division(p[16]);
        self.att = time_coef(p[17].clamp(0.1, 50.0), self.clock.sr);
        self.decay = p[18].clamp(0.0, 1.0);
        self.depth = p[19].clamp(0.0, 1.0);
        let (d, w) = equal_power(p[20]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let steps = self.clock.beats(i) / self.div as f64;
            let step = (steps.floor() as i64).rem_euclid(16) as usize;
            let within = steps.fract() as f32;
            let on = self.pattern[step];
            // 칸 안에서 디케이만큼 줄어든다 (칸 끝에서 1 − decay)
            let target = if on { 1.0 - self.decay * within } else { 0.0 };
            self.g = target + (self.g - target) * self.att;
            let gain = 1.0 - self.depth * (1.0 - self.g);
            let (d, w) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * d + l[i] * gain * w;
            r[i] = r[i] * d + r[i] * gain * w;
        }
        self.clock.pos += l.len() as f64;
    }
}

// ---------------------------------------------------------------------------
// 스텝 FX (Logic Step FX) — 8 칸 필터 차단 · 8 칸 볼륨, 칸마다 좌우를 번갈아(팬 양).
// 파라미터: 0~7 필터 칸(0..1 → 아래~위 Hz) · 8~15 볼륨 칸 · 16 칸 길이 · 17 공명 · 18 아래 Hz · 19 위 Hz ·
//           20 매끄러움 ms · 21 팬 양 · 22 섞기
// ---------------------------------------------------------------------------

pub struct StepFx {
    clock: Clock,
    cut: [f32; 8],
    vol: [f32; 8],
    div: f32,
    q: f32,
    lo: f32,
    hi: f32,
    smooth: f32,
    pan: f32,
    f: [Svf; 2],
    c: f32,
    v: f32,
    pp: f32,
    dry: Smooth,
    wet: Smooth,
    n: usize,
}

impl StepFx {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut s = Self {
            clock: Clock::new(sr),
            cut: [1.0; 8],
            vol: [1.0; 8],
            div: 0.25,
            q: 1.0,
            lo: 200.0,
            hi: 12000.0,
            smooth: 0.0,
            pan: 0.0,
            f: [Svf::default(); 2],
            c: 1.0,
            v: 1.0,
            pp: 0.0,
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            n: 0,
        };
        s.set_params(p);
        s
    }
}

impl Effect for StepFx {
    fn transport(&mut self, position: f64, bpm: f32) {
        self.clock.pos = position;
        self.clock.bpm = bpm;
    }

    fn set_params(&mut self, p: &Params) {
        for k in 0..8 {
            self.cut[k] = p[k].clamp(0.0, 1.0);
            self.vol[k] = p[8 + k].clamp(0.0, 1.0);
        }
        self.div = division(p[16]);
        self.q = p[17].clamp(0.5, 15.0);
        self.lo = p[18].clamp(20.0, 5000.0);
        self.hi = p[19].clamp(self.lo * 1.5, 20000.0);
        self.smooth = time_coef(p[20].clamp(0.5, 200.0), self.clock.sr);
        self.pan = p[21].clamp(0.0, 1.0);
        let (d, w) = equal_power(p[22]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let sr = self.clock.sr;
        for i in 0..l.len() {
            let steps = self.clock.beats(i) / self.div as f64;
            let step = (steps.floor() as i64).rem_euclid(8) as usize;
            let a = self.smooth;
            self.c = self.cut[step] + (self.c - self.cut[step]) * a;
            self.v = self.vol[step] + (self.v - self.vol[step]) * a;
            let side = if step.is_multiple_of(2) {
                -self.pan
            } else {
                self.pan
            };
            self.pp = side + (self.pp - side) * a;
            if self.n.is_multiple_of(16) {
                let hz = self.lo * (self.hi / self.lo).powf(self.c);
                for f in &mut self.f {
                    f.set(hz, self.q, sr);
                }
            }
            self.n += 1;
            let yl = self.f[0].tick(l[i]).low * self.v;
            let yr = self.f[1].tick(r[i]).low * self.v;
            let ang = (self.pp + 1.0) * std::f32::consts::FRAC_PI_4;
            let (gl, gr) = (
                ang.cos() * std::f32::consts::SQRT_2,
                ang.sin() * std::f32::consts::SQRT_2,
            );
            let (d, w) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * d + yl * gl * w;
            r[i] = r[i] * d + yr * gr * w;
        }
        self.clock.pos += l.len() as f64;
    }
}

// ---------------------------------------------------------------------------
// 리믹스 FX (Logic Remix FX) — 공연용: 필터(− 로우패스 … + 하이패스) · 게이트(박자 자르기) ·
// 다운샘플 · 리버스(지난 한 박을 거꾸로).
// 파라미터: 0 필터(−1..1) · 1 공명 · 2 게이트 칸 · 3 게이트 양 · 4 크러시 0..1 · 5 리버스(0/1) · 6 섞기
// ---------------------------------------------------------------------------

pub struct RemixFx {
    clock: Clock,
    filter: Smooth,
    q: f32,
    f: [Svf; 2],
    gate_div: f32,
    gate_amt: f32,
    crush: f32,
    hold: [f32; 2],
    count: f32,
    reverse: bool,
    rev_t: f32,
    buf: [DelayLine; 2],
    rev_mix: f32,
    dry: Smooth,
    wet: Smooth,
    n: usize,
}

impl RemixFx {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut x = Self {
            clock: Clock::new(sr),
            filter: Smooth::new(30.0, sr),
            q: 1.0,
            f: [Svf::default(); 2],
            gate_div: 0.25,
            gate_amt: 0.0,
            crush: 0.0,
            hold: [0.0; 2],
            count: 0.0,
            reverse: false,
            rev_t: 0.0,
            buf: [
                DelayLine::new((sr * 3.2) as usize),
                DelayLine::new((sr * 3.2) as usize),
            ],
            rev_mix: 0.0,
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            n: 0,
        };
        x.set_params(p);
        x
    }
}

impl Effect for RemixFx {
    fn transport(&mut self, position: f64, bpm: f32) {
        self.clock.pos = position;
        self.clock.bpm = bpm;
    }

    fn set_params(&mut self, p: &Params) {
        self.filter.set(p[0].clamp(-1.0, 1.0));
        self.q = p[1].clamp(0.5, 12.0);
        self.gate_div = division(p[2]);
        self.gate_amt = p[3].clamp(0.0, 1.0);
        self.crush = p[4].clamp(0.0, 1.0);
        let rev = p[5] >= 0.5;
        if rev && !self.reverse {
            self.rev_t = 0.0;
        }
        self.reverse = rev;
        let (d, w) = equal_power(p[6]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let sr = self.clock.sr;
        let beat = self.clock.samples_per_beat().min(sr * 1.5);
        let factor = 1.0 + self.crush * 31.0;
        for i in 0..l.len() {
            let x = [l[i], r[i]];
            self.buf[0].push(x[0]);
            self.buf[1].push(x[1]);
            // 리버스: 지난 한 박을 뒤로 읽는다 — 읽는 지연이 샘플마다 2 씩 늘어 거꾸로 들린다
            let target_mix = if self.reverse { 1.0 } else { 0.0 };
            self.rev_mix += (target_mix - self.rev_mix) * 0.002;
            let mut y = x;
            if self.rev_mix > 1e-3 {
                self.rev_t = (self.rev_t + 2.0) % (2.0 * beat);
                let d = 1.0 + self.rev_t;
                let fade = (std::f32::consts::PI * self.rev_t / (2.0 * beat)).sin();
                for c in 0..2 {
                    y[c] = x[c] * (1.0 - self.rev_mix) + self.buf[c].read(d) * fade * self.rev_mix;
                }
            }
            // 다운샘플
            if self.crush > 0.0 {
                self.count += 1.0;
                if self.count >= factor {
                    self.count -= factor;
                    self.hold = y;
                }
                y = self.hold;
            }
            // 필터: 0 이면 통과, − 로우패스 닫힘, + 하이패스 열림
            let fv = self.filter.tick();
            if self.n.is_multiple_of(16) {
                let hz = if fv < 0.0 {
                    20000.0 * (100.0f32 / 20000.0).powf(-fv)
                } else {
                    20.0 * (8000.0f32 / 20.0).powf(fv)
                };
                for f in &mut self.f {
                    f.set(hz, self.q, sr);
                }
            }
            self.n += 1;
            if fv.abs() > 0.01 {
                for c in 0..2 {
                    let o = self.f[c].tick(y[c]);
                    y[c] = if fv < 0.0 { o.low } else { o.high };
                }
            }
            // 게이트
            let steps = self.clock.beats(i) / self.gate_div as f64;
            let half = steps.fract() < 0.5;
            let g = if half { 1.0 } else { 1.0 - self.gate_amt };
            let (d, w) = (self.dry.tick(), self.wet.tick());
            l[i] = x[0] * d + y[0] * g * w;
            r[i] = x[1] * d + y[1] * g * w;
        }
        self.clock.pos += l.len() as f64;
    }
}

// ---------------------------------------------------------------------------
// 비트 브레이커 (Logic Beat Breaker) — 지난 한 마디를 16 조각으로 나눠 패턴대로 다시 꿰맨다.
// 지난 마디를 쓰므로 한 마디 늦은 재배열이다(공연용 슬라이서와 같은 방식). 패턴은 고른 것 + 씨앗.
// 파라미터: 0 패턴(뒤섞기/되감기/반복/엇박/씨앗 무작위) · 1 씨앗 · 2 조각 경계 페이드 ms · 3 섞기
// ---------------------------------------------------------------------------

const PATTERNS: [[u8; 16]; 4] = [
    [0, 1, 2, 3, 0, 1, 2, 3, 8, 9, 10, 11, 12, 12, 14, 15],
    [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0],
    [0, 0, 2, 2, 4, 4, 6, 6, 8, 9, 8, 9, 12, 12, 12, 12],
    [0, 3, 6, 1, 4, 7, 2, 5, 8, 11, 14, 9, 12, 15, 10, 13],
];

pub struct BeatBreaker {
    clock: Clock,
    buf: [DelayLine; 2],
    order: [u8; 16],
    fade: f32,
    key: (u32, u32),
    dry: Smooth,
    wet: Smooth,
}

impl BeatBreaker {
    pub fn new(sr: f32, p: &Params) -> Self {
        // 60 BPM 한 마디(4초)까지 — 더 느리면 템포를 60 으로 보고 자른다 (인스턴스마다 메모리를 아낀다)
        let n = (sr * 4.1) as usize;
        let mut b = Self {
            clock: Clock::new(sr),
            buf: [DelayLine::new(n), DelayLine::new(n)],
            order: PATTERNS[0],
            fade: 64.0,
            key: (99, 0),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        };
        b.set_params(p);
        b
    }
}

impl Effect for BeatBreaker {
    fn transport(&mut self, position: f64, bpm: f32) {
        self.clock.pos = position;
        self.clock.bpm = bpm.max(60.0);
    }

    fn set_params(&mut self, p: &Params) {
        let pat = p[0].clamp(0.0, 4.0).round() as u32;
        let seed = p[1].clamp(0.0, 999.0) as u32;
        if (pat, seed) != self.key {
            self.key = (pat, seed);
            self.order = if pat < 4 {
                PATTERNS[pat as usize]
            } else {
                let mut rng = Rng::new(seed.wrapping_mul(2654435761).wrapping_add(1));
                std::array::from_fn(|k| {
                    if rng.unit() < 0.4 {
                        (rng.next_u32() % 16) as u8
                    } else {
                        k as u8
                    }
                })
            };
        }
        self.fade = (p[2].clamp(0.5, 20.0) * 0.001 * self.clock.sr).max(1.0);
        let (d, w) = equal_power(p[3]);
        self.dry.set(d);
        self.wet.set(w);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let bar = self.clock.samples_per_beat() * 4.0;
        let slice = bar / 16.0;
        for i in 0..l.len() {
            self.buf[0].push(l[i]);
            self.buf[1].push(r[i]);
            let beats = self.clock.beats(i);
            let in_bar = (beats.rem_euclid(4.0) / 4.0) as f32 * bar;
            let k = ((in_bar / slice) as usize).min(15);
            let within = in_bar - k as f32 * slice;
            // 지금 마디의 이 자리 = 지난 마디의 같은 자리(지연 bar). 다른 조각을 쓰려면 그만큼 더한다
            let src = self.order[k] as f32;
            let d = bar + (k as f32 - src) * slice;
            let edge = (within / self.fade)
                .min((slice - within) / self.fade)
                .clamp(0.0, 1.0);
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            for (c, out) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                let y = self.buf[c].read(d.max(1.0)) * edge;
                *out = *out * dg + y * wg;
            }
        }
        self.clock.pos += l.len() as f64;
    }
}

// ---------------------------------------------------------------------------
// 스터터 — 켜는 순간 한 칸(박 나누기)을 붙잡아 계속 되풀이한다. 되풀이마다 조금씩 작게(감쇠).
// 오토메이션으로 켜고 끈다.
// 파라미터: 0 켜기(0/1) · 1 칸 길이 · 2 되풀이 감쇠(0 그대로..1 빨리 사라짐) · 3 섞기
// ---------------------------------------------------------------------------

pub struct Stutter {
    clock: Clock,
    buf: [DelayLine; 2],
    on: bool,
    held: bool,
    div: f32,
    decay: f32,
    /// 붙잡은 뒤 지난 샘플 (버퍼는 붙잡는 동안 쓰지 않는다 — 그래서 붙잡은 칸이 덮이지 않는다)
    t: f32,
    len: f32,
    gain: f32,
    mix: Smooth,
}

impl Stutter {
    pub fn new(sr: f32, p: &Params) -> Self {
        let n = (sr * 3.1) as usize;
        let mut s = Self {
            clock: Clock::new(sr),
            buf: [DelayLine::new(n), DelayLine::new(n)],
            on: false,
            held: false,
            div: 0.25,
            decay: 0.0,
            t: 0.0,
            len: 1.0,
            gain: 1.0,
            mix: Smooth::new(5.0, sr),
        };
        s.set_params(p);
        s
    }
}

impl Effect for Stutter {
    fn transport(&mut self, position: f64, bpm: f32) {
        self.clock.pos = position;
        self.clock.bpm = bpm;
    }

    fn set_params(&mut self, p: &Params) {
        self.on = p[0] >= 0.5;
        self.div = division(p[1]);
        self.decay = p[2].clamp(0.0, 1.0);
        self.mix
            .set(if self.on { p[3].clamp(0.0, 1.0) } else { 0.0 });
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            if self.on && !self.held {
                // 붙잡기 시작 — 방금 지난 한 칸을 되풀이 재료로
                self.held = true;
                self.len = (self.clock.samples_per_beat() * self.div)
                    .clamp(64.0, self.buf[0].capacity() as f32 - 8.0);
                self.t = 0.0;
                self.gain = 1.0;
            } else if !self.on && self.held && self.mix.value() < 1e-3 {
                self.held = false;
            }
            if !self.held {
                self.buf[0].push(l[i]);
                self.buf[1].push(r[i]);
            }
            let m = self.mix.tick();
            if self.held {
                let pos = self.t % self.len;
                if pos < 1.0 && self.t >= 1.0 {
                    self.gain *= 1.0 - 0.5 * self.decay;
                }
                self.t += 1.0;
                // 버퍼가 멈춰 있으니 칸의 시작은 언제나 지연 len — 칸 안 위치만큼 앞으로 읽는다
                let d = (self.len - pos).max(1.0);
                let edge = (pos / 32.0).min((self.len - pos) / 32.0).clamp(0.0, 1.0);
                for (c, out) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                    let y = self.buf[c].read(d) * edge * self.gain;
                    *out = *out * (1.0 - m) + y * m;
                }
            }
        }
        self.clock.pos += l.len() as f64;
    }
}

// ---------------------------------------------------------------------------
// 테이프 스톱 — 켜면 테이프가 멈추듯 속도(=음정)가 0 으로 내려가고, 끄면 다시 돌아 올라온다.
// 파라미터: 0 멈춤(0/1) · 1 멈추는 시간 ms · 2 다시 도는 시간 ms · 3 곡선(0 직선..1 지수)
// 미터: 0 지금 속도(0..1)
// ---------------------------------------------------------------------------

pub struct TapeStop {
    sr: f32,
    buf: [DelayLine; 2],
    stop: bool,
    stop_ms: f32,
    start_ms: f32,
    curve: f32,
    speed: f32,
    delay: f32,
}

impl TapeStop {
    pub fn new(sr: f32, p: &Params) -> Self {
        let n = (sr * 5.0) as usize;
        let mut t = Self {
            sr,
            buf: [DelayLine::new(n), DelayLine::new(n)],
            stop: false,
            stop_ms: 800.0,
            start_ms: 300.0,
            curve: 0.5,
            speed: 1.0,
            delay: 1.0,
        };
        t.set_params(p);
        t
    }
}

impl Effect for TapeStop {
    fn set_params(&mut self, p: &Params) {
        self.stop = p[0] >= 0.5;
        self.stop_ms = p[1].clamp(50.0, 4000.0);
        self.start_ms = p[2].clamp(20.0, 4000.0);
        self.curve = p[3].clamp(0.0, 1.0);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let cap = self.buf[0].capacity() as f32 - 4.0;
        for i in 0..l.len() {
            self.buf[0].push(l[i]);
            self.buf[1].push(r[i]);
            let (target, ms) = if self.stop {
                (0.0, self.stop_ms)
            } else {
                (1.0, self.start_ms)
            };
            let step = 1.0 / (ms * 0.001 * self.sr);
            // 직선과 지수를 곡선 손잡이로 섞는다
            let lin = if target > self.speed {
                (self.speed + step).min(1.0)
            } else {
                (self.speed - step).max(0.0)
            };
            let exp = target + (self.speed - target) * (1.0 - step * 4.0).max(0.0);
            self.speed = lin * (1.0 - self.curve) + exp * self.curve;
            // 느리게 읽는 만큼 지연이 쌓인다. 다시 돌 때 쌓인 지연을 따라잡지 않고 곧장 실시간으로 — 정지에서
            // 완전히 돌아오면 지연을 0 으로 (테이프를 다시 거는 순간)
            self.delay = (self.delay + 1.0 - self.speed).min(cap);
            if !self.stop && self.speed > 0.999 {
                self.delay = (self.delay - 4.0).max(1.0);
            }
            let fade = self.speed.min(1.0).sqrt();
            l[i] = self.buf[0].read(self.delay) * fade;
            r[i] = self.buf[1].read(self.delay) * fade;
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.speed;
    }
}

// ---------------------------------------------------------------------------
// 팻 FX (Logic Phat FX) — 저역 보강 → 드라이브(4배) → 스퀴즈(빠른 컴프) → 필터(엔벨로프·박자 LFO) 한 줄.
// 파라미터: 0 저역 보강 dB · 1 드라이브 0..1 · 2 스퀴즈 0..1 · 3 차단 Hz · 4 공명 · 5 엔벨로프 양(옥타브) ·
//           6 LFO 칸 · 7 LFO 깊이(옥타브) · 8 섞기 · 9 출력 dB
// ---------------------------------------------------------------------------

pub struct PhatFx {
    clock: Clock,
    bass: [crate::blocks::biquad::Biquad; 2],
    bass_db: f32,
    drive: Smooth,
    os: [Oversampler; 2],
    squeeze: f32,
    det: Follower,
    env: Follower,
    f: [Svf; 2],
    cutoff: Smooth,
    q: f32,
    env_amt: f32,
    lfo_div: f32,
    lfo_depth: f32,
    dly: [DelayLine; 2],
    dry: Smooth,
    wet: Smooth,
    out: Smooth,
    n: usize,
}

impl PhatFx {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut det = Follower::new(sr);
        det.set_times(1.0, 60.0, sr);
        let mut env = Follower::new(sr);
        env.set_times(3.0, 150.0, sr);
        let mut x = Self {
            clock: Clock::new(sr),
            bass: [crate::blocks::biquad::Biquad::default(); 2],
            bass_db: f32::NAN,
            drive: Smooth::new(20.0, sr),
            os: [Oversampler::new(), Oversampler::new()],
            squeeze: 0.0,
            det,
            env,
            f: [Svf::default(); 2],
            cutoff: Smooth::new(20.0, sr),
            q: 1.0,
            env_amt: 0.0,
            lfo_div: 1.0,
            lfo_depth: 0.0,
            dly: [DelayLine::new(64), DelayLine::new(64)],
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            out: Smooth::new(20.0, sr),
            n: 0,
        };
        x.set_params(p);
        x
    }
}

impl Effect for PhatFx {
    fn transport(&mut self, position: f64, bpm: f32) {
        self.clock.pos = position;
        self.clock.bpm = bpm;
    }

    fn set_params(&mut self, p: &Params) {
        let b = p[0].clamp(0.0, 12.0);
        if b != self.bass_db {
            self.bass_db = b;
            use crate::blocks::biquad::{Coefs, Kind};
            let c = Coefs::new(Kind::LowShelf, 90.0, 0.7, b as f64, self.clock.sr as f64);
            for f in &mut self.bass {
                f.set(c);
            }
        }
        self.drive.set(p[1].clamp(0.0, 1.0));
        self.squeeze = p[2].clamp(0.0, 1.0);
        self.cutoff.set(p[3].clamp(40.0, 20000.0).ln());
        self.q = p[4].clamp(0.5, 15.0);
        self.env_amt = p[5].clamp(-4.0, 6.0);
        self.lfo_div = division(p[6]);
        self.lfo_depth = p[7].clamp(0.0, 5.0);
        let (d, w) = equal_power(p[8]);
        self.dry.set(d);
        self.wet.set(w);
        self.out.set(db_to_gain(p[9].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let sr = self.clock.sr;
        for i in 0..l.len() {
            let x = [l[i], r[i]];
            let dr = self.drive.tick();
            let g = 1.0 + 30.0 * dr * dr;
            let norm = 1.0 / g.sqrt();
            let mut y = [0f32; 2];
            for c in 0..2 {
                let b = self.bass[c].tick(x[c]);
                y[c] = oversample::process(&mut self.os[c], b, |s| {
                    if dr > 0.0 {
                        (s * g).tanh() * norm
                    } else {
                        s
                    }
                });
            }
            // 스퀴즈: −30dB 위를 강하게 누르고 그만큼 올린다
            let lvl = self.det.tick(y[0].abs().max(y[1].abs()));
            let over = (lvl + 30.0).max(0.0);
            let sq = db_to_gain(-over * 0.8 * self.squeeze + 12.0 * self.squeeze * 0.5);
            let e = ((self.env.tick(x[0].abs().max(x[1].abs())) + 40.0) / 40.0).clamp(0.0, 1.0);
            let base = self.cutoff.tick().exp();
            if self.n.is_multiple_of(16) {
                let lfo = value(
                    Shape::Sine,
                    (self.clock.beats(i) / self.lfo_div as f64).fract() as f32,
                );
                let hz = (base * 2f32.powf(self.env_amt * e + self.lfo_depth * 0.5 * lfo))
                    .clamp(30.0, sr * 0.45);
                for f in &mut self.f {
                    f.set(hz, self.q, sr);
                }
            }
            self.n += 1;
            let (d, w, o) = (self.dry.tick(), self.wet.tick(), self.out.tick());
            for (c, out) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                let fy = self.f[c].tick(y[c] * sq).low;
                self.dly[c].push(x[c]);
                *out = (self.dly[c].tap(oversample::LATENCY) * d + fy * w) * o;
            }
        }
        self.clock.pos += l.len() as f64;
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 페달보드 (Logic Pedalboard) — 페달 여섯 자리, 자리마다 종류 + 손잡이 하나. 페달은 이미 있는
// 이펙트를 그대로 쓴다(같은 소리). 지연은 자리마다 16 으로 고정 — 드라이브 페달이 아닌 자리는
// 그만큼 늦춰 맞춘다(종류를 바꿔도 전체 지연이 변하지 않아 지연 보정이 흔들리지 않는다).
// 파라미터: 자리 k(0..6) 마다 2k 종류 · 2k+1 양 · 12 출력 dB
// ---------------------------------------------------------------------------

pub const PEDAL_SLOTS: usize = 6;
const PEDAL_LATENCY: usize = oversample::LATENCY;

/// (Rust 이펙트 이름, 기본 파라미터, 손잡이가 움직이는 파라미터 번호, 그 범위)
type PedalSpec = (&'static str, Vec<f32>, usize, (f32, f32));

fn pedal_spec(kind: u32) -> Option<PedalSpec> {
    Some(match kind {
        1 => ("overdrive", vec![18.0, 4000.0, 1.0, -6.0], 0, (0.0, 40.0)),
        2 => ("fuzz", vec![0.6, 0.0, 3000.0, 1.0, -10.0], 0, (0.0, 1.0)),
        3 => (
            "ensemble",
            vec![3.0, 0.6, 4.0, 12.0, 0.9, 0.5],
            5,
            (0.0, 1.0),
        ),
        4 => (
            "phaser12",
            vec![1.0, 0.3, 2.5, 900.0, 0.4, 90.0, 0.5],
            1,
            (0.05, 4.0),
        ),
        5 => (
            "moddelay",
            vec![3.0, 2.0, 0.3, 0.6, 1.0, 90.0, 0.5],
            3,
            (0.0, 0.9),
        ),
        6 => ("autopan", vec![5.0, 0.7, 0.0], 1, (0.0, 1.0)),
        7 => (
            "stereodelay",
            vec![375.0, 375.0, 0.35, 0.0, 0.3, 80.0, 6000.0],
            4,
            (0.0, 0.8),
        ),
        8 => ("fuzzwah", vec![0.4, 0.0, 6.0, 0.0, 0.0, 0.0], 0, (0.0, 1.0)),
        9 => (
            "compmodel",
            vec![2.0, -24.0, 4.0, 3.0, 120.0, 3.0, 0.0, 1.0, 1.0, 20.0, 0.0],
            1,
            (0.0, -48.0),
        ),
        10 => ("bitcrusher", vec![8.0, 4.0, 0.0, 1.0, 0.0], 0, (16.0, 2.0)),
        _ => return None,
    })
}

struct Pedal {
    kind: u32,
    fx: Option<Box<dyn Effect>>,
    params: Params,
    knob: usize,
    range: (f32, f32),
    pad: [DelayLine; 2],
    pad_n: usize,
}

impl Pedal {
    fn empty() -> Self {
        Self {
            kind: 0,
            fx: None,
            params: [0.0; 24],
            knob: 0,
            range: (0.0, 1.0),
            pad: [DelayLine::new(32), DelayLine::new(32)],
            pad_n: PEDAL_LATENCY,
        }
    }
}

pub struct Pedalboard {
    sr: f32,
    slots: Vec<Pedal>,
    out: Smooth,
}

impl Pedalboard {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut b = Self {
            sr,
            slots: (0..PEDAL_SLOTS).map(|_| Pedal::empty()).collect(),
            out: Smooth::new(20.0, sr),
        };
        b.set_params(p);
        b
    }
}

impl Effect for Pedalboard {
    fn transport(&mut self, position: f64, bpm: f32) {
        for s in &mut self.slots {
            if let Some(fx) = s.fx.as_mut() {
                fx.transport(position, bpm);
            }
        }
    }

    fn set_params(&mut self, p: &Params) {
        for (k, slot) in self.slots.iter_mut().enumerate() {
            let kind = p[2 * k].clamp(0.0, 10.0).round() as u32;
            let amount = p[2 * k + 1].clamp(0.0, 1.0);
            if kind != slot.kind {
                slot.kind = kind;
                slot.fx = None;
                slot.pad_n = PEDAL_LATENCY;
                if let Some((name, defaults, knob, range)) = pedal_spec(kind) {
                    let mut params = [0.0; 24];
                    params[..defaults.len()].copy_from_slice(&defaults);
                    params[knob] = range.0 + (range.1 - range.0) * amount;
                    let index = KINDS.iter().position(|(n, _)| *n == name);
                    slot.fx = index.and_then(|i| create(i, self.sr, &params));
                    slot.params = params;
                    slot.knob = knob;
                    slot.range = range;
                    slot.pad_n =
                        PEDAL_LATENCY.saturating_sub(slot.fx.as_ref().map_or(0, |f| f.latency()));
                }
            }
            slot.params[slot.knob] = slot.range.0 + (slot.range.1 - slot.range.0) * amount;
        }
        self.out.set(db_to_gain(p[12].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for slot in &mut self.slots {
            if let Some(fx) = slot.fx.as_mut() {
                fx.set_params(&slot.params);
                fx.process(l, r);
            }
            if slot.pad_n > 0 {
                for i in 0..l.len() {
                    slot.pad[0].push(l[i]);
                    slot.pad[1].push(r[i]);
                    l[i] = slot.pad[0].tap(slot.pad_n);
                    r[i] = slot.pad[1].tap(slot.pad_n);
                }
            }
        }
        for i in 0..l.len() {
            let o = self.out.tick();
            l[i] *= o;
            r[i] *= o;
        }
    }

    fn latency(&self) -> usize {
        PEDAL_LATENCY * PEDAL_SLOTS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    #[test]
    fn trance_gate_follows_pattern_from_song_position() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        for k in 0..16 {
            p[k] = if k % 2 == 0 { 1.0 } else { 0.0 };
        }
        p[16] = 4.0; // 1/16
        p[17] = 0.2;
        p[19] = 1.0;
        p[20] = 1.0;
        let mut g = TranceGate::new(sr, &p);
        // 120 BPM: 1/16 = 6000 샘플. 곡 위치를 두 번째 칸(꺼짐) 한가운데에서 시작
        g.transport(9000.0, 120.0);
        let x = vec![0.5; 6000];
        let (l, _) = run(&mut g, &p, &x, &x);
        assert!(l[2000] < 0.01, "꺼진 칸 {}", l[2000]);
        assert!(l[5000] > 0.45, "다음 칸(켜짐) {}", l[5000]);
    }

    #[test]
    fn beat_breaker_reorders_previous_bar() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 1.0; // 앞 반은 그대로, 뒤 반은 거꾸로
        p[2] = 0.5;
        p[3] = 1.0;
        let mut b = BeatBreaker::new(sr, &p);
        b.transport(0.0, 120.0);
        // 마디 = 96000 샘플. 조각마다 다른 직류 값
        let x: Vec<f32> = (0..192000)
            .map(|n| ((n / 6000) % 16) as f32 * 0.05)
            .collect();
        let (l, _) = run(&mut b, &p, &x, &x);
        // 둘째 마디의 9번째 조각(k=8) ← 지난 마디 조각 7
        let at = 96000 + 8 * 6000 + 3000;
        assert!((l[at] - 7.0 * 0.05).abs() < 0.01, "{}", l[at]);
    }

    #[test]
    fn stutter_repeats_slice() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[1] = 4.0; // 1/16 = 6000
        p[3] = 1.0;
        let mut s = Stutter::new(sr, &p);
        s.transport(0.0, 120.0);
        let ramp: Vec<f32> = (0..24000).map(|n| (n % 24000) as f32 / 24000.0).collect();
        run(&mut s, &p, &ramp, &ramp);
        p[0] = 1.0;
        let (l, _) = run(&mut s, &p, &ramp[..18000], &ramp[..18000]);
        // 되풀이: 6000 마다 같은 값
        for k in [1000usize, 2500, 4000] {
            assert!(
                (l[k] - l[k + 6000]).abs() < 0.02,
                "{k}: {} vs {}",
                l[k],
                l[k + 6000]
            );
        }
    }

    #[test]
    fn tape_stop_slows_to_silence_and_recovers() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[1] = 300.0;
        p[2] = 100.0;
        p[3] = 0.0;
        let mut t = TapeStop::new(sr, &p);
        let x = sine(440.0, sr, 24000, 0.5);
        run(&mut t, &p, &x, &x);
        p[0] = 1.0;
        let (l, _) = run(&mut t, &p, &x, &x);
        assert!(peak(&l[18000..]) < 0.01, "멈췄다 {}", peak(&l[18000..]));
        p[0] = 0.0;
        let (l, _) = run(&mut t, &p, &x, &x);
        assert!(peak(&l[18000..]) > 0.4, "다시 돈다");
    }

    #[test]
    fn pedalboard_latency_is_constant() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[12] = 0.0;
        let mut b = Pedalboard::new(sr, &p);
        let mut imp = vec![0.0; 512];
        imp[5] = 1.0;
        let (l, _) = run(&mut b, &p, &imp, &imp);
        assert_eq!(
            l.iter().position(|v| *v > 0.5),
            Some(5 + b.latency()),
            "빈 페달보드도 같은 지연"
        );
        // 오버드라이브 + 코러스 — 유한하고 소리가 난다
        p[0] = 1.0;
        p[1] = 0.5;
        p[2] = 3.0;
        p[3] = 0.5;
        let mut b = Pedalboard::new(sr, &p);
        let x = sine(196.0, sr, 24000, 0.5);
        let (y, _) = run(&mut b, &p, &x, &x);
        assert!(y.iter().all(|v| v.is_finite()) && rms(&y[12000..]) > 0.05);
    }

    #[test]
    fn remix_and_phat_and_step_bounded() {
        let sr = 48000.0;
        let x = sine(110.0, sr, 48000, 0.5);
        let mut p = [0.0; 24];
        p[0] = -0.6;
        p[1] = 4.0;
        p[2] = 4.0;
        p[3] = 0.8;
        p[4] = 0.5;
        p[5] = 1.0;
        p[6] = 1.0;
        let mut rf = RemixFx::new(sr, &p);
        let (l, _) = run(&mut rf, &p, &x, &x);
        assert!(l.iter().all(|v| v.is_finite()) && peak(&l) < 4.0);
        let mut p = [0.0; 24];
        p[0] = 6.0;
        p[1] = 0.7;
        p[2] = 0.5;
        p[3] = 800.0;
        p[4] = 4.0;
        p[5] = 2.0;
        p[6] = 3.0;
        p[7] = 2.0;
        p[8] = 1.0;
        let mut ph = PhatFx::new(sr, &p);
        let (l, _) = run(&mut ph, &p, &x, &x);
        assert!(l.iter().all(|v| v.is_finite()) && peak(&l) < 4.0);
        let mut p = [0.0; 24];
        for k in 0..8 {
            p[k] = k as f32 / 7.0;
            p[8 + k] = 1.0;
        }
        p[16] = 4.0;
        p[17] = 2.0;
        p[18] = 200.0;
        p[19] = 8000.0;
        p[20] = 5.0;
        p[21] = 0.5;
        p[22] = 1.0;
        let mut st = StepFx::new(sr, &p);
        let (l, _) = run(&mut st, &p, &x, &x);
        assert!(l.iter().all(|v| v.is_finite()) && peak(&l) < 4.0);
    }
}

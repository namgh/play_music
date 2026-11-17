//! 리버브 (4단계) — 크로마버브(FDN, 공간 종류) · 플레이트(다토로) · 스프링 · 룸 · 게이트 리버브 ·
//! 쉬머 · 엔버브(모양을 그리는 리버브).

use super::{Effect, Meters, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind, OnePole};
use crate::blocks::conv::Convolver;
use crate::blocks::delay::DelayLine;
use crate::blocks::env::Follower;
use crate::blocks::fdn::{Diffuser, Fdn};
use crate::blocks::lfo::{Lfo, Shape};
use crate::blocks::pitch::PitchShifter;
use crate::blocks::rng::Rng;
use crate::blocks::smooth::Smooth;
use crate::blocks::{flush, time_coef};

fn equal_power(mix: f32) -> (f32, f32) {
    let m = mix.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    (m.cos(), m.sin())
}

/// 리버브 공통 출구: 웨트 로우컷·폭(미드/사이드)·드라이/웨트
struct Out {
    lc: [Biquad; 2],
    lc_hz: f32,
    width: Smooth,
    dry: Smooth,
    wet: Smooth,
}

impl Out {
    fn new(sr: f32) -> Self {
        Self {
            lc: [Biquad::default(); 2],
            lc_hz: -1.0,
            width: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
        }
    }
    fn set(&mut self, sr: f32, lowcut: f32, width: f32, mix: f32) {
        let lc = lowcut.clamp(20.0, 1000.0);
        if lc != self.lc_hz {
            self.lc_hz = lc;
            let c = Coefs::new(Kind::HighPass, lc as f64, 0.707, 0.0, sr as f64);
            self.lc = [Biquad::new(c); 2];
        }
        self.width.set(width.clamp(0.0, 1.5));
        let (d, w) = equal_power(mix);
        self.dry.set(d);
        self.wet.set(w);
    }
    #[inline(always)]
    fn mix(&mut self, xl: f32, xr: f32, wl: f32, wr: f32) -> (f32, f32) {
        let (wl, wr) = (self.lc[0].tick(wl), self.lc[1].tick(wr));
        let w = self.width.tick();
        let m = 0.5 * (wl + wr);
        let s = 0.5 * (wl - wr) * w;
        let (dg, wg) = (self.dry.tick(), self.wet.tick());
        (xl * dg + (m + s) * wg, xr * dg + (m - s) * wg)
    }
}

// ---------------------------------------------------------------------------
// 크로마버브 (Logic ChromaVerb) — FDN 에 공간 종류별 크기·확산·흔들림.
// 파라미터: 0 공간 · 1 길이(RT60 s) · 2 크기 배율 · 3 프리딜레이 ms · 4 고역 감쇠(고역 RT 비율) ·
//           5 흔들림 · 6 확산 · 7 로우컷 Hz · 8 폭 · 9 섞기 · 10 얼리기(0/1)
// ---------------------------------------------------------------------------

/// (크기 배율, 확산 길이 배율, 흔들림 ms)
const SPACES: [(f32, f32, f32); 7] = [
    (0.5, 0.6, 0.15), // 방
    (0.8, 1.0, 0.25), // 체임버
    (1.3, 1.3, 0.35), // 콘서트 홀
    (2.2, 1.6, 0.45), // 성당
    (1.0, 0.8, 1.2),  // 신스 홀 (흔들림 많이)
    (0.7, 1.8, 0.2),  // 빽빽한 방
    (1.6, 1.1, 0.8),  // 부드러운 공간
];

pub struct ChromaVerb {
    sr: f32,
    fdn: Fdn,
    diff_l: [Diffuser; 4],
    diff_r: [Diffuser; 4],
    pre_l: DelayLine,
    pre_r: DelayLine,
    pre: Smooth,
    key: [i32; 7],
    out: Out,
}

impl ChromaVerb {
    pub fn new(sr: f32, p: &Params) -> Self {
        let d = |ms: f32| Diffuser::new(ms * 0.001 * sr * 2.0, 0.6);
        let mut c = Self {
            sr,
            fdn: Fdn::new(sr),
            diff_l: [d(4.7), d(3.6), d(12.7), d(9.3)],
            diff_r: [d(5.1), d(3.3), d(11.9), d(8.7)],
            pre_l: DelayLine::new((0.26 * sr) as usize),
            pre_r: DelayLine::new((0.26 * sr) as usize),
            pre: Smooth::new(50.0, sr),
            key: [i32::MIN; 7],
            out: Out::new(sr),
        };
        c.set_params(p);
        c
    }
}

impl Effect for ChromaVerb {
    fn set_params(&mut self, p: &Params) {
        let space = p[0].clamp(0.0, 6.0).round() as usize;
        let key = [
            space as i32,
            (p[1] * 100.0) as i32,
            (p[2] * 100.0) as i32,
            (p[4] * 100.0) as i32,
            (p[5] * 100.0) as i32,
            (p[6] * 100.0) as i32,
            (p[10] >= 0.5) as i32,
        ];
        if key != self.key {
            self.key = key;
            let (size, dscale, modms) = SPACES[space];
            let size = size * p[2].clamp(0.3, 2.0);
            self.fdn.configure(
                size,
                p[1].clamp(0.1, 30.0),
                p[4].clamp(0.05, 1.0),
                modms * p[5].clamp(0.0, 2.0),
                p[10] >= 0.5,
            );
            let g = 0.4 + 0.35 * p[6].clamp(0.0, 1.0);
            for (k, ms) in [4.7f32, 3.6, 12.7, 9.3].iter().enumerate() {
                self.diff_l[k].set(ms * dscale * 0.001 * self.sr, g);
                self.diff_r[k].set(ms * 1.07 * dscale * 0.001 * self.sr, g);
            }
        }
        self.pre.set(p[3].clamp(0.0, 250.0) * 0.001 * self.sr);
        self.out.set(self.sr, p[7], p[8], p[9]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            self.pre_l.push(l[i]);
            self.pre_r.push(r[i]);
            let d = self.pre.tick().max(1.0);
            let mut a = self.pre_l.read(d);
            let mut b = self.pre_r.read(d);
            for k in 0..4 {
                a = self.diff_l[k].tick(a);
                b = self.diff_r[k].tick(b);
            }
            let (wl, wr) = self.fdn.tick(a, b);
            (l[i], r[i]) = self.out.mix(l[i], r[i], wl, wr);
        }
    }
}

// ---------------------------------------------------------------------------
// 플레이트 (다토로 1997 의 판 리버브 구조) — 입력 확산 4 → 두 갈래 고리(흔들리는 올패스·지연·감쇠).
// 원래 29761Hz 기준 길이를 샘플레이트에 맞춰 늘린다.
// 파라미터: 0 길이(감쇠 0..0.99) · 1 프리딜레이 ms · 2 입력 대역(고역 Hz) · 3 감쇠(고역) Hz ·
//           4 로우컷 Hz · 5 폭 · 6 섞기
// ---------------------------------------------------------------------------

pub struct Plate {
    sr: f32,
    scale: f32,
    pre: DelayLine,
    pre_ms: Smooth,
    bw: OnePole,
    input: [Diffuser; 4],
    // 고리 두 갈래: [흔들 올패스, 지연, 감쇠, 올패스, 지연]
    ap1: [Diffuser; 2],
    d1: [DelayLine; 2],
    damp: [OnePole; 2],
    ap2: [Diffuser; 2],
    d2: [DelayLine; 2],
    len: [[f32; 4]; 2],
    decay: Smooth,
    lfo: Lfo,
    fb: [f32; 2],
    out: Out,
}

const DAT: f32 = 29761.0;

impl Plate {
    pub fn new(sr: f32, p: &Params) -> Self {
        let s = sr / DAT;
        let ap = |n: f32, g: f32| Diffuser::new(n * s, g);
        let dl = |n: f32| DelayLine::new((n * s) as usize + 64);
        let mut pl = Self {
            sr,
            scale: s,
            pre: DelayLine::new((0.26 * sr) as usize),
            pre_ms: Smooth::new(50.0, sr),
            bw: OnePole::default(),
            input: [
                ap(142.0, 0.75),
                ap(107.0, 0.75),
                ap(379.0, 0.625),
                ap(277.0, 0.625),
            ],
            ap1: [ap(672.0, -0.7), ap(908.0, -0.7)],
            d1: [dl(4453.0), dl(4217.0)],
            damp: [OnePole::default(); 2],
            ap2: [ap(1800.0, 0.5), ap(2656.0, 0.5)],
            d2: [dl(3720.0), dl(3163.0)],
            len: [
                [672.0 * s, 4453.0 * s, 1800.0 * s, 3720.0 * s],
                [908.0 * s, 4217.0 * s, 2656.0 * s, 3163.0 * s],
            ],
            decay: Smooth::new(50.0, sr),
            lfo: Lfo::new(0.0),
            fb: [0.0; 2],
            out: Out::new(sr),
        };
        pl.lfo.set_rate(1.0, sr);
        pl.set_params(p);
        pl
    }
}

impl Effect for Plate {
    fn set_params(&mut self, p: &Params) {
        self.decay.set(p[0].clamp(0.0, 0.97));
        self.pre_ms.set(p[1].clamp(0.0, 250.0) * 0.001 * self.sr);
        self.bw.set_freq(p[2].clamp(1000.0, 20000.0), self.sr);
        for d in &mut self.damp {
            d.set_freq(p[3].clamp(500.0, 20000.0), self.sr);
        }
        self.out.set(self.sr, p[4], p[5], p[6]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let s = self.scale;
        let excursion = 16.0 * s;
        for i in 0..l.len() {
            self.pre.push(0.5 * (l[i] + r[i]));
            let d = self.pre_ms.tick().max(1.0);
            let mut x = self.bw.lp(self.pre.read(d));
            for a in &mut self.input {
                x = a.tick(x);
            }
            let decay = self.decay.tick();
            let m = self.lfo.tick(Shape::Sine) * excursion;
            for k in 0..2 {
                // 고리: 입력 + 반대 갈래 끝 × 감쇠
                let mut v = x + self.fb[1 - k] * decay;
                self.ap1[k].set(self.len[k][0] + if k == 0 { m } else { -m }, -0.7);
                v = self.ap1[k].tick(v);
                self.d1[k].push(v);
                v = self.d1[k].read(self.len[k][1]);
                v = self.damp[k].lp(v) * decay;
                v = self.ap2[k].tick(v);
                self.d2[k].push(v);
                self.fb[k] = flush(self.d2[k].read(self.len[k][3]));
            }
            // 출력 탭 (논문 표 2 의 자리, 샘플레이트 비율로)
            let t = |n: f32| (n * s) as usize;
            let wl = self.d1[0].tap(t(266.0)) + self.d1[0].tap(t(2974.0))
                - self.ap2[0].tap(t(1913.0))
                + self.d2[0].tap(t(1996.0))
                - self.d1[1].tap(t(1990.0))
                - self.ap2[1].tap(t(187.0))
                - self.d2[1].tap(t(1066.0));
            let wr = self.d1[1].tap(t(353.0)) + self.d1[1].tap(t(3627.0))
                - self.ap2[1].tap(t(1228.0))
                + self.d2[1].tap(t(2673.0))
                - self.d1[0].tap(t(2111.0))
                - self.ap2[0].tap(t(335.0))
                - self.d2[0].tap(t(121.0));
            (l[i], r[i]) = self.out.mix(l[i], r[i], wl * 0.6, wr * 0.6);
        }
    }
}

// ---------------------------------------------------------------------------
// 스프링 리버브 — 1차 올패스 수십 단(분산: 저역이 늦게 도착해 "뾰옹" 하고 휜다) + 지연 고리.
// 스프링 두 개(길이가 다른)를 좌우에.
// 파라미터: 0 장력(고리 길이 ms) · 1 감쇠(되먹임) · 2 분산 0..1 · 3 톤 Hz · 4 드립(입력 세기) · 5 섞기
// ---------------------------------------------------------------------------

const SPRING_STAGES: usize = 40;

struct Spring {
    ap: [f32; SPRING_STAGES],
    loop_line: DelayLine,
    len: f32,
    tone: OnePole,
    hp: OnePole,
    y: f32,
}

impl Spring {
    fn new(sr: f32) -> Self {
        Self {
            ap: [0.0; SPRING_STAGES],
            loop_line: DelayLine::new((0.12 * sr) as usize),
            len: 1000.0,
            tone: OnePole::default(),
            hp: OnePole::lowpass(80.0, sr),
            y: 0.0,
        }
    }
    #[inline]
    fn tick(&mut self, x: f32, a: f32, fb: f32) -> f32 {
        let mut v = x + self.y * fb;
        // 1차 올패스 연속 — 상태 하나씩 (직접형): y = a·v + s, s' = v − a·y
        for s in &mut self.ap {
            let y = a * v + *s;
            *s = flush(v - a * y);
            v = y;
        }
        self.loop_line.push(v);
        let out = self.loop_line.read(self.len);
        self.y = self.hp.hp(self.tone.lp(out));
        self.y
    }
}

pub struct SpringReverb {
    sr: f32,
    springs: [Spring; 2],
    a: f32,
    fb: f32,
    drip: Smooth,
    out: Out,
}

impl SpringReverb {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut s = Self {
            sr,
            springs: [Spring::new(sr), Spring::new(sr)],
            a: 0.6,
            fb: 0.7,
            drip: Smooth::new(20.0, sr),
            out: Out::new(sr),
        };
        s.set_params(p);
        s
    }
}

impl Effect for SpringReverb {
    fn set_params(&mut self, p: &Params) {
        let ms = p[0].clamp(15.0, 100.0);
        self.springs[0].len = ms * 0.001 * self.sr;
        self.springs[1].len = ms * 1.23 * 0.001 * self.sr;
        self.fb = p[1].clamp(0.0, 0.92);
        self.a = 0.3 + 0.4 * p[2].clamp(0.0, 1.0);
        for s in &mut self.springs {
            s.tone.set_freq(p[3].clamp(1000.0, 8000.0), self.sr);
        }
        self.drip.set(p[4].clamp(0.0, 2.0));
        self.out.set(self.sr, 80.0, 1.0, p[5]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let x = 0.5 * (l[i] + r[i]) * self.drip.tick();
            let wl = self.springs[0].tick(x, self.a, self.fb);
            let wr = self.springs[1].tick(x, -self.a * 0.9, self.fb);
            (l[i], r[i]) = self.out.mix(l[i], r[i], wl, wr);
        }
    }
}

// ---------------------------------------------------------------------------
// 룸 — 초기 반사(벽 여섯 면에서 한 번 튄 소리)를 또렷하게 + 짧은 FDN 꼬리.
// 파라미터: 0 방 크기 m · 1 길이 s · 2 초기/꼬리 균형(0 꼬리..1 반사) · 3 고역 감쇠 · 4 프리딜레이 ms ·
//           5 폭 · 6 섞기
// ---------------------------------------------------------------------------

/// 반사 경로 길이 배율·좌우·크기 (방 크기 1m 기준 상대값)
const REFLECTIONS: [(f32, f32, f32); 10] = [
    (1.0, -0.8, 0.9),
    (1.2, 0.7, 0.85),
    (1.55, -0.3, 0.7),
    (1.7, 0.4, 0.68),
    (2.1, -0.9, 0.55),
    (2.35, 0.85, 0.5),
    (2.9, -0.1, 0.42),
    (3.3, 0.2, 0.36),
    (3.9, -0.6, 0.3),
    (4.4, 0.6, 0.25),
];

pub struct RoomReverb {
    sr: f32,
    er: DelayLine,
    taps: [(f32, f32, f32); 10],
    fdn: Fdn,
    pre: Smooth,
    balance: Smooth,
    key: [i32; 3],
    damp: [OnePole; 2],
    out: Out,
}

impl RoomReverb {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut r = Self {
            sr,
            er: DelayLine::new((0.5 * sr) as usize),
            taps: [(0.0, 0.0, 0.0); 10],
            fdn: Fdn::new(sr),
            pre: Smooth::new(50.0, sr),
            balance: Smooth::new(20.0, sr),
            key: [i32::MIN; 3],
            damp: [OnePole::default(); 2],
            out: Out::new(sr),
        };
        r.set_params(p);
        r
    }
}

impl Effect for RoomReverb {
    fn set_params(&mut self, p: &Params) {
        let size = p[0].clamp(2.0, 30.0);
        let key = [
            (size * 10.0) as i32,
            (p[1] * 100.0) as i32,
            (p[3] * 100.0) as i32,
        ];
        if key != self.key {
            self.key = key;
            // 소리 속도 343m/s — 크기 1m 당 약 2.9ms
            let per_m = self.sr / 343.0;
            for (k, (mult, pan, gain)) in REFLECTIONS.iter().enumerate() {
                self.taps[k] = (mult * size * per_m, *pan, *gain);
            }
            self.fdn.configure(
                size / 10.0,
                p[1].clamp(0.1, 5.0),
                p[3].clamp(0.05, 1.0),
                0.2,
                false,
            );
            for d in &mut self.damp {
                d.set_freq(2000.0 + 14000.0 * p[3].clamp(0.05, 1.0), self.sr);
            }
        }
        self.balance.set(p[2].clamp(0.0, 1.0));
        self.pre.set(p[4].clamp(0.0, 200.0) * 0.001 * self.sr);
        self.out.set(self.sr, 60.0, p[5], p[6]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let x = 0.5 * (l[i] + r[i]);
            self.er.push(x);
            let pre = self.pre.tick();
            let (mut el, mut erv) = (0.0, 0.0);
            for &(d, pan, g) in &self.taps {
                let s = self.er.read(d + pre + 1.0) * g;
                el += s * (1.0 - pan) * 0.5;
                erv += s * (1.0 + pan) * 0.5;
            }
            let el = self.damp[0].lp(el);
            let erv = self.damp[1].lp(erv);
            // 꼬리는 반사를 받아 시작한다 — 반사 없이 꼬리가 먼저 오는 방은 없다
            let (tl, tr) = self.fdn.tick(el * 0.5, erv * 0.5);
            let b = self.balance.tick();
            (l[i], r[i]) = self.out.mix(
                l[i],
                r[i],
                el * b + tl * (1.0 - b),
                erv * b + tr * (1.0 - b),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 게이트 리버브 (80년대 드럼) — 긴 꼬리를 크기로 여닫는다. 들어온 소리가 스레숄드를 넘으면 열고
// 홀드 뒤 빠르게 닫는다.
// 파라미터: 0 스레숄드 dB · 1 홀드 ms · 2 닫힘 ms · 3 크기 · 4 고역 감쇠 · 5 섞기
// 미터: 0 게이트 열림(0..1)
// ---------------------------------------------------------------------------

pub struct GatedReverb {
    sr: f32,
    fdn: Fdn,
    det: Follower,
    threshold: f32,
    hold: usize,
    held: usize,
    gain: f32,
    close: f32,
    key: [i32; 2],
    out: Out,
}

impl GatedReverb {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut det = Follower::new(sr);
        det.set_times(0.5, 30.0, sr);
        let mut g = Self {
            sr,
            fdn: Fdn::new(sr),
            det,
            threshold: -30.0,
            hold: 0,
            held: 0,
            gain: 0.0,
            close: 0.0,
            key: [i32::MIN; 2],
            out: Out::new(sr),
        };
        g.set_params(p);
        g
    }
}

impl Effect for GatedReverb {
    fn set_params(&mut self, p: &Params) {
        self.threshold = p[0].clamp(-60.0, 0.0);
        self.hold = (p[1].clamp(10.0, 1000.0) * 0.001 * self.sr) as usize;
        self.close = time_coef(p[2].clamp(1.0, 200.0), self.sr);
        let key = [(p[3] * 100.0) as i32, (p[4] * 100.0) as i32];
        if key != self.key {
            self.key = key;
            // 꼬리는 길게 — 게이트가 자른다
            self.fdn
                .configure(p[3].clamp(0.3, 2.0), 4.0, p[4].clamp(0.05, 1.0), 0.3, false);
        }
        self.out.set(self.sr, 100.0, 1.2, p[5]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let lvl = self.det.tick(l[i].abs().max(r[i].abs()));
            if lvl > self.threshold {
                self.held = self.hold;
            }
            let target = if self.held > 0 {
                self.held -= 1;
                1.0
            } else {
                0.0
            };
            // 열 때는 바로(1ms), 닫을 때는 설정대로
            let c = if target > self.gain { 0.98 } else { self.close };
            self.gain = target + (self.gain - target) * c;
            let (wl, wr) = self.fdn.tick(l[i], r[i]);
            (l[i], r[i]) = self.out.mix(l[i], r[i], wl * self.gain, wr * self.gain);
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.gain;
    }
}

// ---------------------------------------------------------------------------
// 쉬머 — 리버브 되먹임 안에서 한 옥타브(설정) 올린다. 반복될수록 위로 쌓여 반짝인다.
// 파라미터: 0 길이 s · 1 음정 반음 · 2 쉬머 양(되먹임 속 비율) · 3 고역 감쇠 · 4 섞기
// ---------------------------------------------------------------------------

pub struct Shimmer {
    sr: f32,
    fdn: Fdn,
    ps: [PitchShifter; 2],
    amount: Smooth,
    fb: [f32; 2],
    hp: [OnePole; 2],
    agc: Follower,
    key: [i32; 3],
    out: Out,
}

impl Shimmer {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut s = Self {
            sr,
            fdn: Fdn::new(sr),
            ps: [PitchShifter::new(sr, 60.0), PitchShifter::new(sr, 71.0)],
            amount: Smooth::new(20.0, sr),
            fb: [0.0; 2],
            hp: [OnePole::lowpass(150.0, sr); 2],
            agc: {
                let mut f = Follower::new(sr);
                f.set_times(5.0, 300.0, sr);
                f
            },
            key: [i32::MIN; 3],
            out: Out::new(sr),
        };
        s.set_params(p);
        s
    }
}

impl Effect for Shimmer {
    fn set_params(&mut self, p: &Params) {
        let key = [
            (p[0] * 100.0) as i32,
            (p[1] * 100.0) as i32,
            (p[3] * 100.0) as i32,
        ];
        if key != self.key {
            self.key = key;
            self.fdn.configure(
                1.4,
                p[0].clamp(0.5, 20.0),
                p[3].clamp(0.05, 1.0),
                0.6,
                false,
            );
            for ps in &mut self.ps {
                ps.set_semitones(p[1].clamp(-12.0, 24.0));
            }
        }
        self.amount.set(p[2].clamp(0.0, 0.9));
        self.out.set(self.sr, 120.0, 1.2, p[4]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let a = self.amount.tick();
            let (wl, wr) = self.fdn.tick(l[i] + self.fb[0], r[i] + self.fb[1]);
            // 올린 소리를 다시 꼬리로 — 저역은 빼서 뭉치지 않게.
            // 되먹임이 쌓여 커지면 자동으로 줄인다(레벨 감지 → 게인, 포화가 아니라 접힘이 없다)
            let sl = self.hp[0].hp(self.ps[0].tick(wl));
            let sr = self.hp[1].hp(self.ps[1].tick(wr));
            let lvl = self.agc.tick(sl.abs().max(sr.abs()));
            let g = if lvl > -12.0 {
                crate::blocks::db_to_gain(-12.0 - lvl)
            } else {
                1.0
            };
            self.fb[0] = flush(sl * a * g);
            self.fb[1] = flush(sr * a * g);
            (l[i], r[i]) = self.out.mix(l[i], r[i], wl, wr);
        }
    }
}

// ---------------------------------------------------------------------------
// 엔버브 (Logic EnVerb) — 리버브의 **모양**을 직접 그린다: 어택(차오름)·홀드·감쇠·끝 높이.
// 그 모양의 노이즈 IR 로 컨볼루션한다 → 지연 1024 (드라이도 맞춰 늦춘다).
// 파라미터: 0 어택 ms · 1 홀드 ms · 2 감쇠 ms · 3 감쇠 곡선(−1 빠르게..1 늦게) · 4 고역 감쇠 Hz ·
//           5 로우컷 · 6 폭 · 7 섞기
// ---------------------------------------------------------------------------

const ENV_BLOCK: usize = 1024;

pub fn enverb_ir(
    sr: f32,
    attack: f32,
    hold: f32,
    decay: f32,
    curve: f32,
    damp_hz: f32,
) -> (Vec<f32>, Vec<f32>) {
    let a = (attack.clamp(0.0, 2000.0) * 0.001 * sr) as usize;
    let h = (hold.clamp(0.0, 2000.0) * 0.001 * sr) as usize;
    let d = ((decay.clamp(20.0, 8000.0) * 0.001 * sr) as usize).max(1);
    let n = a + h + d;
    let mut out = (vec![0f32; n], vec![0f32; n]);
    let pw = 2f32.powf(curve.clamp(-1.0, 1.0) * 2.0);
    for (ch, data) in [&mut out.0, &mut out.1].into_iter().enumerate() {
        let mut rng = Rng::new(0xe17e + ch as u32 * 31);
        let mut lp = OnePole::lowpass(damp_hz.clamp(500.0, 18000.0), sr);
        let mut energy = 0f64;
        for (i, v) in data.iter_mut().enumerate() {
            let env = if i < a {
                i as f32 / a.max(1) as f32
            } else if i < a + h {
                1.0
            } else {
                let t = (i - a - h) as f32 / d as f32;
                (1.0 - t).max(0.0).powf(pw)
            };
            *v = lp.lp(rng.bipolar()) * env;
            energy += (*v as f64) * (*v as f64);
        }
        let s = if energy > 0.0 {
            (0.5 / energy.sqrt()) as f32
        } else {
            0.0
        };
        data.iter_mut().for_each(|v| *v *= s);
    }
    out
}

pub struct EnVerb {
    sr: f32,
    conv: Convolver,
    key: [i32; 5],
    dry_l: DelayLine,
    dry_r: DelayLine,
    out: Out,
}

impl EnVerb {
    pub fn new(sr: f32, p: &Params) -> Self {
        let (l, r) = enverb_ir(sr, p[0], p[1], p[2], p[3], p[4]);
        let mut e = Self {
            sr,
            conv: Convolver::new(ENV_BLOCK, &l, &r),
            key: Self::key_of(p),
            dry_l: DelayLine::new(ENV_BLOCK + 8),
            dry_r: DelayLine::new(ENV_BLOCK + 8),
            out: Out::new(sr),
        };
        e.set_params(p);
        e
    }
    fn key_of(p: &Params) -> [i32; 5] {
        [
            p[0] as i32,
            p[1] as i32,
            p[2] as i32,
            (p[3] * 100.0) as i32,
            p[4] as i32,
        ]
    }
}

impl Effect for EnVerb {
    fn set_params(&mut self, p: &Params) {
        let key = Self::key_of(p);
        if key != self.key {
            self.key = key;
            let (l, r) = enverb_ir(self.sr, p[0], p[1], p[2], p[3], p[4]);
            self.conv = Convolver::new(ENV_BLOCK, &l, &r);
        }
        self.out.set(self.sr, p[5], p[6], p[7]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let (wl, wr) = self.conv.tick(l[i], r[i]);
            self.dry_l.push(l[i]);
            self.dry_r.push(r[i]);
            let (dl, dr) = (self.dry_l.tap(ENV_BLOCK), self.dry_r.tap(ENV_BLOCK));
            (l[i], r[i]) = self.out.mix(dl, dr, wl, wr);
        }
    }

    fn latency(&self) -> usize {
        ENV_BLOCK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    fn tail_ratio_db(
        y: &[f32],
        early: std::ops::Range<usize>,
        late: std::ops::Range<usize>,
    ) -> f32 {
        20.0 * (rms(&y[late]) / rms(&y[early]).max(1e-12)).log10()
    }

    fn impulse_response(fx: &mut dyn Effect, p: &Params, n: usize) -> (Vec<f32>, Vec<f32>) {
        let mut x = vec![0.0; n];
        x[0] = 1.0;
        run(fx, p, &x, &x)
    }

    #[test]
    fn chromaverb_decays_and_is_stereo() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 2.0;
        p[1] = 1.5;
        p[2] = 1.0;
        p[4] = 0.5;
        p[5] = 1.0;
        p[6] = 0.7;
        p[7] = 20.0;
        p[8] = 1.0;
        p[9] = 1.0;
        let mut c = ChromaVerb::new(sr, &p);
        let (l, r) = impulse_response(&mut c, &p, 96000);
        let db = tail_ratio_db(&l, 4800..9600, 72000..76800);
        assert!(db < -40.0 && db > -110.0, "1.5초 RT 에서 1.4초 뒤 {db}dB");
        let side: f32 = l.iter().zip(&r).map(|(a, b)| (a - b).abs()).sum();
        assert!(side > 0.5);
    }

    #[test]
    fn plate_has_tail_and_bounded() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 0.8;
        p[2] = 12000.0;
        p[3] = 8000.0;
        p[4] = 20.0;
        p[5] = 1.0;
        p[6] = 1.0;
        let mut pl = Plate::new(sr, &p);
        let (l, _) = impulse_response(&mut pl, &p, 96000);
        assert!(rms(&l[24000..28800]) > 1e-4, "꼬리가 남는다");
        assert!(peak(&l) < 2.0);
    }

    #[test]
    fn gated_reverb_cuts_tail() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = -30.0;
        p[1] = 200.0;
        p[2] = 10.0;
        p[3] = 1.0;
        p[4] = 0.6;
        p[5] = 1.0;
        let mut g = GatedReverb::new(sr, &p);
        let mut x = vec![0.0; 48000];
        for v in x.iter_mut().take(2400) {
            *v = 0.5;
        }
        let (l, _) = run(&mut g, &p, &x, &x);
        assert!(rms(&l[4800..9600]) > 0.01, "열린 동안 리버브");
        assert!(
            rms(&l[24000..28800]) < 1e-4,
            "홀드 뒤 잘린다 {}",
            rms(&l[24000..28800])
        );
    }

    #[test]
    fn enverb_shape_follows_envelope() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 200.0;
        p[1] = 0.0;
        p[2] = 500.0;
        p[3] = 0.0;
        p[4] = 8000.0;
        p[5] = 20.0;
        p[6] = 1.0;
        p[7] = 1.0;
        let mut e = EnVerb::new(sr, &p);
        let (l, _) = impulse_response(&mut e, &p, 48000);
        let lat = e.latency();
        // 차오름: 20ms 지점보다 190ms 지점이 크다
        assert!(rms(&l[lat + 9000..lat + 9600]) > rms(&l[lat + 500..lat + 1100]) * 3.0);
    }

    #[test]
    fn shimmer_and_spring_and_room_are_bounded() {
        let sr = 48000.0;
        let x = sine(330.0, sr, 96000, 0.5);
        let mut p = [0.0; 24];
        p[0] = 6.0;
        p[1] = 12.0;
        p[2] = 0.9;
        p[3] = 0.6;
        p[4] = 1.0;
        let mut s = Shimmer::new(sr, &p);
        let (l, _) = run(&mut s, &p, &x, &x);
        assert!(peak(&l) < 6.0, "쉬머 최대 되먹임에서도 묶인다 {}", peak(&l));
        let mut p = [0.0; 24];
        p[0] = 40.0;
        p[1] = 0.92;
        p[2] = 1.0;
        p[3] = 5000.0;
        p[4] = 2.0;
        p[5] = 1.0;
        let mut sp = SpringReverb::new(sr, &p);
        let (l, _) = run(&mut sp, &p, &x, &x);
        assert!(peak(&l) < 6.0);
        let mut p = [0.0; 24];
        p[0] = 8.0;
        p[1] = 0.8;
        p[2] = 0.5;
        p[3] = 0.5;
        p[5] = 1.0;
        p[6] = 1.0;
        let mut rm = RoomReverb::new(sr, &p);
        let (l, _) = impulse_response(&mut rm, &p, 48000);
        // 첫 반사: 8m × 2.9ms ≈ 23ms 근처
        let first = l.iter().position(|v| v.abs() > 0.02).unwrap();
        assert!((1000..1300).contains(&first), "첫 반사 {first}");
    }
}

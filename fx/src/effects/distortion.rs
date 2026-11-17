//! 디스토션·앰프 (3단계) — 오버드라이브 · 퍼즈 · 퍼즈-와우 · 비트크러셔 · 클립 디스토션 ·
//! 크로마글로(포화 모델) · 앰프 디자이너 · 베이스 앰프 · 캐비닛 · 익사이터 · 서브베이스.
//!
//! **비선형 단계는 전부 4배 오버샘플링 안에서**(`CLAUDE.md` 절대 타협 불가). 예외 둘:
//! - 비트크러셔: 일부러 접힘(앨리어싱)을 만드는 이펙트다 — 그게 소리다.
//! - 서브베이스: 옥타브 분주(사각파)를 곧바로 120Hz 아래로 깎아 쓰므로 접힐 고역이 남지 않는다.

use super::{Effect, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind, OnePole};
use crate::blocks::delay::DelayLine;
use crate::blocks::env::Follower;
use crate::blocks::oversample::{self, Oversampler};
use crate::blocks::smooth::Smooth;
use crate::blocks::svf::Svf;
use crate::blocks::{db_to_gain, flush};

const OS: f64 = 4.0;

fn equal_power(mix: f32) -> (f32, f32) {
    let m = mix.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    (m.cos(), m.sin())
}

/// 비대칭 튜브 곡선 — 0 은 0, 출력 ±1 근처
#[inline(always)]
fn tube(x: f32, bias: f32) -> f32 {
    (x + bias).tanh() - bias.tanh()
}

/// 드라이·웨트를 지연(16)에 맞춰 섞는 공통 틀
struct DryWet {
    l: DelayLine,
    r: DelayLine,
    dry: Smooth,
    wet: Smooth,
    out: Smooth,
}

impl DryWet {
    fn new(sr: f32) -> Self {
        Self {
            l: DelayLine::new(64),
            r: DelayLine::new(64),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            out: Smooth::new(20.0, sr),
        }
    }
    fn set(&mut self, mix: f32, out_db: f32) {
        let (d, w) = equal_power(mix);
        self.dry.set(d);
        self.wet.set(w);
        self.out.set(db_to_gain(out_db.clamp(-40.0, 24.0)));
    }
    #[inline(always)]
    fn mix(&mut self, xl: f32, xr: f32, wl: f32, wr: f32, latency: usize) -> (f32, f32) {
        self.l.push(xl);
        self.r.push(xr);
        let (d, w, o) = (self.dry.tick(), self.wet.tick(), self.out.tick());
        (
            (self.l.tap(latency) * d + wl * w) * o,
            (self.r.tap(latency) * d + wr * w) * o,
        )
    }
}

// ---------------------------------------------------------------------------
// 오버드라이브 (Logic Pedalboard 의 녹색 스크리머 계열) — 중역을 앞세워(저역을 덜 넣어) 부드럽게 찌그러뜨린다.
// 파라미터: 0 드라이브 dB · 1 톤 Hz · 2 섞기 · 3 출력 dB
// ---------------------------------------------------------------------------

pub struct Overdrive {
    sr: f32,
    os: [Oversampler; 2],
    pre: [Biquad; 2],
    tone: [OnePole; 2],
    drive: Smooth,
    dw: DryWet,
}

impl Overdrive {
    pub fn new(sr: f32, p: &Params) -> Self {
        let pre = Biquad::new(Coefs::new(Kind::HighPass, 600.0, 0.6, 0.0, sr as f64));
        let mut o = Self {
            sr,
            os: [Oversampler::new(), Oversampler::new()],
            pre: [pre; 2],
            tone: [OnePole::default(); 2],
            drive: Smooth::new(20.0, sr),
            dw: DryWet::new(sr),
        };
        o.set_params(p);
        o
    }
}

impl Effect for Overdrive {
    fn set_params(&mut self, p: &Params) {
        self.drive.set(db_to_gain(p[0].clamp(0.0, 48.0)));
        for t in &mut self.tone {
            t.set_freq(p[1].clamp(500.0, 12000.0), self.sr);
        }
        self.dw.set(p[2], p[3]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let g = self.drive.tick();
            let norm = 1.0 / g.sqrt().max(1.0);
            let mut w = [0f32; 2];
            for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                // 스크리머: 원음 + 중역을 키운 갈래를 클립 — 저역이 덜 뭉개진다
                let hump = x + self.pre[c].tick(x) * 2.0;
                let y = oversample::process(&mut self.os[c], hump, |s| tube(s * g, 0.1));
                w[c] = self.tone[c].lp(y) * norm * 0.8;
            }
            (l[i], r[i]) = self.dw.mix(l[i], r[i], w[0], w[1], oversample::LATENCY);
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 퍼즈 — 높은 이득의 비대칭 하드 클립. 바이어스를 옮기면 "배터리가 약한" 찢어지는 소리(게이티드 퍼즈).
// 파라미터: 0 퍼즈 0..1 · 1 바이어스 −0.5..0.5 · 2 톤 Hz · 3 섞기 · 4 출력 dB
// ---------------------------------------------------------------------------

pub struct Fuzz {
    sr: f32,
    os: [Oversampler; 2],
    tone: [OnePole; 2],
    dc: [OnePole; 2],
    amount: Smooth,
    bias: Smooth,
    dw: DryWet,
}

impl Fuzz {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut f = Self {
            sr,
            os: [Oversampler::new(), Oversampler::new()],
            tone: [OnePole::default(); 2],
            dc: [OnePole::lowpass(15.0, sr); 2],
            amount: Smooth::new(20.0, sr),
            bias: Smooth::new(20.0, sr),
            dw: DryWet::new(sr),
        };
        f.set_params(p);
        f
    }
}

impl Effect for Fuzz {
    fn set_params(&mut self, p: &Params) {
        self.amount.set(p[0].clamp(0.0, 1.0));
        self.bias.set(p[1].clamp(-0.5, 0.5));
        for t in &mut self.tone {
            t.set_freq(p[2].clamp(300.0, 12000.0), self.sr);
        }
        self.dw.set(p[3], p[4]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let a = self.amount.tick();
            let g = 4.0 * db_to_gain(48.0 * a);
            let b = self.bias.tick();
            let mut w = [0f32; 2];
            for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                let y = oversample::process(&mut self.os[c], x, |s| {
                    let v = s * g + b;
                    // 양쪽 문턱이 다르다 — 짝수 배음
                    v.clamp(-0.6, 0.9) - b.clamp(-0.6, 0.9)
                });
                // 바이어스가 만든 직류를 뺀다
                let y = self.dc[c].hp(y);
                w[c] = self.tone[c].lp(y);
            }
            (l[i], r[i]) = self.dw.mix(l[i], r[i], w[0], w[1], oversample::LATENCY);
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 퍼즈-와우 (Logic Fuzz-Wah) — 와우(공명 밴드패스 쓸기) + 퍼즈. 페달 위치는 손잡이(오토메이션)로,
// 또는 소리 크기를 따라(오토 와우). 순서를 바꿀 수 있다.
// 파라미터: 0 페달 0..1 · 1 오토 양 0..1 · 2 공명 · 3 퍼즈 0..1 · 4 순서(와우→퍼즈 / 퍼즈→와우) · 5 출력 dB
// ---------------------------------------------------------------------------

pub struct FuzzWah {
    sr: f32,
    pedal: Smooth,
    auto: f32,
    q: f32,
    fuzz: Smooth,
    wah_first: bool,
    det: Follower,
    wah: [Svf; 2],
    os: [Oversampler; 2],
    out: Smooth,
    n: usize,
}

impl FuzzWah {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut det = Follower::new(sr);
        det.set_times(5.0, 120.0, sr);
        let mut f = Self {
            sr,
            pedal: Smooth::new(15.0, sr),
            auto: 0.0,
            q: 5.0,
            fuzz: Smooth::new(20.0, sr),
            wah_first: true,
            det,
            wah: [Svf::default(); 2],
            os: [Oversampler::new(), Oversampler::new()],
            out: Smooth::new(20.0, sr),
            n: 0,
        };
        f.set_params(p);
        f
    }
}

impl Effect for FuzzWah {
    fn set_params(&mut self, p: &Params) {
        self.pedal.set(p[0].clamp(0.0, 1.0));
        self.auto = p[1].clamp(0.0, 1.0);
        self.q = p[2].clamp(1.0, 15.0);
        self.fuzz.set(p[3].clamp(0.0, 1.0));
        self.wah_first = p[4] < 0.5;
        self.out.set(db_to_gain(p[5].clamp(-40.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let lvl = self.det.tick(l[i].abs().max(r[i].abs()));
            let env = ((lvl + 40.0) / 40.0).clamp(0.0, 1.0);
            let pos = (self.pedal.tick() + self.auto * env).clamp(0.0, 1.0);
            if self.n.is_multiple_of(16) {
                // 와우 페달: 약 400Hz … 2.2kHz
                let f = 400.0 * (5.5f32).powf(pos);
                for w in &mut self.wah {
                    w.set(f, self.q, self.sr);
                }
            }
            self.n += 1;
            let fz = self.fuzz.tick();
            let g = 1.0 + db_to_gain(36.0 * fz);
            let o = self.out.tick();
            let mut y = [0f32; 2];
            for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                let k = self.wah[c].k();
                let shape = |s: f32| if fz > 0.0 { tube(s * g, 0.05) } else { s };
                y[c] = if self.wah_first {
                    let w = self.wah[c].tick(x).band * k * 1.5;
                    oversample::process(&mut self.os[c], w, shape)
                } else {
                    let d = oversample::process(&mut self.os[c], x, shape);
                    self.wah[c].tick(d).band * k * 1.5
                };
            }
            l[i] = y[0] * o;
            r[i] = y[1] * o;
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 비트크러셔 (Logic Bitcrusher) — 비트 깊이 줄이기 + 표본 붙잡기(다운샘플). 접힘이 곧 소리다.
// 파라미터: 0 비트 1..24 · 1 다운샘플 배수 1..64 · 2 드라이브 dB · 3 섞기 · 4 출력 dB
// ---------------------------------------------------------------------------

pub struct Bitcrusher {
    bits: f32,
    factor: f32,
    drive: Smooth,
    hold: [f32; 2],
    count: f32,
    dw: DryWet,
}

impl Bitcrusher {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut b = Self {
            bits: 8.0,
            factor: 1.0,
            drive: Smooth::new(20.0, sr),
            hold: [0.0; 2],
            count: 0.0,
            dw: DryWet::new(sr),
        };
        b.set_params(p);
        b
    }
}

impl Effect for Bitcrusher {
    fn set_params(&mut self, p: &Params) {
        self.bits = p[0].clamp(1.0, 24.0);
        self.factor = p[1].clamp(1.0, 64.0);
        self.drive.set(db_to_gain(p[2].clamp(0.0, 36.0)));
        self.dw.set(p[3], p[4]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let steps = 2f32.powf(self.bits - 1.0);
        for i in 0..l.len() {
            let g = self.drive.tick();
            self.count += 1.0;
            if self.count >= self.factor {
                self.count -= self.factor;
                for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                    let v = (x * g).clamp(-1.0, 1.0);
                    self.hold[c] = (v * steps).round() / steps;
                }
            }
            (l[i], r[i]) = self.dw.mix(l[i], r[i], self.hold[0], self.hold[1], 0);
        }
    }
}

// ---------------------------------------------------------------------------
// 클립 디스토션 (Logic Clip Distortion) — 앞뒤 필터 사이의 클리퍼. 모드: 부드럽게 / 딱딱하게 / 접기(폴드).
// 파라미터: 0 드라이브 dB · 1 모드 · 2 대칭(−1..1) · 3 앞 하이패스 Hz · 4 뒤 로우패스 Hz · 5 섞기 · 6 출력 dB
// ---------------------------------------------------------------------------

pub struct ClipDist {
    sr: f32,
    drive: Smooth,
    mode: u32,
    sym: f32,
    pre: [OnePole; 2],
    post: [Biquad; 2],
    post_hz: f32,
    os: [Oversampler; 2],
    dc: [OnePole; 2],
    dw: DryWet,
}

impl ClipDist {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut c = Self {
            sr,
            drive: Smooth::new(20.0, sr),
            mode: 0,
            sym: 0.0,
            pre: [OnePole::default(); 2],
            post: [Biquad::default(); 2],
            post_hz: -1.0,
            os: [Oversampler::new(), Oversampler::new()],
            dc: [OnePole::lowpass(10.0, sr); 2],
            dw: DryWet::new(sr),
        };
        c.set_params(p);
        c
    }
}

impl Effect for ClipDist {
    fn set_params(&mut self, p: &Params) {
        self.drive.set(db_to_gain(p[0].clamp(0.0, 48.0)));
        self.mode = p[1].clamp(0.0, 2.0).round() as u32;
        self.sym = p[2].clamp(-1.0, 1.0);
        for f in &mut self.pre {
            f.set_freq(p[3].clamp(20.0, 2000.0), self.sr);
        }
        let lp = p[4].clamp(500.0, 20000.0);
        if lp != self.post_hz {
            self.post_hz = lp;
            let c = Coefs::new(Kind::LowPass, lp as f64, 0.707, 0.0, self.sr as f64);
            for f in &mut self.post {
                f.set(c);
            }
        }
        self.dw.set(p[5], p[6]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let (mode, sym) = (self.mode, self.sym);
        let clip = move |v: f32| -> f32 {
            let v = v + 0.3 * sym;
            match mode {
                0 => v.tanh(),
                1 => v.clamp(-1.0, 1.0),
                // 접기: ±1 을 넘으면 되돌아 내려온다 (삼각 접기)
                _ => {
                    let t = (v + 1.0).rem_euclid(4.0);
                    if t < 2.0 {
                        t - 1.0
                    } else {
                        3.0 - t
                    }
                }
            }
        };
        for i in 0..l.len() {
            let g = self.drive.tick();
            let mut w = [0f32; 2];
            for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                let hp = self.pre[c].hp(x);
                let y = oversample::process(&mut self.os[c], hp, |s| clip(s * g));
                w[c] = self.post[c].tick(self.dc[c].hp(y)) * 0.8;
            }
            (l[i], r[i]) = self.dw.mix(l[i], r[i], w[0], w[1], oversample::LATENCY);
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 크로마글로 (Logic ChromaGlow) — 포화 모델 다섯. 곡선·앞뒤 강조가 다르다.
//   0 모던 튜브 · 1 실키 튜브(부드럽고 짝수) · 2 브라이트 튜브(고역 강조) · 3 테이프(앞에서 고역을 올렸다
//   뒤에서 내린다 — 고역 포화가 덜하다) · 4 트랜지스터(딱딱하고 홀수)
// 파라미터: 0 모델 · 1 드라이브 dB · 2 톤(−1 어둡게..1 밝게) · 3 섞기 · 4 출력 dB
// ---------------------------------------------------------------------------

pub struct ChromaGlow {
    sr: f32,
    model: u32,
    drive: Smooth,
    os: [Oversampler; 2],
    pre: [Biquad; 2],
    post: [Biquad; 2],
    tone: [Biquad; 2],
    key: (u32, i32),
    dw: DryWet,
}

impl ChromaGlow {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut c = Self {
            sr,
            model: 0,
            drive: Smooth::new(20.0, sr),
            os: [Oversampler::new(), Oversampler::new()],
            pre: [Biquad::default(); 2],
            post: [Biquad::default(); 2],
            tone: [Biquad::default(); 2],
            key: (99, 0),
            dw: DryWet::new(sr),
        };
        c.set_params(p);
        c
    }
}

impl Effect for ChromaGlow {
    fn set_params(&mut self, p: &Params) {
        self.model = p[0].clamp(0.0, 4.0).round() as u32;
        self.drive.set(db_to_gain(p[1].clamp(0.0, 36.0)));
        let tone = (p[2].clamp(-1.0, 1.0) * 100.0) as i32;
        if (self.model, tone) != self.key {
            self.key = (self.model, tone);
            let sr = self.sr as f64;
            let emph = match self.model {
                2 => 4.0,
                3 => 6.0,
                _ => 0.0,
            };
            let pre = Coefs::new(Kind::HighShelf, 3000.0, 0.7, emph, sr);
            // 테이프는 앞에서 올린 만큼 뒤에서 내린다(디엠퍼시스), 브라이트는 그대로 둔다
            let post = Coefs::new(
                Kind::HighShelf,
                3000.0,
                0.7,
                if self.model == 3 { -emph } else { 0.0 },
                sr,
            );
            let tilt = Coefs::new(Kind::HighShelf, 1500.0, 0.5, tone as f64 / 100.0 * 6.0, sr);
            for c in 0..2 {
                self.pre[c].set(pre);
                self.post[c].set(post);
                self.tone[c].set(tilt);
            }
        }
        self.dw.set(p[3], p[4]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let model = self.model;
        for i in 0..l.len() {
            let g = self.drive.tick();
            let norm = 1.0 / (g.sqrt()).max(1.0);
            let curve = move |v: f32| -> f32 {
                let v = v * g;
                match model {
                    1 => tube(v * 0.7, 0.25) * 1.2,
                    3 => v / (1.0 + v.abs()).powf(0.8),
                    4 => (1.5 * v).clamp(-1.0, 1.0) - (1.5 * v).clamp(-1.0, 1.0).powi(3) / 3.0,
                    _ => tube(v, 0.12),
                }
            };
            let mut w = [0f32; 2];
            for (c, x) in [l[i], r[i]].into_iter().enumerate() {
                let e = self.pre[c].tick(x);
                let y = oversample::process(&mut self.os[c], e, curve);
                w[c] = self.tone[c].tick(self.post[c].tick(y)) * norm;
            }
            (l[i], r[i]) = self.dw.mix(l[i], r[i], w[0], w[1], oversample::LATENCY);
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 캐비닛 — 스피커 통 + 마이크. 실측 IR 에셋이 없어(`CLAUDE.md`) 필터 묶음으로 근사한다:
// 저역 공진 · 상자 울림 패임 · 프레즌스 봉우리 · 가파른 고역 끝. 마이크를 가장자리로 옮기면 어두워진다.
// ---------------------------------------------------------------------------

/// (저역 공진 Hz, 패임 Hz, 프레즌스 Hz, 고역 끝 Hz)
const CABS: [(f64, f64, f64, f64); 6] = [
    (110.0, 450.0, 2500.0, 5500.0), // 1×12 오픈백
    (100.0, 400.0, 2200.0, 5000.0), // 2×12
    (85.0, 350.0, 2000.0, 4500.0),  // 4×12 클로즈드
    (75.0, 500.0, 1800.0, 4000.0),  // 베이스 8×10
    (60.0, 300.0, 1500.0, 3500.0),  // 베이스 1×15
    (95.0, 420.0, 2800.0, 6500.0),  // 베이스 4×10 (트위터 없는 밝은 쪽)
];

#[derive(Clone)]
pub struct CabFilter {
    f: [Biquad; 6],
}

impl CabFilter {
    pub fn new(kind: u32, mic: f32, sr: f64) -> Self {
        let (res, dip, pres, top) = CABS[(kind as usize).min(CABS.len() - 1)];
        let edge = mic.clamp(0.0, 1.0) as f64;
        Self {
            f: [
                Biquad::new(Coefs::new(Kind::HighPass, res * 0.6, 0.7, 0.0, sr)),
                Biquad::new(Coefs::new(Kind::Peak, res, 1.4, 4.0, sr)),
                Biquad::new(Coefs::new(Kind::Peak, dip, 1.0, -5.0, sr)),
                Biquad::new(Coefs::new(Kind::Peak, pres, 1.6, 4.0 - 6.0 * edge, sr)),
                Biquad::new(Coefs::new(
                    Kind::LowPass,
                    top * (1.0 - 0.35 * edge),
                    0.8,
                    0.0,
                    sr,
                )),
                Biquad::new(Coefs::new(
                    Kind::LowPass,
                    top * 1.2 * (1.0 - 0.35 * edge),
                    0.6,
                    0.0,
                    sr,
                )),
            ],
        }
    }
    #[inline(always)]
    pub fn tick(&mut self, x: f32) -> f32 {
        let mut y = x;
        for f in &mut self.f {
            y = f.tick(y);
        }
        y
    }
}

/// 파라미터: 0 종류 · 1 마이크 위치(0 가운데..1 가장자리) · 2 섞기 · 3 출력 dB
pub struct Cabinet {
    sr: f32,
    key: (u32, i32),
    cab: [CabFilter; 2],
    dw: DryWet,
}

impl Cabinet {
    pub fn new(sr: f32, p: &Params) -> Self {
        let cab = CabFilter::new(0, 0.0, sr as f64);
        let mut c = Self {
            sr,
            key: (99, 0),
            cab: [cab.clone(), cab],
            dw: DryWet::new(sr),
        };
        c.set_params(p);
        c
    }
}

impl Effect for Cabinet {
    fn set_params(&mut self, p: &Params) {
        let key = (
            p[0].clamp(0.0, 5.0).round() as u32,
            (p[1].clamp(0.0, 1.0) * 100.0) as i32,
        );
        if key != self.key {
            self.key = key;
            let f = CabFilter::new(key.0, key.1 as f32 / 100.0, self.sr as f64);
            // 상태를 살리고 계수만 — 바꿀 때 딸깍 소리 방지
            for c in &mut self.cab {
                for (dst, src) in c.f.iter_mut().zip(f.f.iter()) {
                    dst.set(src.c);
                }
            }
        }
        self.dw.set(p[2], p[3]);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let wl = self.cab[0].tick(l[i]);
            let wr = self.cab[1].tick(r[i]);
            (l[i], r[i]) = self.dw.mix(l[i], r[i], wl, wr, 0);
        }
    }
}

// ---------------------------------------------------------------------------
// 앰프 — 프리앰프 2단(튜브) → 톤 스택 → 파워앰프(마스터) → 프레즌스 → 캐비닛.
// 비선형 세 단계와 톤 스택을 **한 번의 4배 구간 안에서** 돌린다(올림·내림 한 번 → 지연 16).
// 기타 앰프는 모노다 — 좌우를 합쳐 한 번 돌리고 양쪽에 같은 소리를 낸다.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct AmpModel {
    /// 프리앰프 이득 배율, 둘째 단 바이어스, 톤 스택 중역 주파수·Q, 저역 셸프 Hz, 고역 셸프 Hz
    gain: f32,
    bias: f32,
    mid_hz: f64,
    mid_q: f64,
    low_hz: f64,
    high_hz: f64,
}

const GUITAR_AMPS: [AmpModel; 4] = [
    AmpModel {
        gain: 0.6,
        bias: 0.05,
        mid_hz: 450.0,
        mid_q: 0.6,
        low_hz: 120.0,
        high_hz: 2500.0,
    }, // 클린 아메리칸
    AmpModel {
        gain: 1.0,
        bias: 0.15,
        mid_hz: 650.0,
        mid_q: 0.8,
        low_hz: 110.0,
        high_hz: 2800.0,
    }, // 브리티시 크런치
    AmpModel {
        gain: 2.2,
        bias: 0.2,
        mid_hz: 750.0,
        mid_q: 1.0,
        low_hz: 90.0,
        high_hz: 3200.0,
    }, // 모던 하이게인
    AmpModel {
        gain: 0.9,
        bias: 0.25,
        mid_hz: 1000.0,
        mid_q: 0.7,
        low_hz: 140.0,
        high_hz: 3500.0,
    }, // 브리티시 클래스 A (차임)
];

const BASS_AMPS: [AmpModel; 3] = [
    AmpModel {
        gain: 0.5,
        bias: 0.05,
        mid_hz: 500.0,
        mid_q: 0.7,
        low_hz: 60.0,
        high_hz: 2500.0,
    }, // 클래식 튜브
    AmpModel {
        gain: 0.7,
        bias: 0.1,
        mid_hz: 800.0,
        mid_q: 0.9,
        low_hz: 50.0,
        high_hz: 3500.0,
    }, // 모던 솔리드스테이트
    AmpModel {
        gain: 0.4,
        bias: 0.08,
        mid_hz: 300.0,
        mid_q: 0.6,
        low_hz: 70.0,
        high_hz: 2000.0,
    }, // 플립톱 (둥근)
];

struct AmpCore {
    sr: f32,
    os: Oversampler,
    in_hp: Biquad,
    couple: Biquad,
    stack: [Biquad; 3],
    presence: Biquad,
    cab: CabFilter,
    gain: Smooth,
    master: Smooth,
    model: AmpModel,
    key: [i32; 8],
}

impl AmpCore {
    fn new(sr: f32, model: AmpModel) -> Self {
        let hi = sr as f64 * OS;
        Self {
            sr,
            os: Oversampler::new(),
            in_hp: Biquad::new(Coefs::new(Kind::HighPass, 70.0, 0.7, 0.0, hi)),
            couple: Biquad::new(Coefs::new(Kind::HighPass, 40.0, 0.7, 0.0, hi)),
            stack: [Biquad::default(); 3],
            presence: Biquad::default(),
            cab: CabFilter::new(1, 0.2, sr as f64),
            gain: Smooth::new(20.0, sr),
            master: Smooth::new(20.0, sr),
            model,
            key: [i32::MIN; 8],
        }
    }

    /// bass/mid/treble/presence 는 −1..1, cab 은 종류(음수면 끔)
    #[allow(clippy::too_many_arguments)]
    fn configure(
        &mut self,
        model: AmpModel,
        gain: f32,
        bass: f32,
        mid: f32,
        treble: f32,
        presence: f32,
        master: f32,
        cab: i32,
        mic: f32,
    ) {
        self.model = model;
        self.gain.set(gain.clamp(0.0, 1.0));
        self.master.set(master.clamp(0.0, 1.0));
        let key = [
            (model.mid_hz) as i32,
            (bass * 100.0) as i32,
            (mid * 100.0) as i32,
            (treble * 100.0) as i32,
            (presence * 100.0) as i32,
            cab,
            (mic * 100.0) as i32,
            (model.low_hz) as i32,
        ];
        if key != self.key {
            self.key = key;
            let hi = self.sr as f64 * OS;
            self.stack[0].set(Coefs::new(
                Kind::LowShelf,
                model.low_hz,
                0.7,
                bass as f64 * 12.0,
                hi,
            ));
            // 톤 스택은 손잡이를 다 0 에 두어도 중역이 패인다 — 그게 앰프 소리다
            self.stack[1].set(Coefs::new(
                Kind::Peak,
                model.mid_hz,
                model.mid_q,
                mid as f64 * 10.0 - 4.0,
                hi,
            ));
            self.stack[2].set(Coefs::new(
                Kind::HighShelf,
                model.high_hz,
                0.7,
                treble as f64 * 12.0,
                hi,
            ));
            self.presence.set(Coefs::new(
                Kind::Peak,
                4000.0,
                0.8,
                presence as f64 * 8.0,
                self.sr as f64,
            ));
            if cab >= 0 {
                let f = CabFilter::new(cab as u32, mic, self.sr as f64);
                for (dst, src) in self.cab.f.iter_mut().zip(f.f.iter()) {
                    dst.set(src.c);
                }
            }
        }
    }

    #[inline]
    fn tick(&mut self, x: f32, cab_on: bool) -> f32 {
        let g = 1.0 + 60.0 * self.gain.tick().powi(2) * self.model.gain;
        let m = self.master.tick();
        let pg = 1.0 + 8.0 * m * m;
        let bias = self.model.bias;
        let up = self.os.up(x);
        let mut st = [0f32; 4];
        for k in 0..4 {
            let a = self.in_hp.tick(up[k]);
            let s1 = tube(a * g, bias * 0.5);
            let s2 = tube(self.couple.tick(s1) * 2.0, bias);
            let mut t = s2;
            for f in &mut self.stack {
                t = f.tick(t);
            }
            // 파워앰프: 마스터를 올리면 더 일찍 눌린다 (부드러운 대칭 포화)
            st[k] = (t * pg).tanh() / pg.sqrt();
        }
        let y = self.os.down(st);
        let y = self.presence.tick(y);
        flush(if cab_on { self.cab.tick(y) } else { y })
    }
}

/// 앰프 디자이너 (Logic Amp Designer)
/// 파라미터: 0 앰프 · 1 게인 0..1 · 2 저역 · 3 중역 · 4 고역 · 5 프레즌스 (각 −1..1) · 6 마스터 0..1 ·
///           7 캐비닛(끔·1×12·2×12·4×12) · 8 마이크 위치 · 9 출력 dB
pub struct AmpDesigner {
    core: AmpCore,
    cab_on: bool,
    out: Smooth,
}

impl AmpDesigner {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut a = Self {
            core: AmpCore::new(sr, GUITAR_AMPS[1]),
            cab_on: true,
            out: Smooth::new(20.0, sr),
        };
        a.set_params(p);
        a
    }
}

impl Effect for AmpDesigner {
    fn set_params(&mut self, p: &Params) {
        let model = GUITAR_AMPS[(p[0].clamp(0.0, 3.0).round() as usize).min(3)];
        let cab = p[7].clamp(0.0, 3.0).round() as i32 - 1;
        self.cab_on = cab >= 0;
        self.core.configure(
            model,
            p[1],
            p[2].clamp(-1.0, 1.0),
            p[3].clamp(-1.0, 1.0),
            p[4].clamp(-1.0, 1.0),
            p[5].clamp(-1.0, 1.0),
            p[6],
            cab,
            p[8],
        );
        self.out.set(db_to_gain(p[9].clamp(-40.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let y = self.core.tick(0.5 * (l[i] + r[i]), self.cab_on) * self.out.tick();
            l[i] = y;
            r[i] = y;
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

/// 베이스 앰프 (Logic Bass Amp Designer) — 앰프 소리와 다이렉트(DI)를 섞는다. 저역 단단함은 DI 쪽에서.
/// 파라미터: 0 앰프 · 1 게인 · 2 저역 · 3 중역 · 4 고역 (−1..1) · 5 마스터 · 6 캐비닛(끔·8×10·1×15·4×10) ·
///           7 DI ↔ 앰프(0 = DI 만) · 8 출력 dB
pub struct BassAmp {
    core: AmpCore,
    cab_on: bool,
    blend: Smooth,
    di: DelayLine,
    out: Smooth,
}

impl BassAmp {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut a = Self {
            core: AmpCore::new(sr, BASS_AMPS[0]),
            cab_on: true,
            blend: Smooth::new(20.0, sr),
            di: DelayLine::new(64),
            out: Smooth::new(20.0, sr),
        };
        a.set_params(p);
        a
    }
}

impl Effect for BassAmp {
    fn set_params(&mut self, p: &Params) {
        let model = BASS_AMPS[(p[0].clamp(0.0, 2.0).round() as usize).min(2)];
        let cab = match p[6].clamp(0.0, 3.0).round() as i32 {
            0 => -1,
            1 => 3,
            2 => 4,
            _ => 5,
        };
        self.cab_on = cab >= 0;
        self.core.configure(
            model,
            p[1],
            p[2].clamp(-1.0, 1.0),
            p[3].clamp(-1.0, 1.0),
            p[4].clamp(-1.0, 1.0),
            0.0,
            p[5],
            cab,
            0.2,
        );
        self.blend.set(p[7].clamp(0.0, 1.0));
        self.out.set(db_to_gain(p[8].clamp(-40.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let x = 0.5 * (l[i] + r[i]);
            let amp = self.core.tick(x, self.cab_on);
            self.di.push(x);
            let b = self.blend.tick();
            let y = (self.di.tap(oversample::LATENCY) * (1.0 - b) + amp * b) * self.out.tick();
            l[i] = y;
            r[i] = y;
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 익사이터 (Logic Exciter) — 고역만 떼어 포화시켜 새 배음을 만들고 조금 섞는다. 원음은 그대로.
// 파라미터: 0 시작 Hz · 1 배음 양 0..1 · 2 색(0 짝수..1 홀수) · 3 섞기(배음 크기) · 4 출력 dB
// ---------------------------------------------------------------------------

pub struct Exciter {
    sr: f32,
    hp: [Biquad; 2],
    post: [Biquad; 2],
    freq: f32,
    os: [Oversampler; 2],
    drive: Smooth,
    color: f32,
    amount: Smooth,
    dly: [DelayLine; 2],
    out: Smooth,
}

impl Exciter {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut e = Self {
            sr,
            hp: [Biquad::default(); 2],
            post: [Biquad::default(); 2],
            freq: -1.0,
            os: [Oversampler::new(), Oversampler::new()],
            drive: Smooth::new(20.0, sr),
            color: 0.5,
            amount: Smooth::new(20.0, sr),
            dly: [DelayLine::new(64), DelayLine::new(64)],
            out: Smooth::new(20.0, sr),
        };
        e.set_params(p);
        e
    }
}

impl Effect for Exciter {
    fn set_params(&mut self, p: &Params) {
        let f = p[0].clamp(1000.0, 12000.0);
        if f != self.freq {
            self.freq = f;
            let c = Coefs::new(Kind::HighPass, f as f64, 0.707, 0.0, self.sr as f64);
            // 만든 배음 중 시작 주파수 아래로 떨어진 것(차음)은 다시 뺀다
            let c2 = Coefs::new(Kind::HighPass, f as f64, 0.707, 0.0, self.sr as f64);
            for k in 0..2 {
                self.hp[k].set(c);
                self.post[k].set(c2);
            }
        }
        self.drive.set(1.0 + 20.0 * p[1].clamp(0.0, 1.0));
        self.color = p[2].clamp(0.0, 1.0);
        self.amount.set(p[3].clamp(0.0, 1.0));
        self.out.set(db_to_gain(p[4].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let col = self.color;
        for i in 0..l.len() {
            let g = self.drive.tick();
            let shape = move |s: f32| {
                let v = s * g;
                // 짝수(정류 성분)와 홀수(tanh)를 색으로 섞는다
                ((1.0 - col) * (v.abs() * 0.5 + v * 0.5).tanh() + col * v.tanh()) / g.sqrt()
            };
            let (a, o) = (self.amount.tick(), self.out.tick());
            for (c, x) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                let h = self.hp[c].tick(*x);
                let y = oversample::process(&mut self.os[c], h, shape);
                let y = self.post[c].tick(y);
                self.dly[c].push(*x);
                *x = (self.dly[c].tap(oversample::LATENCY) + y * a) * o;
            }
        }
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }
}

// ---------------------------------------------------------------------------
// 서브베이스 (Logic SubBass) — 저역의 영점 교차를 세어 **한 옥타브 아래** 사각파를 만들고,
// 원래 저역의 크기를 따라가게 한 뒤 120Hz 아래로 깎아 섞는다.
// 파라미터: 0 감지 대역 상한 Hz · 1 서브 크기 · 2 서브 로우패스 Hz · 3 원음 크기
// ---------------------------------------------------------------------------

pub struct SubBass {
    sr: f32,
    band: [Biquad; 2],
    sub_lp: [Biquad; 2],
    key_hz: (f32, f32),
    det: Follower,
    flip: f32,
    last: f32,
    sub: Smooth,
    dry: Smooth,
}

impl SubBass {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut det = Follower::new(sr);
        det.set_times(5.0, 80.0, sr);
        let mut s = Self {
            sr,
            band: [Biquad::default(); 2],
            sub_lp: [Biquad::default(); 2],
            key_hz: (-1.0, -1.0),
            det,
            flip: 1.0,
            last: 0.0,
            sub: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
        };
        s.set_params(p);
        s
    }
}

impl Effect for SubBass {
    fn set_params(&mut self, p: &Params) {
        let key = (p[0].clamp(60.0, 400.0), p[2].clamp(30.0, 200.0));
        if key != self.key_hz {
            self.key_hz = key;
            let sr = self.sr as f64;
            self.band = [Biquad::new(Coefs::new(Kind::LowPass, key.0 as f64, 0.707, 0.0, sr)); 2];
            self.sub_lp = [Biquad::new(Coefs::new(Kind::LowPass, key.1 as f64, 0.707, 0.0, sr)); 2];
        }
        self.sub.set(p[1].clamp(0.0, 2.0));
        self.dry.set(p[3].clamp(0.0, 1.0));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let x = 0.5 * (l[i] + r[i]);
            let b0 = self.band[0].tick(x);
            let b = self.band[1].tick(b0);
            // 영점을 위로 지날 때마다 뒤집는다 → 반 주기마다 한 번 = 한 옥타브 아래
            if self.last <= 0.0 && b > 0.0 {
                self.flip = -self.flip;
            }
            self.last = b;
            let lvl = crate::blocks::db_to_gain(self.det.tick(b.abs()));
            let sq = self.flip * lvl;
            let s0 = self.sub_lp[0].tick(sq);
            let s = self.sub_lp[1].tick(s0) * self.sub.tick();
            let d = self.dry.tick();
            l[i] = l[i] * d + s;
            r[i] = r[i] * d + s;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

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
    fn overdrive_adds_harmonics_without_blowing_up() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 30.0;
        p[1] = 8000.0;
        p[2] = 1.0;
        let mut o = Overdrive::new(sr, &p);
        let x = sine(220.0, sr, 48000, 0.5);
        let (l, _) = run(&mut o, &p, &x, &x);
        let t = &l[24000..];
        assert!(tone(t, 660.0, sr) > 0.02, "3배음 {}", tone(t, 660.0, sr));
        assert!(peak(t) < 1.5);
    }

    #[test]
    fn bitcrusher_quantizes() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 3.0;
        p[1] = 1.0;
        p[3] = 1.0;
        let mut b = Bitcrusher::new(sr, &p);
        let x = sine(100.0, sr, 4800, 0.9);
        let (l, _) = run(&mut b, &p, &x, &x);
        let mut levels: Vec<i32> = l.iter().map(|v| (v * 1000.0).round() as i32).collect();
        levels.sort();
        levels.dedup();
        assert!(levels.len() <= 9, "3비트 = 단계 8~9 개, {}", levels.len());
    }

    #[test]
    fn amp_is_mono_bounded_and_latency_exact() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 2.0;
        p[1] = 0.8;
        p[6] = 0.6;
        p[7] = 3.0;
        p[8] = 0.3;
        let mut a = AmpDesigner::new(sr, &p);
        let x = sine(110.0, sr, 48000, 0.8);
        let (l, r) = run(&mut a, &p, &x, &x);
        assert_eq!(l, r);
        assert!(peak(&l) < 2.0 && peak(&l[24000..]) > 0.01);
        // 베이스 앰프 DI 만: 지연 16 만큼 늦은 원음
        let mut p = [0.0; 24];
        p[7] = 0.0;
        let mut b = BassAmp::new(sr, &p);
        let mut imp = vec![0.0; 256];
        imp[10] = 1.0;
        let (bl, _) = run(&mut b, &p, &imp, &imp);
        assert_eq!(
            bl.iter().position(|v| *v > 0.5),
            Some(10 + oversample::LATENCY)
        );
    }

    #[test]
    fn cabinet_cuts_fizz() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 2.0;
        p[2] = 1.0;
        let mut c = Cabinet::new(sr, &p);
        let hi = sine(10000.0, sr, 24000, 0.5);
        let (l, _) = run(&mut c, &p, &hi, &hi);
        assert!(
            peak(&l[12000..]) < 0.02,
            "10kHz 는 스피커가 못 낸다 {}",
            peak(&l[12000..])
        );
    }

    #[test]
    fn subbass_makes_octave_below() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 200.0;
        p[1] = 1.0;
        p[2] = 120.0;
        p[3] = 0.0;
        let mut s = SubBass::new(sr, &p);
        let x = sine(110.0, sr, 96000, 0.5);
        let (l, _) = run(&mut s, &p, &x, &x);
        let t = &l[48000..];
        assert!(
            tone(t, 55.0, sr) > tone(t, 110.0, sr) * 2.0,
            "55Hz {} 110Hz {}",
            tone(t, 55.0, sr),
            tone(t, 110.0, sr)
        );
    }

    #[test]
    fn exciter_adds_highs_only_above_freq() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 3000.0;
        p[1] = 0.8;
        p[2] = 0.5;
        p[3] = 1.0;
        let mut e = Exciter::new(sr, &p);
        let low = sine(200.0, sr, 24000, 0.5);
        let (l, _) = run(&mut e, &p, &low, &low);
        // 저역만 있으면 거의 그대로 (지연만)
        assert!((peak(&l[12000..]) - 0.5).abs() < 0.03);
    }
}

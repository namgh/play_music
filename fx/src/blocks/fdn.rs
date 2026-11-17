//! 되먹임 지연망(FDN) — 알고리즘 리버브의 꼬리. 지연 8 개를 하다마드 행렬로 섞는다.
//!
//! - 감쇠: 줄마다 길이에 맞춘 게인 → 모든 줄이 같은 RT60 으로 준다 (조트 방식)
//! - 고역 감쇠: 줄마다 원폴 저역통과 — 직류 게인과 나이퀴스트 게인을 따로 맞춰 고역 RT60 을 따로 준다
//! - 흔들림: 줄 길이를 아주 느리게 흔들어 금속성 울림(고정 모드)을 흩뜨린다
//! - 얼리기(freeze): 되먹임 1, 감쇠 없음, 입력 0 → 지금 소리가 계속 남는다

use super::delay::DelayLine;
use super::lfo::Lfo;
use super::lfo::Shape;

pub const LINES: usize = 8;

/// 서로 소에 가까운 길이(ms) — 같은 배수가 있으면 특정 주파수가 울린다
const BASE_MS: [f32; LINES] = [29.7, 37.1, 41.1, 43.7, 53.0, 59.9, 67.1, 73.3];

#[derive(Clone, Copy, Debug, Default)]
struct Absorb {
    b0: f32,
    p: f32,
    z: f32,
}

impl Absorb {
    fn set(&mut self, g_dc: f32, g_ny: f32) {
        let sum = (g_dc + g_ny).max(1e-9);
        self.b0 = 2.0 * g_dc * g_ny / sum;
        self.p = (g_dc - g_ny) / sum;
    }
    #[inline(always)]
    fn tick(&mut self, x: f32) -> f32 {
        self.z = super::flush(self.b0 * x + self.p * self.z);
        self.z
    }
}

pub struct Fdn {
    sr: f32,
    lines: Vec<DelayLine>,
    len: [f32; LINES],
    absorb: [Absorb; LINES],
    lfo: [Lfo; LINES],
    mod_depth: f32,
    state: [f32; LINES],
    frozen: bool,
}

impl Fdn {
    pub fn new(sr: f32) -> Self {
        let max = (BASE_MS[LINES - 1] * 0.001 * sr * 3.2) as usize + 64;
        Self {
            sr,
            lines: (0..LINES).map(|_| DelayLine::new(max)).collect(),
            len: [0.0; LINES],
            absorb: [Absorb::default(); LINES],
            lfo: std::array::from_fn(|k| {
                let mut l = Lfo::new(k as f32 * 0.137);
                l.set_rate(0.13 + 0.07 * k as f32, sr);
                l
            }),
            mod_depth: 0.0,
            state: [0.0; LINES],
            frozen: false,
        }
    }

    /// `size` 0.3…3 (길이 배율), `rt60` 초, `hf_ratio` 고역 RT60 / 저역 RT60 (0.05…1), `mod_ms` 흔들림
    pub fn configure(&mut self, size: f32, rt60: f32, hf_ratio: f32, mod_ms: f32, frozen: bool) {
        let size = size.clamp(0.3, 3.0);
        let rt = rt60.clamp(0.05, 60.0);
        let rt_hi = (rt * hf_ratio.clamp(0.02, 1.0)).max(0.02);
        for k in 0..LINES {
            self.len[k] = BASE_MS[k] * 0.001 * self.sr * size;
            let secs = self.len[k] / self.sr;
            if frozen {
                self.absorb[k].set(1.0, 1.0);
            } else {
                let g_dc = 10f32.powf(-3.0 * secs / rt);
                let g_ny = 10f32.powf(-3.0 * secs / rt_hi);
                self.absorb[k].set(g_dc, g_ny);
            }
        }
        self.mod_depth = mod_ms.clamp(0.0, 3.0) * 0.001 * self.sr;
        self.frozen = frozen;
    }

    /// 입력(좌, 우) → 출력(좌, 우)
    #[inline]
    pub fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        // 읽기
        let mut y = [0f32; LINES];
        for k in 0..LINES {
            let m = self.lfo[k].tick(Shape::Sine) * self.mod_depth;
            y[k] = self.absorb[k].tick(self.lines[k].read(self.len[k] + m + 2.0));
        }
        // 하다마드 8 (정규화 1/√8) — 에너지를 보존하며 모든 줄을 섞는다
        let h = hadamard8(&y);
        let (il, ir) = if self.frozen { (0.0, 0.0) } else { (l, r) };
        for k in 0..LINES {
            let inj = if k % 2 == 0 { il } else { ir };
            self.state[k] = h[k] + inj;
            self.lines[k].push(self.state[k]);
        }
        // 출력 — 줄마다 부호를 달리해 좌우가 서로 무관하게
        let ol = y[0] - y[2] + y[4] - y[6] + 0.5 * (y[1] - y[5]);
        let or = y[1] - y[3] + y[5] - y[7] + 0.5 * (y[2] - y[6]);
        (ol * 0.35, or * 0.35)
    }
}

#[inline(always)]
fn hadamard8(x: &[f32; LINES]) -> [f32; LINES] {
    let mut a = *x;
    let mut h = 1;
    while h < LINES {
        let mut i = 0;
        while i < LINES {
            for j in i..i + h {
                let (u, v) = (a[j], a[j + h]);
                a[j] = u + v;
                a[j + h] = u - v;
            }
            i += 2 * h;
        }
        h *= 2;
    }
    let s = 1.0 / (LINES as f32).sqrt();
    a.map(|v| v * s)
}

/// 확산용 올패스 (슈뢰더) — 입력을 꼬리로 들어가기 전에 흩어 "따닥" 소리를 없앤다
#[derive(Clone, Debug)]
pub struct Diffuser {
    line: DelayLine,
    len: f32,
    g: f32,
}

impl Diffuser {
    pub fn new(len_samples: f32, g: f32) -> Self {
        Self {
            line: DelayLine::new(len_samples as usize * 3 + 8),
            len: len_samples.max(1.0),
            g,
        }
    }
    pub fn set(&mut self, len_samples: f32, g: f32) {
        self.len = len_samples.clamp(1.0, self.line.capacity() as f32 - 4.0);
        self.g = g;
    }
    #[inline(always)]
    pub fn tick(&mut self, x: f32) -> f32 {
        let d = self.line.read(self.len);
        let v = x + self.g * d;
        self.line.push(v);
        d - self.g * v
    }
    /// 출력 탭 — 판 리버브(다토로)가 쓴다
    pub fn tap(&self, d: usize) -> f32 {
        self.line.tap(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rt60_is_respected() {
        let sr = 48000.0;
        let mut f = Fdn::new(sr);
        f.configure(1.0, 1.0, 1.0, 0.0, false);
        let mut e_early = 0.0f64;
        let mut e_late = 0.0f64;
        for n in 0..(sr as usize * 2) {
            let x = if n == 0 { 1.0 } else { 0.0 };
            let (l, r) = f.tick(x, x);
            let e = (l * l + r * r) as f64;
            if (4800..9600).contains(&n) {
                e_early += e;
            }
            if (52800..57600).contains(&n) {
                e_late += e;
            }
        }
        // 1초 차이 → −60dB (에너지)
        let db = 10.0 * (e_late / e_early).log10();
        assert!((db + 60.0).abs() < 6.0, "1초 뒤 {db}dB");
    }

    #[test]
    fn freeze_holds_energy() {
        let sr = 48000.0;
        let mut f = Fdn::new(sr);
        f.configure(1.0, 2.0, 1.0, 0.0, false);
        for n in 0..4800 {
            let x = if n < 100 { 0.5 } else { 0.0 };
            f.tick(x, x);
        }
        f.configure(1.0, 2.0, 1.0, 0.0, true);
        let mut e1 = 0.0;
        for _ in 0..4800 {
            let (l, _) = f.tick(1.0, 1.0); // 얼린 동안 입력은 무시
            e1 += l * l;
        }
        let mut e2 = 0.0;
        for _ in 0..48000 {
            f.tick(0.0, 0.0);
        }
        for _ in 0..4800 {
            let (l, _) = f.tick(0.0, 0.0);
            e2 += l * l;
        }
        assert!(
            (e2 / e1 - 1.0).abs() < 0.1,
            "얼리면 줄지 않는다 {e1} → {e2}"
        );
    }
}

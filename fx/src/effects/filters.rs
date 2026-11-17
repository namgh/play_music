//! 필터 — 멀티 필터(SVF 여러 모드) · 엔벨로프 필터(오토 와우) (1단계).

use super::{Effect, Meters, Params};
use crate::blocks::db_to_gain;
use crate::blocks::env::Follower;
use crate::blocks::smooth::Smooth;
use crate::blocks::svf::Svf;

/// 모드: 0 LP12 · 1 LP24 · 2 HP12 · 3 HP24 · 4 BP · 5 노치 · 6 피크
#[inline(always)]
fn shape(mode: u32, a: &mut Svf, b: &mut Svf, x: f32, peak_gain: f32) -> f32 {
    let o = a.tick(x);
    match mode {
        0 => o.low,
        1 => b.tick(o.low).low,
        2 => o.high,
        3 => b.tick(o.high).high,
        4 => o.band * a.k(),
        5 => x - o.band * a.k(),
        _ => x + o.band * a.k() * (peak_gain - 1.0),
    }
}

/// 차단을 몇 샘플마다 다시 계산 (tan 이 비싸다) — 16 샘플 = 0.3ms 라 들리지 않는다
const UPDATE_EVERY: usize = 16;

// ---------------------------------------------------------------------------
// 멀티 필터 — 파라미터: 0 모드 · 1 차단 Hz · 2 공명(Q) · 3 피크 게인 dB · 4 섞기 · 5 출력 dB
// ---------------------------------------------------------------------------

pub struct MultiFilter {
    sr: f32,
    mode: u32,
    cutoff: Smooth,
    q: f32,
    peak: f32,
    a: [Svf; 2],
    b: [Svf; 2],
    wet: Smooth,
    dry: Smooth,
    out: Smooth,
    n: usize,
}

impl MultiFilter {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut f = Self {
            sr,
            mode: 0,
            cutoff: Smooth::new(15.0, sr),
            q: 0.707,
            peak: 1.0,
            a: [Svf::default(); 2],
            b: [Svf::default(); 2],
            wet: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            out: Smooth::new(20.0, sr),
            n: 0,
        };
        f.set_params(p);
        f
    }
}

impl Effect for MultiFilter {
    fn set_params(&mut self, p: &Params) {
        self.mode = p[0].clamp(0.0, 6.0).round() as u32;
        // 차단은 로그 공간에서 미끄러지게 — 선형이면 내려갈 때 고역에서 너무 오래 머문다
        self.cutoff.set(p[1].clamp(20.0, 20000.0).ln());
        self.q = p[2].clamp(0.5, 25.0);
        self.peak = db_to_gain(p[3].clamp(-24.0, 24.0));
        let mix = p[4].clamp(0.0, 1.0);
        self.wet.set(mix);
        self.dry.set(1.0 - mix);
        self.out.set(db_to_gain(p[5].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let c = self.cutoff.tick().exp();
            if self.n.is_multiple_of(UPDATE_EVERY) {
                // 24dB 두 단을 같은 Q 로 겹치면 공명이 두 배로 솟는다 — 둘째 단은 완만하게
                let (q1, q2) = if matches!(self.mode, 1 | 3) {
                    (self.q, 0.707)
                } else {
                    (self.q, self.q)
                };
                for k in 0..2 {
                    self.a[k].set(c, q1, self.sr);
                    self.b[k].set(c, q2, self.sr);
                }
            }
            self.n += 1;
            let (wg, dg, o) = (self.wet.tick(), self.dry.tick(), self.out.tick());
            let [al, ar] = &mut self.a;
            let [bl, br] = &mut self.b;
            let yl = shape(self.mode, al, bl, l[i], self.peak);
            let yr = shape(self.mode, ar, br, r[i], self.peak);
            l[i] = (l[i] * dg + yl * wg) * o;
            r[i] = (r[i] * dg + yr * wg) * o;
        }
    }
}

// ---------------------------------------------------------------------------
// 엔벨로프 필터 (오토 와우, Logic AutoFilter 의 엔벨로프 모드·Fuzz-Wah 의 오토 와우)
// 소리 크기를 따라 차단이 옥타브 단위로 열린다.
// 파라미터: 0 모드(LP/BP/HP) · 1 시작 Hz · 2 범위(옥타브, − 면 닫힘) · 3 감도 dB · 4 어택 ms ·
//           5 릴리즈 ms · 6 공명 · 7 섞기
// 미터: 0 지금 차단 Hz
// ---------------------------------------------------------------------------

pub struct EnvFilter {
    sr: f32,
    mode: u32,
    base: f32,
    range: f32,
    sens: f32,
    q: f32,
    det: Follower,
    f: [Svf; 2],
    wet: Smooth,
    dry: Smooth,
    now: f32,
    n: usize,
}

impl EnvFilter {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut e = Self {
            sr,
            mode: 1,
            base: 300.0,
            range: 3.0,
            sens: 0.0,
            q: 3.0,
            det: Follower::new(sr),
            f: [Svf::default(); 2],
            wet: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            now: 300.0,
            n: 0,
        };
        e.set_params(p);
        e
    }
}

impl Effect for EnvFilter {
    fn set_params(&mut self, p: &Params) {
        self.mode = p[0].clamp(0.0, 2.0).round() as u32;
        self.base = p[1].clamp(40.0, 8000.0);
        self.range = p[2].clamp(-6.0, 7.0);
        self.sens = p[3].clamp(-12.0, 40.0);
        self.det
            .set_times(p[4].clamp(0.5, 200.0), p[5].clamp(10.0, 2000.0), self.sr);
        self.q = p[6].clamp(0.5, 20.0);
        let mix = p[7].clamp(0.0, 1.0);
        self.wet.set(mix);
        self.dry.set(1.0 - mix);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let lvl = self.det.tick(l[i].abs().max(r[i].abs()));
            if self.n.is_multiple_of(UPDATE_EVERY) {
                // −48dBFS(감도 더함) 에서 0, 0dBFS 에서 1
                let env = ((lvl + self.sens + 48.0) / 48.0).clamp(0.0, 1.0);
                self.now = (self.base * 2f32.powf(self.range * env)).clamp(20.0, self.sr * 0.45);
                for f in &mut self.f {
                    f.set(self.now, self.q, self.sr);
                }
            }
            self.n += 1;
            let (wg, dg) = (self.wet.tick(), self.dry.tick());
            let pick = |o: crate::blocks::svf::SvfOut, k: f32, mode: u32| match mode {
                0 => o.low,
                2 => o.high,
                _ => o.band * k,
            };
            let k = self.f[0].k();
            let yl = pick(self.f[0].tick(l[i]), k, self.mode);
            let yr = pick(self.f[1].tick(r[i]), k, self.mode);
            l[i] = l[i] * dg + yl * wg;
            r[i] = r[i] * dg + yr * wg;
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    #[test]
    fn multifilter_modes() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[1] = 1000.0;
        p[2] = 0.707;
        p[4] = 1.0;
        let hi = sine(8000.0, sr, 24000, 0.5);
        let lo = sine(100.0, sr, 24000, 0.5);
        for (mode, keep_low) in [(0.0, true), (1.0, true), (2.0, false), (3.0, false)] {
            p[0] = mode;
            let mut f = MultiFilter::new(sr, &p);
            let (h, _) = run(&mut f, &p, &hi, &hi);
            let mut f = MultiFilter::new(sr, &p);
            let (l, _) = run(&mut f, &p, &lo, &lo);
            let (keep, cut) = if keep_low {
                (rms(&l[12000..]), rms(&h[12000..]))
            } else {
                (rms(&h[12000..]), rms(&l[12000..]))
            };
            assert!(
                keep > 0.3 && cut < 0.05,
                "모드 {mode}: 남김 {keep} 깎음 {cut}"
            );
        }
    }

    #[test]
    fn envfilter_opens_with_level() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 1.0;
        p[1] = 300.0;
        p[2] = 4.0;
        p[3] = 0.0;
        p[4] = 5.0;
        p[5] = 100.0;
        p[6] = 3.0;
        p[7] = 1.0;
        let mut e = EnvFilter::new(sr, &p);
        let quiet = sine(220.0, sr, 9600, 0.004);
        run(&mut e, &p, &quiet, &quiet);
        let mut m = [0.0; 16];
        e.meters(&mut m);
        let closed = m[0];
        let loud = sine(220.0, sr, 9600, 0.9);
        run(&mut e, &p, &loud, &loud);
        e.meters(&mut m);
        assert!(m[0] > closed * 4.0, "크게 치면 열린다 {closed} → {}", m[0]);
    }
}

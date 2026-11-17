//! 딜레이 — 테이프 딜레이 · 스테레오 딜레이 · 딜레이 디자이너(멀티탭) (2단계).

use super::{Effect, Params};
use crate::blocks::biquad::OnePole;
use crate::blocks::delay::DelayLine;
use crate::blocks::lfo::{Lfo, Shape};
use crate::blocks::rng::Rng;
use crate::blocks::smooth::Smooth;

const MAX_DELAY_SEC: f32 = 4.0;

fn equal_power(mix: f32) -> (f32, f32) {
    let m = mix.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    (m.cos(), m.sin())
}

/// 되먹임 안 포화 — 3차 다항식이라 **3배음까지만** 만든다. 되먹임 경로는 하이컷(최대 8kHz)을 먼저
/// 지나므로 3배음이 24kHz 를 넘지 않는다 → 오버샘플링 없이도 접힘이 없다 (`CLAUDE.md` 오버샘플링 원칙의 근거)
#[inline(always)]
fn soft3(x: f32, amount: f32) -> f32 {
    if amount <= 0.0 {
        return x;
    }
    let d = 1.0 + 2.0 * amount;
    let y = (x * d).clamp(-1.0, 1.0);
    (y - y * y * y / 3.0) * 1.5 / d
}

// ---------------------------------------------------------------------------
// 테이프 딜레이 (Logic Tape Delay) — 반복마다 어두워지고, 와우(느린 흔들림)·플러터(빠른 떨림)가
// 음정을 살짝 흔든다. 되먹임이 1 을 넘어도 포화가 붙잡아 폭주하지 않는다(자기 발진 연출).
// 파라미터: 0 시간 ms · 1 되먹임 0..1.1 · 2 섞기 · 3 와우 · 4 플러터 · 5 로우컷 Hz · 6 하이컷 Hz · 7 포화
// ---------------------------------------------------------------------------

pub struct TapeDelay {
    sr: f32,
    dl: DelayLine,
    dr: DelayLine,
    time: Smooth,
    fb: Smooth,
    dry: Smooth,
    wet: Smooth,
    wow: Lfo,
    flutter: Lfo,
    wow_amt: f32,
    flutter_amt: f32,
    lc_l: OnePole,
    lc_r: OnePole,
    hc_l: OnePole,
    hc_r: OnePole,
    sat: f32,
    rng: Rng,
    drift: f32,
}

impl TapeDelay {
    pub fn new(sr: f32, p: &Params) -> Self {
        let n = (MAX_DELAY_SEC * sr) as usize + 64;
        let mut t = Self {
            sr,
            dl: DelayLine::new(n),
            dr: DelayLine::new(n),
            time: Smooth::new(120.0, sr),
            fb: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            wow: Lfo::new(0.0),
            flutter: Lfo::new(0.25),
            wow_amt: 0.0,
            flutter_amt: 0.0,
            lc_l: OnePole::default(),
            lc_r: OnePole::default(),
            hc_l: OnePole::default(),
            hc_r: OnePole::default(),
            sat: 0.0,
            rng: Rng::new(0x7a9e),
            drift: 0.0,
        };
        t.wow.set_rate(0.6, sr);
        t.flutter.set_rate(7.3, sr);
        t.set_params(p);
        t
    }
}

impl Effect for TapeDelay {
    fn set_params(&mut self, p: &Params) {
        // 시간을 바꾸면 테이프 속도가 바뀌듯 음정이 미끄러진다 (120ms 스무딩) — Logic 도 그렇게 들린다
        self.time
            .set(p[0].clamp(10.0, MAX_DELAY_SEC * 1000.0) * 0.001 * self.sr);
        self.fb.set(p[1].clamp(0.0, 1.1));
        let (d, w) = equal_power(p[2]);
        self.dry.set(d);
        self.wet.set(w);
        self.wow_amt = p[3].clamp(0.0, 1.0);
        self.flutter_amt = p[4].clamp(0.0, 1.0);
        let lc = p[5].clamp(20.0, 2000.0);
        let hc = p[6].clamp(500.0, 8000.0);
        for f in [&mut self.lc_l, &mut self.lc_r] {
            f.set_freq(lc, self.sr);
        }
        for f in [&mut self.hc_l, &mut self.hc_r] {
            f.set_freq(hc, self.sr);
        }
        self.sat = p[7].clamp(0.0, 1.0);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            // 와우: 최대 ±0.4% 시간, 플러터 ±0.05% + 조금의 무작위 표류
            self.drift = self.drift * 0.9995 + self.rng.bipolar() * 0.0005;
            let base = self.time.tick();
            let m = 1.0
                + 0.004 * self.wow_amt * (self.wow.tick(Shape::Sine) + self.drift * 20.0)
                + 0.0005 * self.flutter_amt * self.flutter.tick(Shape::Sine);
            let d = (base * m).max(1.0);
            let yl = self.dl.read(d);
            let yr = self.dr.read(d * 1.003); // 좌우 헤드가 아주 조금 다르다 — 폭
            let fb = self.fb.tick();
            let wl = soft3(self.hc_l.lp(self.lc_l.hp(yl)), self.sat);
            let wr = soft3(self.hc_r.lp(self.lc_r.hp(yr)), self.sat);
            // 되먹임이 1 을 넘으면 포화가 붙잡는다 — 포화가 0 이어도 잡히게 최소한의 연성 한계
            let cap = |v: f32| {
                if v.abs() > 1.5 {
                    v.signum() * (1.5 + (v.abs() - 1.5).tanh() * 0.2)
                } else {
                    v
                }
            };
            self.dl.push(cap(l[i] + wl * fb));
            self.dr.push(cap(r[i] + wr * fb));
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * dg + wl * wg;
            r[i] = r[i] * dg + wr * wg;
        }
    }
}

// ---------------------------------------------------------------------------
// 스테레오 딜레이 (Logic Stereo Delay) — 좌우 따로, 교차 되먹임(핑퐁).
// 파라미터: 0 왼쪽 ms · 1 오른쪽 ms · 2 되먹임 · 3 교차(0 = 제자리, 1 = 완전 핑퐁) · 4 섞기 ·
//           5 로우컷 · 6 하이컷
// ---------------------------------------------------------------------------

pub struct StereoDelay {
    sr: f32,
    dl: DelayLine,
    dr: DelayLine,
    tl: Smooth,
    tr: Smooth,
    fb: Smooth,
    cross: Smooth,
    dry: Smooth,
    wet: Smooth,
    lc: [OnePole; 2],
    hc: [OnePole; 2],
}

impl StereoDelay {
    pub fn new(sr: f32, p: &Params) -> Self {
        let n = (MAX_DELAY_SEC * sr) as usize + 64;
        let mut s = Self {
            sr,
            dl: DelayLine::new(n),
            dr: DelayLine::new(n),
            tl: Smooth::new(60.0, sr),
            tr: Smooth::new(60.0, sr),
            fb: Smooth::new(20.0, sr),
            cross: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            lc: [OnePole::default(); 2],
            hc: [OnePole::default(); 2],
        };
        s.set_params(p);
        s
    }
}

impl Effect for StereoDelay {
    fn set_params(&mut self, p: &Params) {
        let max = MAX_DELAY_SEC * 1000.0;
        self.tl.set(p[0].clamp(1.0, max) * 0.001 * self.sr);
        self.tr.set(p[1].clamp(1.0, max) * 0.001 * self.sr);
        self.fb.set(p[2].clamp(0.0, 0.98));
        self.cross.set(p[3].clamp(0.0, 1.0));
        let (d, w) = equal_power(p[4]);
        self.dry.set(d);
        self.wet.set(w);
        for f in &mut self.lc {
            f.set_freq(p[5].clamp(20.0, 2000.0), self.sr);
        }
        for f in &mut self.hc {
            f.set_freq(p[6].clamp(500.0, 20000.0), self.sr);
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let yl = self.hc[0].lp(self.lc[0].hp(self.dl.read(self.tl.tick())));
            let yr = self.hc[1].lp(self.lc[1].hp(self.dr.read(self.tr.tick())));
            let (fb, c) = (self.fb.tick(), self.cross.tick());
            // 핑퐁: 되먹임이 반대쪽으로 간다. 입력은 그대로 제 쪽으로
            self.dl.push(l[i] + fb * (yl * (1.0 - c) + yr * c));
            self.dr.push(r[i] + fb * (yr * (1.0 - c) + yl * c));
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * dg + yl * wg;
            r[i] = r[i] * dg + yr * wg;
        }
    }
}

// ---------------------------------------------------------------------------
// 딜레이 디자이너 (Logic Delay Designer) — 탭 여섯 개, 탭마다 시간·크기·좌우.
// 되먹임은 마지막(가장 늦은) 탭에서 입력으로 — 리듬 패턴이 통째로 반복된다.
// 파라미터: 탭 k(0..6) 마다 3k 시간 ms · 3k+1 크기 · 3k+2 좌우(−1..1) ·
//           18 되먹임 · 19 섞기 · 20 로우컷 · 21 하이컷
// ---------------------------------------------------------------------------

const TAPS: usize = 6;

pub struct DelayDesigner {
    sr: f32,
    dl: DelayLine,
    dr: DelayLine,
    times: [Smooth; TAPS],
    gains: [(Smooth, Smooth); TAPS],
    fb: Smooth,
    dry: Smooth,
    wet: Smooth,
    lc: [OnePole; 2],
    hc: [OnePole; 2],
    last: usize,
    fb_l: f32,
    fb_r: f32,
}

impl DelayDesigner {
    pub fn new(sr: f32, p: &Params) -> Self {
        let n = (MAX_DELAY_SEC * sr) as usize + 64;
        let mut d = Self {
            sr,
            dl: DelayLine::new(n),
            dr: DelayLine::new(n),
            times: [Smooth::new(60.0, sr); TAPS],
            gains: [(Smooth::new(20.0, sr), Smooth::new(20.0, sr)); TAPS],
            fb: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            lc: [OnePole::default(); 2],
            hc: [OnePole::default(); 2],
            last: 0,
            fb_l: 0.0,
            fb_r: 0.0,
        };
        d.set_params(p);
        d
    }
}

impl Effect for DelayDesigner {
    fn set_params(&mut self, p: &Params) {
        let mut longest = (0.0, 0);
        for k in 0..TAPS {
            let t = p[3 * k].clamp(1.0, MAX_DELAY_SEC * 1000.0);
            self.times[k].set(t * 0.001 * self.sr);
            let level = p[3 * k + 1].clamp(0.0, 1.0);
            if level > 0.0 && t > longest.0 {
                longest = (t, k);
            }
            // 등가 파워 팬
            let pan = (p[3 * k + 2].clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
            self.gains[k].0.set(level * pan.cos());
            self.gains[k].1.set(level * pan.sin());
        }
        self.last = longest.1;
        self.fb.set(p[18].clamp(0.0, 0.95));
        let (d, w) = equal_power(p[19]);
        self.dry.set(d);
        self.wet.set(w);
        for f in &mut self.lc {
            f.set_freq(p[20].clamp(20.0, 2000.0), self.sr);
        }
        for f in &mut self.hc {
            f.set_freq(p[21].clamp(500.0, 20000.0), self.sr);
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            // 입력은 모노로 합쳐 넣고(탭마다 좌우를 정한다) 되먹임은 마지막 탭 위치의 소리
            self.dl.push(0.5 * (l[i] + r[i]) + self.fb_l);
            self.dr.push(self.fb_r);
            let mut ol = 0.0;
            let mut or = 0.0;
            let mut last = 0.0;
            for k in 0..TAPS {
                let d = self.times[k].tick();
                let (gl, gr) = (self.gains[k].0.tick(), self.gains[k].1.tick());
                let s = self.dl.read(d) + self.dr.read(d);
                ol += s * gl;
                or += s * gr;
                if k == self.last {
                    last = s;
                }
            }
            let fb = self.fb.tick();
            let shaped = self.hc[0].lp(self.lc[0].hp(last));
            self.fb_l = shaped * fb;
            self.fb_r = 0.0;
            let ol = self.hc[1].lp(ol);
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = l[i] * dg + ol * wg;
            r[i] = r[i] * dg + or * wg;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    fn impulse(n: usize) -> Vec<f32> {
        let mut x = vec![0.0; n];
        x[0] = 1.0;
        x
    }

    fn first_echo(y: &[f32], from: usize) -> usize {
        from + y[from..].iter().position(|v| v.abs() > 0.05).unwrap()
    }

    #[test]
    fn tape_delay_echo_at_time_and_darker() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 100.0;
        p[1] = 0.5;
        p[2] = 1.0;
        p[5] = 20.0;
        p[6] = 3000.0;
        let mut t = TapeDelay::new(sr, &p);
        let (l, _) = run(&mut t, &p, &impulse(24000), &impulse(24000));
        let at = first_echo(&l, 10);
        assert!((at as i32 - 4800).abs() < 30, "첫 메아리 {at}");
        // 두 번째 메아리는 더 작다
        let second = peak(&l[9000..10500]);
        assert!(second < peak(&l[4000..5600]));
    }

    #[test]
    fn tape_feedback_above_one_stays_bounded() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 50.0;
        p[1] = 1.1;
        p[2] = 1.0;
        p[5] = 20.0;
        p[6] = 5000.0;
        p[7] = 0.5;
        let mut t = TapeDelay::new(sr, &p);
        let x = sine(300.0, sr, 96000, 0.5);
        let (l, _) = run(&mut t, &p, &x, &x);
        assert!(peak(&l) < 4.0, "자기 발진이어도 묶인다 {}", peak(&l));
    }

    #[test]
    fn stereo_delay_ping_pong() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        p[0] = 100.0;
        p[1] = 100.0;
        p[2] = 0.6;
        p[3] = 1.0;
        p[4] = 1.0;
        p[5] = 20.0;
        p[6] = 20000.0;
        let mut s = StereoDelay::new(sr, &p);
        let x = impulse(20000);
        let zero = vec![0.0; 20000];
        let (l, r) = run(&mut s, &p, &x, &zero);
        // 왼쪽에만 넣으면: 100ms 왼쪽, 200ms 오른쪽, 300ms 왼쪽
        assert!(peak(&l[4700..4900]) > 0.5 && peak(&r[4700..4900]) < 0.05);
        assert!(peak(&r[9500..9700]) > 0.3 && peak(&l[9500..9700]) < 0.05);
    }

    #[test]
    fn delay_designer_taps_land_where_set() {
        let sr = 48000.0;
        let mut p = [0.0; 24];
        for (k, (t, lvl, pan)) in [(50.0, 1.0, -1.0), (120.0, 0.6, 1.0)].iter().enumerate() {
            p[3 * k] = *t;
            p[3 * k + 1] = *lvl;
            p[3 * k + 2] = *pan;
        }
        p[18] = 0.0;
        p[19] = 1.0;
        p[20] = 20.0;
        p[21] = 20000.0;
        let mut d = DelayDesigner::new(sr, &p);
        let x = impulse(12000);
        let (l, r) = run(&mut d, &p, &x, &x);
        assert!(
            peak(&l[2350..2450]) > 0.5 && peak(&r[2350..2450]) < 0.01,
            "50ms 왼쪽"
        );
        assert!(
            peak(&r[5700..5820]) > 0.3 && peak(&l[5700..5820]) < 0.01,
            "120ms 오른쪽"
        );
    }
}

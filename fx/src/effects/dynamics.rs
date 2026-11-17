//! 다이내믹스 — 익스팬더 · 디에서 · 엔벨로퍼 · 컴프레서(모델) · 어댑티브 리미터 (1단계).

use super::{Effect, Meters, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind};
use crate::blocks::delay::DelayLine;
use crate::blocks::env::{compress_db, expand_db, Follower, GainSmoother};
use crate::blocks::oversample::{self, Oversampler};
use crate::blocks::smooth::Smooth;
use crate::blocks::{db_to_gain, gain_to_db, time_coef};

// ---------------------------------------------------------------------------
// 익스팬더 (Logic Expander) — 스레숄드 아래를 레이시오만큼 더 낮춘다. 게이트의 부드러운 형제.
// 파라미터: 0 스레숄드 · 1 레이시오 · 2 바닥(줄임 한도) · 3 어택 · 4 릴리즈 · 5 니 · 6 메이크업
// 미터: 0 게인 감소
// ---------------------------------------------------------------------------

pub struct Expander {
    sr: f32,
    det: Follower,
    gs: GainSmoother,
    p: [f32; 7],
    makeup: Smooth,
}

impl Expander {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut det = Follower::new(sr);
        det.set_times(0.5, 30.0, sr);
        let mut e = Self {
            sr,
            det,
            gs: GainSmoother::new(),
            p: [0.0; 7],
            makeup: Smooth::new(20.0, sr),
        };
        e.set_params(p);
        e
    }
}

impl Effect for Expander {
    fn set_params(&mut self, p: &Params) {
        self.p = [
            p[0].clamp(-100.0, 0.0),
            p[1].clamp(1.0, 20.0),
            p[2].clamp(-100.0, 0.0),
            p[3].clamp(0.05, 200.0),
            p[4].clamp(5.0, 3000.0),
            p[5].clamp(0.0, 24.0),
            p[6].clamp(-24.0, 24.0),
        ];
        // 어택 = 여는 속도 (게이트와 같은 방향)
        self.gs.set_times(self.p[4], self.p[3], self.sr);
        self.makeup.set(db_to_gain(self.p[6]));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let lvl = self.det.tick(l[i].abs().max(r[i].abs()));
            let target = expand_db(lvl, self.p[0], self.p[1], self.p[2], self.p[5]);
            let g = db_to_gain(self.gs.tick(target)) * self.makeup.tick();
            l[i] *= g;
            r[i] *= g;
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.gs.db();
    }
}

// ---------------------------------------------------------------------------
// 디에서 (Logic DeEsser 2) — 치찰음 대역만 감지해 누른다.
// 분할 모드: 치찰음 대역(대역통과, 가운데 이득 1·위상 0)만 빼서 줄인다 — y = x − 대역·(1−g).
// 줄임이 없으면(g=1) 원음 그대로다. 하이패스로 가르면 가운데에서도 위상이 돌아 3~4dB 밖에 안 준다.
// 파라미터: 0 주파수 · 1 스레숄드 · 2 최대 줄임 · 3 모드(분할/전체) · 4 어택 · 5 릴리즈
// 미터: 0 게인 감소 · 1 감지 레벨
// ---------------------------------------------------------------------------

pub struct DeEsser {
    sr: f32,
    freq: f32,
    key_l: Biquad,
    key_r: Biquad,
    hp_l: Biquad,
    hp_r: Biquad,
    det: Follower,
    gs: GainSmoother,
    threshold: f32,
    range: f32,
    split: bool,
}

impl DeEsser {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut d = Self {
            sr,
            freq: -1.0,
            key_l: Biquad::default(),
            key_r: Biquad::default(),
            hp_l: Biquad::default(),
            hp_r: Biquad::default(),
            det: Follower::new(sr),
            gs: GainSmoother::new(),
            threshold: -30.0,
            range: -12.0,
            split: true,
        };
        d.set_params(p);
        d
    }
}

impl Effect for DeEsser {
    fn set_params(&mut self, p: &Params) {
        let f = p[0].clamp(1500.0, 16000.0);
        if f != self.freq {
            self.freq = f;
            let sr = self.sr as f64;
            let key = Coefs::new(Kind::BandPass, f as f64, 1.4, 0.0, sr);
            self.key_l.set(key);
            self.key_r.set(key);
            let band = Coefs::new(Kind::BandPass, f as f64, 0.9, 0.0, sr);
            self.hp_l.set(band);
            self.hp_r.set(band);
        }
        self.threshold = p[1].clamp(-60.0, 0.0);
        self.range = p[2].clamp(-30.0, 0.0);
        self.split = p[3] < 0.5;
        let attack = p[4].clamp(0.1, 50.0);
        let release = p[5].clamp(5.0, 500.0);
        self.det.set_times(attack * 0.5, release, self.sr);
        self.gs.set_times(attack, release, self.sr);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let kl = self.key_l.tick(l[i]);
            let kr = self.key_r.tick(r[i]);
            let lvl = self.det.tick(kl.abs().max(kr.abs()));
            let red = compress_db(lvl, self.threshold, 6.0, 3.0).max(self.range);
            let g = db_to_gain(self.gs.tick(red));
            if self.split {
                let hl = self.hp_l.tick(l[i]);
                let hr = self.hp_r.tick(r[i]);
                l[i] -= hl * (1.0 - g);
                r[i] -= hr * (1.0 - g);
            } else {
                l[i] *= g;
                r[i] *= g;
            }
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.gs.db();
        out[1] = self.det.db();
    }
}

// ---------------------------------------------------------------------------
// 엔벨로퍼 (Logic Enveloper) — 트랜지언트 셰이퍼. 빠른 감지 − 느린 감지 = 어택 구간.
// 어택 구간이면 어택 게인, 잦아드는 구간이면 서스테인 게인을 그 정도만큼 건다.
// 파라미터: 0 어택 게인 dB · 1 서스테인 게인 dB · 2 어택 감지 ms · 3 릴리즈 감지 ms · 4 출력 dB
// 미터: 0 지금 거는 게인 dB
// ---------------------------------------------------------------------------

pub struct Enveloper {
    sr: f32,
    fast: Follower,
    slow: Follower,
    attack_db: f32,
    sustain_db: f32,
    gain: Smooth,
    out: Smooth,
    now_db: f32,
}

impl Enveloper {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut e = Self {
            sr,
            fast: Follower::new(sr),
            slow: Follower::new(sr),
            attack_db: 0.0,
            sustain_db: 0.0,
            gain: Smooth::new(1.0, sr),
            out: Smooth::new(20.0, sr),
            now_db: 0.0,
        };
        e.set_params(p);
        e
    }
}

impl Effect for Enveloper {
    fn set_params(&mut self, p: &Params) {
        self.attack_db = p[0].clamp(-24.0, 24.0);
        self.sustain_db = p[1].clamp(-24.0, 24.0);
        let att = p[2].clamp(0.1, 50.0);
        let rel = p[3].clamp(10.0, 2000.0);
        self.fast.set_times(att * 0.1, rel * 0.3, self.sr);
        self.slow.set_times(att * 4.0, rel, self.sr);
        self.out.set(db_to_gain(p[4].clamp(-24.0, 24.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let m = l[i].abs().max(r[i].abs());
            let diff = self.fast.tick(m) - self.slow.tick(m);
            // 6dB 차이면 최대 — 그 아래는 비례
            let db = if diff > 0.0 {
                self.attack_db * (diff / 6.0).min(1.0)
            } else {
                self.sustain_db * (-diff / 6.0).min(1.0)
            };
            self.gain.set(db);
            self.now_db = self.gain.tick();
            let g = db_to_gain(self.now_db) * self.out.tick();
            l[i] *= g;
            r[i] *= g;
        }
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.now_db;
    }
}

// ---------------------------------------------------------------------------
// 컴프레서 (Logic Compressor 의 회로 모델) — 같은 게인 계산에 감지 방식·속도·색이 다르다.
//   0 플래티넘(디지털): 피크 감지, 색 없음
//   1 스튜디오 VCA: RMS 감지
//   2 스튜디오 FET: 아주 빠른 어택, 피크, 릴리즈가 들어온 양에 따라 짧아진다
//   3 빈티지 옵토: RMS, 많이 누를수록 릴리즈가 길어진다(광소자 잔광)
//   4 빈티지 VCA: 출력에서 감지하는 피드백 구조 — 부드럽게 붙는다
// 색(포화)은 4배 오버샘플링 안에서 — 지연 16 샘플, 드라이도 같이 늦춰 섞는다.
// 파라미터: 0 모델 · 1 스레숄드 · 2 레이시오 · 3 어택 · 4 릴리즈 · 5 니 · 6 메이크업 ·
//           7 자동 게인(0/1) · 8 섞기(병렬) · 9 감지 로우컷 Hz · 10 색 0..1
// 미터: 0 게인 감소 · 1 입력 dB · 2 출력 dB
// ---------------------------------------------------------------------------

pub struct CompModel {
    sr: f32,
    model: u32,
    det: Follower,
    gs: GainSmoother,
    threshold: f32,
    ratio: f32,
    knee: f32,
    attack: f32,
    release: f32,
    makeup: Smooth,
    wet: Smooth,
    dry: Smooth,
    color: f32,
    sc_l: Biquad,
    sc_r: Biquad,
    sc_hz: f32,
    os_l: Oversampler,
    os_r: Oversampler,
    dly_l: DelayLine,
    dly_r: DelayLine,
    wet_l: DelayLine,
    wet_r: DelayLine,
    last_out: f32,
    meter_in: f32,
    meter_out: f32,
}

impl CompModel {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut c = Self {
            sr,
            model: 0,
            det: Follower::new(sr),
            gs: GainSmoother::new(),
            threshold: -18.0,
            ratio: 3.0,
            knee: 3.0,
            attack: 5.0,
            release: 150.0,
            makeup: Smooth::new(20.0, sr),
            wet: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            color: 0.0,
            sc_l: Biquad::default(),
            sc_r: Biquad::default(),
            sc_hz: -1.0,
            os_l: Oversampler::new(),
            os_r: Oversampler::new(),
            dly_l: DelayLine::new(64),
            dly_r: DelayLine::new(64),
            wet_l: DelayLine::new(64),
            wet_r: DelayLine::new(64),
            last_out: 0.0,
            meter_in: -120.0,
            meter_out: -120.0,
        };
        c.set_params(p);
        c
    }
}

impl Effect for CompModel {
    fn set_params(&mut self, p: &Params) {
        self.model = p[0].clamp(0.0, 4.0).round() as u32;
        self.threshold = p[1].clamp(-60.0, 0.0);
        self.ratio = p[2].clamp(1.0, 30.0);
        let mut attack = p[3].clamp(0.02, 300.0);
        self.release = p[4].clamp(5.0, 3000.0);
        self.knee = p[5].clamp(0.0, 24.0);
        if self.model == 2 {
            attack *= 0.25;
        }
        self.attack = attack;
        self.det.set_rms(matches!(self.model, 1 | 3));
        self.det
            .set_times(attack * 0.3, self.release * 0.3, self.sr);
        self.gs.set_times(attack, self.release, self.sr);
        let auto = if p[7] >= 0.5 {
            -0.5 * compress_db(0.0, self.threshold, self.ratio, self.knee)
        } else {
            0.0
        };
        self.makeup.set(db_to_gain(p[6].clamp(-24.0, 24.0) + auto));
        let mix = p[8].clamp(0.0, 1.0);
        self.wet.set(mix);
        self.dry.set(1.0 - mix);
        let hz = p[9].clamp(20.0, 1000.0);
        if hz != self.sc_hz {
            self.sc_hz = hz;
            let c = Coefs::new(Kind::HighPass, hz as f64, 0.707, 0.0, self.sr as f64);
            self.sc_l.set(c);
            self.sc_r.set(c);
        }
        self.color = p[10].clamp(0.0, 1.0);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let drive = 1.0 + 4.0 * self.color;
        let norm = 1.0 / drive.tanh();
        let mut peak_in = 0f32;
        let mut peak_out = 0f32;
        for i in 0..l.len() {
            let (xl, xr) = (l[i], r[i]);
            peak_in = peak_in.max(xl.abs().max(xr.abs()));
            let key = if self.model == 4 {
                self.last_out
            } else {
                self.sc_l.tick(xl).abs().max(self.sc_r.tick(xr).abs())
            };
            let lvl = self.det.tick(key);
            let red = compress_db(lvl, self.threshold, self.ratio, self.knee);
            if self.model == 3 {
                // 옵토: 많이 누를수록 늦게 풀린다
                let slow = self.release * (1.0 + (-self.gs.db()) / 6.0);
                self.gs.set_times(self.attack, slow, self.sr);
            } else if self.model == 2 {
                // FET: 짧은 피크는 빨리, 오래 누르면 원래 릴리즈
                let fast = self.release * (0.4 + 0.6 * ((-self.gs.db()) / 12.0).min(1.0));
                self.gs.set_times(self.attack, fast, self.sr);
            }
            let g = db_to_gain(self.gs.tick(red)) * self.makeup.tick();
            let (cl, cr) = (xl * g, xr * g);
            // 색 — 포화는 4배 안에서. 색 0 이어도 같은 경로(지연을 일정하게)
            let c = self.color;
            let sat = |s: f32| {
                if c > 0.0 {
                    (s * drive).tanh() * norm
                } else {
                    s
                }
            };
            self.dly_l.push(xl);
            self.dly_r.push(xr);
            self.wet_l.push(cl);
            self.wet_r.push(cr);
            let lat = oversample::LATENCY;
            // 색이 0 이면 포화가 없다 — 4배 필터 대신 같은 길이의 순수 지연 (비용이 반 이하)
            let (wl, wr) = if c > 0.0 {
                (
                    oversample::process(&mut self.os_l, cl, sat),
                    oversample::process(&mut self.os_r, cr, sat),
                )
            } else {
                (self.wet_l.tap(lat), self.wet_r.tap(lat))
            };
            let (dg, wg) = (self.dry.tick(), self.wet.tick());
            l[i] = self.dly_l.tap(lat) * dg + wl * wg;
            r[i] = self.dly_r.tap(lat) * dg + wr * wg;
            self.last_out = cl.abs().max(cr.abs());
            peak_out = peak_out.max(l[i].abs().max(r[i].abs()));
        }
        self.meter_in = gain_to_db(peak_in);
        self.meter_out = gain_to_db(peak_out);
    }

    fn latency(&self) -> usize {
        oversample::LATENCY
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.gs.db();
        out[1] = self.meter_in;
        out[2] = self.meter_out;
    }
}

// ---------------------------------------------------------------------------
// 어댑티브 리미터 (Logic Adaptive Limiter) — 룩어헤드 + 트루 피크.
//
// 1) 감지는 4배로 올려(트루 피크) 넷 중 최대 → 이 표본에서 필요한 게인 t = min(1, 천장/피크)
// 2) 룩어헤드 창(128+4) 최소값 → 3) 128 길이 상자 평균 → 4) 릴리즈(풀릴 때만 천천히)
// 원음은 137 샘플 늦춰 내보낸다 — 감지 FIR 지연(약 8.4)을 포함해 피크가 지나갈 때 게인이 이미 내려가 있다.
// 마지막에 천장으로 안전 클립(넘는 일이 거의 없게 설계했지만 혹시 모를 겹침 대비).
// 파라미터: 0 입력 dB · 1 천장 dBTP · 2 릴리즈 ms
// 미터: 0 게인 감소
// ---------------------------------------------------------------------------

const LOOK: usize = 128;
pub const LIMITER_LATENCY: usize = LOOK + 9;

pub struct AdaptiveLimiter {
    sr: f32,
    input: Smooth,
    ceiling: f32,
    rel: f32,
    os_l: Oversampler,
    os_r: Oversampler,
    /// 최소값 창 — (값, 들어온 순번) 단조 덱
    deque: std::collections::VecDeque<(f32, u64)>,
    count: u64,
    boxbuf: Vec<f32>,
    box_pos: usize,
    box_sum: f64,
    g: f32,
    dly_l: DelayLine,
    dly_r: DelayLine,
    gr_db: f32,
}

impl AdaptiveLimiter {
    pub fn new(sr: f32, p: &Params) -> Self {
        let mut a = Self {
            sr,
            input: Smooth::new(20.0, sr),
            ceiling: 0.89,
            rel: 0.0,
            os_l: Oversampler::new(),
            os_r: Oversampler::new(),
            deque: std::collections::VecDeque::with_capacity(LOOK + 8),
            count: 0,
            boxbuf: vec![1.0; LOOK],
            box_pos: 0,
            box_sum: LOOK as f64,
            g: 1.0,
            dly_l: DelayLine::new(LIMITER_LATENCY + 4),
            dly_r: DelayLine::new(LIMITER_LATENCY + 4),
            gr_db: 0.0,
        };
        a.set_params(p);
        a
    }
}

impl Effect for AdaptiveLimiter {
    fn set_params(&mut self, p: &Params) {
        self.input.set(db_to_gain(p[0].clamp(0.0, 30.0)));
        self.ceiling = db_to_gain(p[1].clamp(-12.0, 0.0));
        self.rel = time_coef(p[2].clamp(5.0, 2000.0), self.sr);
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let mut gr = 0f32;
        for i in 0..l.len() {
            let ig = self.input.tick();
            let (xl, xr) = (l[i] * ig, r[i] * ig);
            let ul = self.os_l.up(xl);
            let ur = self.os_r.up(xr);
            let mut pk = 0f32;
            for k in 0..4 {
                pk = pk.max(ul[k].abs()).max(ur[k].abs());
            }
            let t = if pk > self.ceiling {
                self.ceiling / pk
            } else {
                1.0
            };
            // 최소값 창 (LOOK+4)
            self.count += 1;
            while self.deque.back().is_some_and(|&(v, _)| v >= t) {
                self.deque.pop_back();
            }
            self.deque.push_back((t, self.count));
            while self
                .deque
                .front()
                .is_some_and(|&(_, c)| c + (LOOK as u64 + 4) <= self.count)
            {
                self.deque.pop_front();
            }
            let held = self.deque.front().map_or(1.0, |&(v, _)| v);
            // 상자 평균 (LOOK)
            self.box_sum += (held - self.boxbuf[self.box_pos]) as f64;
            self.boxbuf[self.box_pos] = held;
            self.box_pos = (self.box_pos + 1) % LOOK;
            let smooth = (self.box_sum / LOOK as f64) as f32;
            // 내려갈 때는 바로, 풀릴 때는 릴리즈로
            self.g = if smooth < self.g {
                smooth
            } else {
                smooth + (self.g - smooth) * self.rel
            };
            self.dly_l.push(xl);
            self.dly_r.push(xr);
            let c = self.ceiling;
            l[i] = (self.dly_l.tap(LIMITER_LATENCY) * self.g).clamp(-c, c);
            r[i] = (self.dly_r.tap(LIMITER_LATENCY) * self.g).clamp(-c, c);
            gr = gr.min(gain_to_db(self.g));
        }
        self.gr_db = gr;
    }

    fn latency(&self) -> usize {
        LIMITER_LATENCY
    }

    fn meters(&self, out: &mut Meters) {
        out[0] = self.gr_db;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    fn p(values: &[f32]) -> Params {
        let mut p = [0.0; 24];
        p[..values.len()].copy_from_slice(values);
        p
    }

    #[test]
    fn expander_lowers_quiet_parts() {
        let sr = 48000.0;
        let pp = p(&[-30.0, 4.0, -60.0, 1.0, 50.0, 0.0, 0.0]);
        let mut e = Expander::new(sr, &pp);
        let x = sine(440.0, sr, 24000, 0.01); // −40dB → 10dB 아래 × (4−1) = −30dB 더
        let (l, _) = run(&mut e, &pp, &x, &x);
        let ratio = peak(&l[12000..]) / 0.01;
        assert!(
            (gain_to_db(ratio) + 30.0).abs() < 3.0,
            "{}",
            gain_to_db(ratio)
        );
    }

    #[test]
    fn deesser_split_is_transparent_below_threshold_and_cuts_sibilance() {
        let sr = 48000.0;
        let pp = p(&[6000.0, -30.0, -12.0, 0.0, 1.0, 80.0]);
        let mut d = DeEsser::new(sr, &pp);
        let low = sine(300.0, sr, 24000, 0.5);
        let (l, _) = run(&mut d, &pp, &low, &low);
        // 저역은 감지에 거의 안 걸린다 → 그대로
        assert!((peak(&l[12000..]) - 0.5).abs() < 0.02);
        let mut d = DeEsser::new(sr, &pp);
        let ess = sine(6500.0, sr, 24000, 0.5);
        let (s, _) = run(&mut d, &pp, &ess, &ess);
        assert!(
            peak(&s[12000..]) < 0.5 * db_to_gain(-8.0),
            "치찰음이 눌린다 {}",
            peak(&s[12000..])
        );
    }

    #[test]
    fn enveloper_boosts_attack() {
        let sr = 48000.0;
        let pp = p(&[12.0, 0.0, 5.0, 200.0, 0.0]);
        let mut e = Enveloper::new(sr, &pp);
        let mut x = vec![0.0; 4800];
        x.extend(sine(200.0, sr, 9600, 0.2)); // 갑자기 시작
        let (l, _) = run(&mut e, &pp, &x, &x);
        let head = peak(&l[4800..5800]);
        let tail = peak(&l[12000..]);
        assert!(head > tail * 1.5, "앞이 커진다 head {head} tail {tail}");
    }

    #[test]
    fn comp_models_reduce_by_ratio() {
        let sr = 48000.0;
        for model in 0..5 {
            let pp = p(&[
                model as f32,
                -20.0,
                4.0,
                5.0,
                100.0,
                0.0,
                0.0,
                0.0,
                1.0,
                20.0,
                0.0,
            ]);
            let mut c = CompModel::new(sr, &pp);
            let x = sine(500.0, sr, 48000, 1.0); // 0dB → 20dB 넘음 → 15dB 줄여야
            let (l, _) = run(&mut c, &pp, &x, &x);
            let got = gain_to_db(peak(&l[36000..]));
            // 피크 감지 0dB → −15dB, RMS 감지(−3dB 로 읽음) → 약 −12.75dB.
            // 피드백(모델 4)은 출력을 보고 누르므로 실효 레이시오가 낮다 — 20/(1+0.75) → 약 −8.6dB
            let range = if model == 4 {
                -10.5..=-6.5
            } else {
                -16.5..=-10.0
            };
            assert!(range.contains(&got), "모델 {model}: {got}dB");
        }
    }

    #[test]
    fn comp_latency_matches_dry_path() {
        let sr = 48000.0;
        // 섞기 0 = 드라이만 → 보고한 지연만큼 늦은 원음
        let pp = p(&[0.0, -20.0, 4.0, 5.0, 100.0, 0.0, 0.0, 0.0, 0.0, 20.0, 0.0]);
        let mut c = CompModel::new(sr, &pp);
        let mut x = vec![0.0; 512];
        x[20] = 1.0;
        let (l, _) = run(&mut c, &pp, &x, &x);
        assert_eq!(l.iter().position(|v| *v > 0.5), Some(20 + c.latency()));
        // 섞기 1 (컴프만, 안 누르는 작은 소리) 도 같은 자리
        let pp = p(&[0.0, 0.0, 1.0, 5.0, 100.0, 0.0, 0.0, 0.0, 1.0, 20.0, 0.0]);
        let mut c = CompModel::new(sr, &pp);
        let (w, _) = run(&mut c, &pp, &x, &x);
        let at = w
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .unwrap()
            .0;
        assert_eq!(at, 20 + c.latency());
    }

    #[test]
    fn limiter_never_exceeds_ceiling_and_latency_is_exact() {
        let sr = 48000.0;
        let pp = p(&[12.0, -1.0, 100.0]);
        let mut a = AdaptiveLimiter::new(sr, &pp);
        // 드럼 같은 펄스 + 사인
        let x: Vec<f32> = (0..48000)
            .map(|i| {
                let s = (2.0 * std::f32::consts::PI * 1234.5 * i as f32 / sr).sin() * 0.4;
                if i % 6000 < 30 {
                    s + 0.9
                } else {
                    s
                }
            })
            .collect();
        let (l, _) = run(&mut a, &pp, &x, &x);
        let ceil = db_to_gain(-1.0);
        assert!(peak(&l) <= ceil + 1e-5, "표본 피크 {}", peak(&l));
        // 트루 피크도 거의 천장 안 (4배 보간으로 재 본다)
        let mut os = Oversampler::new();
        let mut tp = 0f32;
        for v in &l {
            for s in os.up(*v) {
                tp = tp.max(s.abs());
            }
        }
        assert!(
            tp <= ceil * db_to_gain(0.3),
            "트루 피크 {}dB",
            gain_to_db(tp)
        );
        // 지연: 작은 임펄스는 줄이지 않고 그대로 늦게
        let pp = p(&[0.0, -1.0, 100.0]);
        let mut a = AdaptiveLimiter::new(sr, &pp);
        let mut imp = vec![0.0; 600];
        imp[50] = 0.5;
        let (o, _) = run(&mut a, &pp, &imp, &imp);
        assert_eq!(o.iter().position(|v| *v > 0.4), Some(50 + LIMITER_LATENCY));
    }
}

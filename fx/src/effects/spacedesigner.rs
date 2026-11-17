//! 스페이스 디자이너 (Logic Space Designer) — 컨볼루션 리버브.
//!
//! Logic 은 실측 IR 을 싣지만 우리는 IR 에셋이 없다 (`CLAUDE.md` "에셋이 없다").
//! 그래서 **IR 을 합성**한다 — 공간 종류마다 초기 반사 패턴·확산 증가 속도·감쇠 곡선이 다르고,
//! 고역이 시간이 갈수록 더 빨리 죽게(시변 저역통과) 만든다. 실측 IR 을 넣을 자리는
//! `Convolver::new` 하나라 나중에 에셋이 생기면 그 IR 을 넘기기만 하면 된다.
//!
//! 지연: 컨볼루션 블록(1024) — 보고하고, 드라이도 같은 만큼 늦춰 맞춘다.
//! 구조 파라미터(공간·길이·감쇠·밝기)는 IR 을 다시 만들어야 해서 오토메이션 대상이 아니다.
//!
//! 파라미터: 0 섞기(0..1) · 1 공간(0 방·1 홀·2 체임버·3 성당·4 플레이트) · 2 길이 s ·
//!           3 프리딜레이 ms · 4 고역 감쇠 Hz · 5 로우컷 Hz · 6 폭(0..1.5) · 7 출력 dB

use super::{Effect, Params};
use crate::blocks::biquad::{Biquad, Coefs, Kind};
use crate::blocks::conv::Convolver;
use crate::blocks::delay::DelayLine;
use crate::blocks::rng::Rng;
use crate::blocks::smooth::Smooth;
use crate::blocks::{db_to_gain, flush};

const BLOCK: usize = 1024;
const MAX_PREDELAY_MS: f32 = 250.0;

pub struct SpaceDesigner {
    sr: f32,
    conv: Convolver,
    shape: (u32, f32, f32),
    pre_l: DelayLine,
    pre_r: DelayLine,
    dry_l: DelayLine,
    dry_r: DelayLine,
    predelay: Smooth,
    wet: Smooth,
    dry: Smooth,
    width: Smooth,
    out: Smooth,
    lowcut_l: Biquad,
    lowcut_r: Biquad,
    lowcut_hz: f32,
}

/// 공간 종류별 성격 — (초기 반사 수, 반사가 퍼지는 시간 ms, 확산이 차오르는 시간 ms, 감쇠 곡선 휨)
const SPACES: [(usize, f32, f32, f32); 5] = [
    (10, 25.0, 30.0, 1.0),   // 방: 반사가 촘촘하고 금방 찬다
    (8, 70.0, 90.0, 1.0),    // 홀
    (14, 45.0, 50.0, 1.15),  // 체임버: 단단한 벽, 반사 많음
    (6, 120.0, 160.0, 0.85), // 성당: 늦고 길게
    (0, 0.0, 5.0, 1.0),      // 플레이트: 반사 없이 곧바로 빽빽한 확산
];

/// IR 합성 — 결정적(같은 설정이면 같은 IR)
pub fn synthesize_ir(
    sr: f32,
    space: u32,
    length_sec: f32,
    damping_hz: f32,
) -> (Vec<f32>, Vec<f32>) {
    let (taps, spread_ms, build_ms, curve) = SPACES[(space as usize).min(SPACES.len() - 1)];
    let n = ((length_sec.clamp(0.1, 8.0)) * sr) as usize;
    let mut out = (vec![0.0f32; n], vec![0.0f32; n]);
    for (ch, data) in [&mut out.0, &mut out.1].into_iter().enumerate() {
        let mut rng = Rng::new(0x51ace + ch as u32 * 7919 + space * 131);
        let mut z = 0.0f32;
        let build = (build_ms * 0.001 * sr).max(1.0);
        let start = (2.0 * 0.001 * sr) as usize + ch * 7;
        let mut energy = 0.0f64;
        for (i, v) in data.iter_mut().enumerate().skip(start) {
            let t = i as f32 / n as f32;
            // 시간이 갈수록 저역통과를 닫는다 — 실제 공간은 고역이 먼저 죽는다
            let cutoff = damping_hz * (1.0 - 0.75 * t).max(0.15);
            let a = (-2.0 * std::f32::consts::PI * cutoff.min(sr * 0.45) / sr).exp();
            z = flush(rng.bipolar() * (1.0 - a) + z * a);
            // −60dB 까지 (길이 = RT60). 곡선 휨: 1 보다 크면 초반이 더 빨리 준다
            let env = 10f32.powf(-3.0 * t.powf(curve));
            let up = ((i - start) as f32 / build).min(1.0);
            *v = z * env * up;
            energy += (*v as f64) * (*v as f64);
        }
        let scale = if energy > 0.0 {
            (0.5 / energy.sqrt()) as f32
        } else {
            0.0
        };
        data.iter_mut().for_each(|v| *v *= scale);
        // 초기 반사 — 좌우가 다른 자리에 (같으면 리버브가 가운데로 뭉친다)
        for k in 0..taps {
            let at_ms = 3.0
                + spread_ms * ((k as f32 + 1.0) / taps as f32).powf(1.4) * (1.0 + 0.13 * ch as f32);
            let at = (at_ms * 0.001 * sr) as usize;
            if at < n {
                let gain = 0.09 * (1.0 - k as f32 / (taps as f32 + 1.0));
                data[at] += if (k + ch) % 2 == 0 { gain } else { -gain };
            }
        }
    }
    out
}

impl SpaceDesigner {
    pub fn new(sr: f32, p: &Params) -> Self {
        let shape = Self::shape_of(p);
        let (l, r) = synthesize_ir(sr, shape.0, shape.1, shape.2);
        let pre = (MAX_PREDELAY_MS * 0.001 * sr) as usize + 4;
        let mut s = Self {
            sr,
            conv: Convolver::new(BLOCK, &l, &r),
            shape,
            pre_l: DelayLine::new(pre),
            pre_r: DelayLine::new(pre),
            dry_l: DelayLine::new(BLOCK + 4),
            dry_r: DelayLine::new(BLOCK + 4),
            predelay: Smooth::new(50.0, sr),
            wet: Smooth::new(20.0, sr),
            dry: Smooth::new(20.0, sr),
            width: Smooth::new(20.0, sr),
            out: Smooth::new(20.0, sr),
            lowcut_l: Biquad::default(),
            lowcut_r: Biquad::default(),
            lowcut_hz: -1.0,
        };
        s.set_params(p);
        s
    }

    fn shape_of(p: &Params) -> (u32, f32, f32) {
        (
            p[1].clamp(0.0, 4.0).round() as u32,
            p[2].clamp(0.1, 8.0),
            p[4].clamp(500.0, 18000.0),
        )
    }
}

impl Effect for SpaceDesigner {
    fn set_params(&mut self, p: &Params) {
        let shape = Self::shape_of(p);
        if shape != self.shape {
            // 구조가 바뀌었다 — IR 을 다시 만든다 (오토메이션 대상이 아니라 드물다)
            self.shape = shape;
            let (l, r) = synthesize_ir(self.sr, shape.0, shape.1, shape.2);
            self.conv = Convolver::new(BLOCK, &l, &r);
        }
        let mix = p[0].clamp(0.0, 1.0);
        let half = std::f32::consts::FRAC_PI_2;
        self.dry.set((mix * half).cos());
        self.wet.set((mix * half).sin());
        self.predelay
            .set(p[3].clamp(0.0, MAX_PREDELAY_MS) * 0.001 * self.sr);
        let lc = p[5].clamp(20.0, 1000.0);
        if lc != self.lowcut_hz {
            self.lowcut_hz = lc;
            let c = Coefs::new(Kind::HighPass, lc as f64, 0.707, 0.0, self.sr as f64);
            self.lowcut_l.set(c);
            self.lowcut_r.set(c);
        }
        self.width.set(p[6].clamp(0.0, 1.5));
        self.out.set(db_to_gain(p[7].clamp(-24.0, 12.0)));
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let (xl, xr) = (l[i], r[i]);
            self.pre_l.push(xl);
            self.pre_r.push(xr);
            let d = self.predelay.tick();
            let (pl, pr) = if d < 1.0 {
                (xl, xr)
            } else {
                (self.pre_l.read(d), self.pre_r.read(d))
            };
            let (wl, wr) = self.conv.tick(pl, pr);
            let (wl, wr) = (self.lowcut_l.tick(wl), self.lowcut_r.tick(wr));
            // 폭: 미드/사이드
            let w = self.width.tick();
            let m = 0.5 * (wl + wr);
            let s = 0.5 * (wl - wr) * w;
            self.dry_l.push(xl);
            self.dry_r.push(xr);
            let (dl, dr) = (self.dry_l.tap(BLOCK), self.dry_r.tap(BLOCK));
            let (dg, wg, o) = (self.dry.tick(), self.wet.tick(), self.out.tick());
            l[i] = (dl * dg + (m + s) * wg) * o;
            r[i] = (dr * dg + (m - s) * wg) * o;
        }
    }

    fn latency(&self) -> usize {
        self.conv.latency()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::testing::*;

    fn params(mix: f32) -> Params {
        let mut p = [0.0; 24];
        p[0] = mix;
        p[1] = 1.0;
        p[2] = 1.5;
        p[3] = 0.0;
        p[4] = 6000.0;
        p[5] = 20.0;
        p[6] = 1.0;
        p[7] = 0.0;
        p
    }

    #[test]
    fn dry_only_is_delayed_by_reported_latency() {
        let sr = 48000.0;
        let p = params(0.0);
        let mut s = SpaceDesigner::new(sr, &p);
        let mut x = vec![0.0; 4096];
        x[10] = 1.0;
        let (l, _) = run(&mut s, &p, &x, &x);
        let at = l.iter().position(|v| v.abs() > 0.5).unwrap();
        assert_eq!(at, 10 + s.latency(), "드라이는 보고한 지연만큼 늦게");
    }

    #[test]
    fn tail_decays_like_rt60() {
        let sr = 48000.0;
        let p = params(1.0);
        let mut s = SpaceDesigner::new(sr, &p);
        let mut x = vec![0.0; (sr * 2.0) as usize];
        x[0] = 1.0;
        let (l, r) = run(&mut s, &p, &x, &x);
        let lat = s.latency();
        let early = rms(&l[lat + 2400..lat + 7200]);
        let late = rms(&l[lat + 60000..lat + 64800]);
        assert!(early > 0.0 && late > 0.0);
        // 1.5초 RT60 → 1.25초 지점은 약 −50dB 근처. 넉넉히 30dB 이상 줄었는지
        assert!(20.0 * (late / early).log10() < -30.0);
        // 좌우가 달라야 넓게 들린다
        let diff: f32 = l.iter().zip(&r).map(|(a, b)| (a - b).abs()).sum();
        assert!(diff > 0.1);
    }

    #[test]
    fn ir_is_deterministic() {
        let a = synthesize_ir(48000.0, 2, 1.0, 5000.0);
        let b = synthesize_ir(48000.0, 2, 1.0, 5000.0);
        assert_eq!(a.0, b.0);
    }
}

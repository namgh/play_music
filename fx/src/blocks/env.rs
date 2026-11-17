//! 레벨 감지 + 게인 계산 — 컴프·게이트·익스팬더·디에서·리미터가 같은 부품을 쓴다.
//!
//! 감지는 **dB 영역에서 어택/릴리즈 분리 스무딩**(분기형). 선형 영역에서 하면
//! 릴리즈 곡선이 dB 로 보면 휘어서 "숨 쉬는" 느낌이 모델마다 달라진다.

use super::{gain_to_db, time_coef};

/// 피크(또는 RMS) 레벨 → dB, 어택/릴리즈 분기 스무딩
#[derive(Clone, Copy, Debug)]
pub struct Follower {
    att: f32,
    rel: f32,
    db: f32,
    rms: bool,
    ms: f32,
    rms_coef: f32,
}

impl Follower {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            att: 0.0,
            rel: 0.0,
            db: -120.0,
            rms: false,
            ms: 0.0,
            rms_coef: time_coef(10.0, sample_rate),
        }
    }

    pub fn set_times(&mut self, attack_ms: f32, release_ms: f32, sample_rate: f32) {
        self.att = time_coef(attack_ms, sample_rate);
        self.rel = time_coef(release_ms, sample_rate);
    }

    pub fn set_rms(&mut self, rms: bool) {
        self.rms = rms;
    }

    /// 입력 크기(절대값) → 스무딩된 dB
    #[inline(always)]
    pub fn tick(&mut self, magnitude: f32) -> f32 {
        let level = if self.rms {
            self.ms = magnitude * magnitude + (self.ms - magnitude * magnitude) * self.rms_coef;
            self.ms.max(0.0).sqrt()
        } else {
            magnitude
        };
        let x = gain_to_db(level).max(-120.0);
        let coef = if x > self.db { self.att } else { self.rel };
        self.db = x + (self.db - x) * coef;
        self.db
    }

    pub fn db(&self) -> f32 {
        self.db
    }
}

/// 컴프레서 게인 계산 (소프트 니) — 입력 dB → 줄일 dB (음수)
#[inline(always)]
pub fn compress_db(x: f32, threshold: f32, ratio: f32, knee: f32) -> f32 {
    let over = x - threshold;
    let slope = 1.0 / ratio.max(1.0) - 1.0;
    if knee > 0.0 && over.abs() <= knee / 2.0 {
        let t = over + knee / 2.0;
        slope * t * t / (2.0 * knee)
    } else if over > 0.0 {
        slope * over
    } else {
        0.0
    }
}

/// 익스팬더/게이트 게인 계산 — 스레숄드 아래를 `ratio` 배로 더 내린다, 바닥은 `range`(음수 dB)
#[inline(always)]
pub fn expand_db(x: f32, threshold: f32, ratio: f32, range: f32, knee: f32) -> f32 {
    let under = threshold - x;
    let k = knee.max(0.0);
    let g = if k > 0.0 && under.abs() <= k / 2.0 {
        let t = under + k / 2.0;
        -(ratio - 1.0) * t * t / (2.0 * k)
    } else if under > 0.0 {
        -(ratio - 1.0) * under
    } else {
        0.0
    };
    g.max(range)
}

/// 게인 감소(dB) 스무더 — 감지기와 따로 둔다 (게이트의 홀드·열림/닫힘 속도)
#[derive(Clone, Copy, Debug)]
pub struct GainSmoother {
    att: f32,
    rel: f32,
    db: f32,
}

impl GainSmoother {
    pub fn new() -> Self {
        Self {
            att: 0.0,
            rel: 0.0,
            db: 0.0,
        }
    }
    pub fn set_times(&mut self, attack_ms: f32, release_ms: f32, sample_rate: f32) {
        self.att = time_coef(attack_ms, sample_rate);
        self.rel = time_coef(release_ms, sample_rate);
    }
    /// 목표(dB, 0 이하) 로 — 더 줄이는 방향이 어택
    #[inline(always)]
    pub fn tick(&mut self, target: f32) -> f32 {
        let coef = if target < self.db { self.att } else { self.rel };
        self.db = target + (self.db - target) * coef;
        self.db
    }
    pub fn db(&self) -> f32 {
        self.db
    }
}

impl Default for GainSmoother {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressor_curve() {
        assert_eq!(compress_db(-30.0, -20.0, 4.0, 0.0), 0.0);
        assert!((compress_db(-10.0, -20.0, 4.0, 0.0) + 7.5).abs() < 1e-5);
        // 니 가운데는 하드니의 절반보다 작게 줄인다
        let soft = compress_db(-20.0, -20.0, 4.0, 6.0);
        assert!(soft < 0.0 && soft > -1.0);
    }

    #[test]
    fn expander_floor() {
        assert_eq!(expand_db(-10.0, -40.0, 2.0, -60.0, 0.0), 0.0);
        assert!((expand_db(-50.0, -40.0, 2.0, -60.0, 0.0) + 10.0).abs() < 1e-5);
        assert_eq!(expand_db(-100.0, -40.0, 100.0, -60.0, 0.0), -60.0);
    }

    #[test]
    fn follower_attack_faster_than_release() {
        let sr = 48000.0;
        let mut f = Follower::new(sr);
        f.set_times(1.0, 100.0, sr);
        for _ in 0..480 {
            f.tick(1.0);
        }
        assert!(f.db() > -0.1);
        for _ in 0..480 {
            f.tick(0.0);
        }
        assert!(
            f.db() > -60.0,
            "릴리즈 100ms 라 10ms 만에 다 내려가면 안 된다"
        );
    }
}

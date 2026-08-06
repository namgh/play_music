//! 파라미터 스무딩 (`sound.md` 6-4).
//!
//! > 줄 길이·컷오프·게인을 즉시 바꾸면 클릭 발생. 모든 연속 파라미터에 램프 적용.
//! > 시간상수는 파라미터별로 다르게 (게인은 짧게, 음정 관련은 더 짧게)
//!
//! 왜 필요한가: 튜닝 도구는 발음 중에 파라미터를 돌린다. 계수를 즉시 갈아 끼우면
//! 파형이 한 샘플에서 점프하고 그게 클릭이다. 이 스무딩이 없어서 지금까지
//! **재생 경로와 튜닝 경로를 나눠 뒀다** — 실시간 변경이 재생 중 클릭으로 새어
//! 나가기 때문이다. 이걸로 그 이유가 없어진다.
//!
//! 한 가지 함정: **음정 관련 계수는 느리게 스무딩하면 안 된다.** 딜레이 길이가
//! 천천히 움직이면 그 사이 음정이 미끄러진다. 그래서 파라미터마다 시간상수를 다르게 둔다.

/// 일차 지수 스무더. `target` 으로 수렴한다.
#[derive(Clone, Copy, Debug)]
pub struct Smoothed {
    current: f64,
    target: f64,
    /// 샘플당 계수. 1에 가까울수록 느리다
    coefficient: f64,
}

impl Smoothed {
    /// `time_ms` 는 목표의 63% 에 도달하는 시간 (시간상수).
    pub fn new(initial: f64, time_ms: f64, sample_rate: f64) -> Self {
        Self {
            current: initial,
            target: initial,
            coefficient: Self::coefficient_for(time_ms, sample_rate),
        }
    }

    fn coefficient_for(time_ms: f64, sample_rate: f64) -> f64 {
        if time_ms <= 0.0 {
            return 0.0; // 즉시 반영
        }
        (-1.0 / ((time_ms / 1000.0) * sample_rate)).exp()
    }

    pub fn set_time(&mut self, time_ms: f64, sample_rate: f64) {
        self.coefficient = Self::coefficient_for(time_ms, sample_rate);
    }

    pub fn set_target(&mut self, target: f64) {
        self.target = target;
    }

    /// 스무딩을 건너뛰고 즉시 맞춘다. 노트 시작 때 쓴다 —
    /// 새 음의 계수를 이전 음에서 천천히 옮겨오면 첫 순간의 음정이 틀린다
    pub fn reset(&mut self, value: f64) {
        self.current = value;
        self.target = value;
    }

    pub fn target(&self) -> f64 {
        self.target
    }

    pub fn value(&self) -> f64 {
        self.current
    }

    /// 목표에 도달했는가 (더 계산할 필요가 없는가)
    pub fn is_settled(&self) -> bool {
        (self.current - self.target).abs() < 1e-9
    }

    /// 한 샘플 진행. `next` 라는 이름은 `Iterator::next` 와 혼동되므로 피한다
    pub fn advance(&mut self) -> f64 {
        if self.coefficient == 0.0 {
            self.current = self.target;
            return self.current;
        }
        self.current = self.target + (self.current - self.target) * self.coefficient;
        // 부동소수점 잔여가 영원히 남지 않게 스냅한다 (비정규수 방지, `sound.md` 6-3)
        if (self.current - self.target).abs() < 1e-12 {
            self.current = self.target;
        }
        self.current
    }
}

/// 파라미터별 스무딩 시간 (`sound.md` 6-4 — "시간상수는 파라미터별로 다르게").
pub mod times {
    /// 게인은 짧게. 길면 볼륨 변화가 늦게 느껴진다
    pub const GAIN_MS: f64 = 8.0;
    /// 필터 컷오프. 클릭을 없앨 만큼만
    pub const FILTER_MS: f64 = 15.0;
    /// **음정 관련은 가장 짧게.** 느리면 그 사이 음정이 미끄러진다
    pub const PITCH_MS: f64 = 3.0;
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    #[test]
    fn zero_time_is_immediate() {
        let mut s = Smoothed::new(0.0, 0.0, FS);
        s.set_target(1.0);
        assert_eq!(s.advance(), 1.0);
    }

    #[test]
    fn reaches_63_percent_at_time_constant() {
        let mut s = Smoothed::new(0.0, 10.0, FS);
        s.set_target(1.0);
        let steps = (0.010 * FS) as usize;
        for _ in 0..steps {
            s.advance();
        }
        assert!(
            (s.value() - 0.632).abs() < 0.01,
            "시간상수에서 {} (기대 0.632)",
            s.value()
        );
    }

    #[test]
    fn converges_and_settles_exactly() {
        // 부동소수점 잔여가 남으면 비정규수 구간에서 CPU 가 튄다 (sound.md 6-3)
        let mut s = Smoothed::new(0.0, 5.0, FS);
        s.set_target(0.7);
        for _ in 0..(0.2 * FS) as usize {
            s.advance();
        }
        assert_eq!(s.value(), 0.7, "정확히 도달하지 않았다");
        assert!(s.is_settled());
    }

    #[test]
    fn no_overshoot_and_monotonic() {
        // 넘어갔다 돌아오면 그 자체가 소리로 들린다
        let mut s = Smoothed::new(0.0, 20.0, FS);
        s.set_target(1.0);
        let mut previous = s.value();
        for _ in 0..(0.1 * FS) as usize {
            let current = s.advance();
            assert!(current >= previous - 1e-15, "단조롭지 않다");
            assert!(current <= 1.0 + 1e-12, "목표를 넘었다: {current}");
            previous = current;
        }
    }

    #[test]
    fn reset_skips_the_ramp() {
        // 새 음의 계수를 이전 음에서 천천히 옮겨오면 첫 순간의 음정이 틀린다
        let mut s = Smoothed::new(0.0, 50.0, FS);
        s.set_target(1.0);
        s.advance();
        s.reset(0.5);
        assert_eq!(s.value(), 0.5);
        assert_eq!(s.advance(), 0.5, "reset 후에도 움직인다");
    }

    #[test]
    fn changing_target_midway_is_continuous() {
        let mut s = Smoothed::new(0.0, 10.0, FS);
        s.set_target(1.0);
        for _ in 0..200 {
            s.advance();
        }
        let before = s.value();
        s.set_target(-1.0);
        let after = s.advance();
        // 목표를 바꿔도 값이 점프하지 않는다 — 점프가 곧 클릭이다
        assert!(
            (after - before).abs() < 0.01,
            "{before} → {after} 로 점프했다"
        );
    }

    #[test]
    fn pitch_time_is_shortest() {
        // 음정 관련이 게인보다 느리면 음정이 미끄러진다.
        // 상수를 지역 변수로 받아 비교한다 — 상수끼리 비교하면 컴파일 타임에
        // 값이 정해져 clippy 가 "의미 없는 단정"으로 막는다
        let (pitch, gain, filter) = (times::PITCH_MS, times::GAIN_MS, times::FILTER_MS);
        assert!(pitch < gain, "음정 {pitch}ms 가 게인 {gain}ms 보다 느리다");
        assert!(
            pitch < filter,
            "음정 {pitch}ms 가 필터 {filter}ms 보다 느리다"
        );
    }
}

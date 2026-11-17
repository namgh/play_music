//! 파라미터 스무딩 — 파라미터는 블록(128샘플)마다 오므로 샘플마다 따라가게 한다.
//! 안 하면 손잡이를 돌릴 때 블록 경계마다 계단이 생겨 지퍼 소음이 난다.

#[derive(Clone, Copy, Debug)]
pub struct Smooth {
    value: f32,
    target: f32,
    coef: f32,
    fresh: bool,
}

impl Smooth {
    /// `ms` 는 63% 도달 시간
    pub fn new(ms: f32, sample_rate: f32) -> Self {
        Self {
            value: 0.0,
            target: 0.0,
            coef: super::time_coef(ms, sample_rate),
            fresh: true,
        }
    }

    /// 첫 값은 바로 맞춘다 — 0 에서 미끄러져 오면 첫 순간 소리가 틀린다
    pub fn set(&mut self, target: f32) {
        self.target = target;
        if self.fresh {
            self.value = target;
            self.fresh = false;
        }
    }

    #[inline(always)]
    pub fn tick(&mut self) -> f32 {
        self.value = self.target + (self.value - self.target) * self.coef;
        if (self.value - self.target).abs() < 1e-7 {
            self.value = self.target;
        }
        self.value
    }

    pub fn value(&self) -> f32 {
        self.value
    }

    /// 움직이는 중인가 — 아니면 계수 재계산을 건너뛸 수 있다
    pub fn moving(&self) -> bool {
        self.value != self.target
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_value_is_immediate_then_glides() {
        let mut s = Smooth::new(10.0, 48000.0);
        s.set(1.0);
        assert_eq!(s.tick(), 1.0);
        s.set(0.0);
        let a = s.tick();
        assert!(a > 0.9 && a < 1.0);
        for _ in 0..48000 {
            s.tick();
        }
        assert_eq!(s.value(), 0.0);
    }
}

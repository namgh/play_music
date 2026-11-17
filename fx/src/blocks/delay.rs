//! 분수 딜레이 라인 — 3차 에르미트 보간. 코러스·플랜저·딜레이·리버브·피치가 쓴다.
//! 길이를 정수로 반올림하면 모듈레이션에서 지글거림이 들린다 (`CLAUDE.md` 분수 딜레이 원칙).

#[derive(Clone, Debug)]
pub struct DelayLine {
    buf: Vec<f32>,
    mask: usize,
    write: usize,
}

impl DelayLine {
    /// `max_samples` 이상의 2의 거듭제곱 크기로 잡는다
    pub fn new(max_samples: usize) -> Self {
        let size = (max_samples + 4).next_power_of_two();
        Self {
            buf: vec![0.0; size],
            mask: size - 1,
            write: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len() - 4
    }

    #[inline(always)]
    pub fn push(&mut self, x: f32) {
        self.buf[self.write] = super::flush(x);
        self.write = (self.write + 1) & self.mask;
    }

    /// 정수 지연 (방금 넣은 것이 0)
    #[inline(always)]
    pub fn tap(&self, d: usize) -> f32 {
        self.buf[(self.write + self.mask - d.min(self.mask)) & self.mask]
    }

    /// 분수 지연 (방금 넣은 것이 0). 에르미트 보간
    #[inline(always)]
    pub fn read(&self, d: f32) -> f32 {
        let d = d.clamp(1.0, (self.buf.len() - 3) as f32);
        let i = d as usize;
        let f = d - i as f32;
        let xm1 = self.tap(i - 1);
        let x0 = self.tap(i);
        let x1 = self.tap(i + 1);
        let x2 = self.tap(i + 2);
        let c0 = x0;
        let c1 = 0.5 * (x1 - xm1);
        let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
        let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        ((c3 * f + c2) * f + c1) * f + c0
    }

    pub fn clear(&mut self) {
        self.buf.iter_mut().for_each(|v| *v = 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_and_fractional_delay() {
        let mut d = DelayLine::new(64);
        for i in 0..40 {
            d.push(i as f32);
        }
        // 마지막에 넣은 값 39 가 지연 0
        assert_eq!(d.tap(0), 39.0);
        assert_eq!(d.tap(10), 29.0);
        assert!(
            (d.read(10.5) - 28.5).abs() < 1e-4,
            "직선 신호는 보간도 직선"
        );
    }
}

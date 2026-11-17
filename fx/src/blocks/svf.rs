//! 상태변수 필터 (TPT/사이토믹 방식) — 차단을 샘플마다 움직여도 안정하다.
//! 오토 필터·엔벨로프 필터·멀티 필터처럼 **흔드는** 필터는 바이쿼드 대신 이걸 쓴다.

#[derive(Clone, Copy, Debug, Default)]
pub struct Svf {
    ic1: f32,
    ic2: f32,
    g: f32,
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct SvfOut {
    pub low: f32,
    pub band: f32,
    pub high: f32,
}

impl Svf {
    /// `q` 0.5 … 25
    pub fn set(&mut self, freq: f32, q: f32, sample_rate: f32) {
        let f = freq.clamp(10.0, sample_rate * 0.48);
        self.g = (std::f32::consts::PI * f / sample_rate).tan();
        self.k = 1.0 / q.max(0.3);
        self.a1 = 1.0 / (1.0 + self.g * (self.g + self.k));
        self.a2 = self.g * self.a1;
        self.a3 = self.g * self.a2;
    }

    #[inline(always)]
    pub fn tick(&mut self, x: f32) -> SvfOut {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = super::flush(2.0 * v1 - self.ic1);
        self.ic2 = super::flush(2.0 * v2 - self.ic2);
        SvfOut {
            low: v2,
            band: v1,
            high: x - self.k * v1 - v2,
        }
    }

    /// 대역통과 출력을 피크 1 로 맞춘 값 (k·band)
    pub fn k(&self) -> f32 {
        self.k
    }

    pub fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowpass_and_highpass() {
        let sr = 48000.0;
        let mut f = Svf::default();
        f.set(1000.0, 0.707, sr);
        let mut lo = 0f32;
        let mut hi = 0f32;
        for i in 0..48000 {
            let x = (2.0 * std::f32::consts::PI * 8000.0 * i as f32 / sr).sin();
            let o = f.tick(x);
            if i > 24000 {
                lo = lo.max(o.low.abs());
                hi = hi.max(o.high.abs());
            }
        }
        // 8kHz 는 한 주기 6점이라 표본 피크가 최소 0.866 — 위상 때문에 1 이 안 나올 수 있다
        assert!(lo < 0.03 && hi > 0.85, "lo {lo} hi {hi}");
    }
}

//! 결정적 난수 (xorshift32) — 같은 설정이면 같은 소리 (재생 = 내보내기)

#[derive(Clone, Copy, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Self(seed.max(1))
    }
    #[inline(always)]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// −1 … 1
    #[inline(always)]
    pub fn bipolar(&mut self) -> f32 {
        (self.next_u32() as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
    /// 0 … 1
    #[inline(always)]
    pub fn unit(&mut self) -> f32 {
        self.next_u32() as f32 / u32::MAX as f32
    }
}

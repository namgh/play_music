//! 부품 — 이펙트는 이것들을 조립한다 (`EFFECTS_PLAN.md` 2절).

pub mod biquad;
pub mod conv;
pub mod crossover;
pub mod delay;
pub mod env;
pub mod fft;
pub mod rng;
pub mod smooth;

/// 비정규수를 0 으로 — wasm 에는 FTZ 플래그가 없다 (`dsp/src/denormal.rs`)
#[inline(always)]
pub fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 {
        0.0
    } else {
        x
    }
}

#[inline(always)]
pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[inline(always)]
pub fn gain_to_db(g: f32) -> f32 {
    20.0 * g.max(1e-12).log10()
}

/// 시간상수(ms) → 일차 스무딩 계수. 0 이면 즉시
#[inline]
pub fn time_coef(ms: f32, sample_rate: f32) -> f32 {
    if ms <= 0.0 {
        0.0
    } else {
        (-1.0 / (ms * 0.001 * sample_rate)).exp()
    }
}

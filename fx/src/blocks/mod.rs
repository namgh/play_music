//! 부품 — 이펙트는 이것들을 조립한다 (`EFFECTS_PLAN.md` 2절).

pub mod biquad;
pub mod conv;
pub mod crossover;
pub mod delay;
pub mod env;
pub mod fdn;
pub mod fft;
pub mod lfo;
pub mod oversample;
pub mod pitch;
pub mod rng;
pub mod smooth;
pub mod stft;
pub mod svf;
pub mod yin;

/// 비정규수를 0 으로 — wasm 에는 FTZ 플래그가 없다 (`dsp/src/denormal.rs`)
#[inline(always)]
pub fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 {
        0.0
    } else {
        x
    }
}

/// dB → 선형. **샘플마다 부르는 자리**(다이내믹스 게인)라 wasm 소프트웨어 powf 대신 근사 —
/// 오차 0.001dB 아래 (테스트로 확인)
#[inline(always)]
pub fn db_to_gain(db: f32) -> f32 {
    fast_exp2(db * (std::f32::consts::LOG2_10 / 20.0))
}

/// 선형 → dB (근사, 오차 0.001dB 아래). 1e-12 아래는 −240dB
#[inline(always)]
pub fn gain_to_db(g: f32) -> f32 {
    fast_log2(g.max(1e-12)) * (20.0 / std::f32::consts::LOG2_10)
}

/// log2 — 지수는 비트에서, 가수는 다항식 (x 는 양수)
#[inline(always)]
pub fn fast_log2(x: f32) -> f32 {
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000); // [1, 2)
                                                                // log2(m), m∈[1,2) — t = (m−1)/(m+1) 급수 (atanh) 3항
    let t = (m - 1.0) / (m + 1.0);
    let t2 = t * t;
    e as f32 + t * (2.885_39 + t2 * (0.961_797 + t2 * (0.577_078 + t2 * 0.412_199)))
}

/// 2^x — 정수부는 비트로, 소수부는 다항식
#[inline(always)]
pub fn fast_exp2(x: f32) -> f32 {
    let x = x.clamp(-126.0, 126.0);
    let i = x.floor();
    let f = x - i;
    // 2^f, f∈[0,1) — 5차
    let p = 1.0
        + f * (std::f32::consts::LN_2
            + f * (0.240_226_5 + f * (0.055_504_1 + f * (0.009_618_1 + f * 0.001_333_6))));
    p * f32::from_bits(((i as i32 + 127) as u32) << 23)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_db_conversions_are_accurate() {
        let mut db = -120.0f32;
        while db <= 30.0 {
            let g = db_to_gain(db);
            let exact = 10f32.powf(db / 20.0);
            assert!((g / exact - 1.0).abs() < 2e-4, "{db}dB → {g} vs {exact}");
            assert!(
                (gain_to_db(exact) - db).abs() < 1e-3,
                "{db}dB 되돌림 {}",
                gain_to_db(exact)
            );
            db += 0.37;
        }
    }
}

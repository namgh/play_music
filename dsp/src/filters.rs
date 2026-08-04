//! 루프 안 필터들의 위상 지연·진폭 응답.
//!
//! 웨이브가이드의 음정은 **루프 전체의 지연**으로 결정된다. 딜레이 라인만 세고
//! 필터들이 만드는 지연을 빼지 않으면 음이 낮아지고, 고음일수록 심해진다
//! (`sound.md` 6-2 — 타협 불가 항목).
//!
//! 계산은 f64 로 한다. 계수를 정하는 것은 노트 시작 때 한 번뿐이라 비용이 없고,
//! 여기서 f32 로 반올림하면 음정 오차가 그대로 남는다.

use core::f64::consts::PI;

/// 원제로 감쇠 필터 `H(z) = (1-s) + s·z⁻¹`
pub struct OneZero;

impl OneZero {
    pub fn phase_delay(s: f64, w: f64) -> f64 {
        if w < 1e-12 {
            return s;
        }
        let re = (1.0 - s) + s * w.cos();
        let im = -s * w.sin();
        -im.atan2(re) / w
    }

    pub fn magnitude(s: f64, w: f64) -> f64 {
        let re = (1.0 - s) + s * w.cos();
        let im = -s * w.sin();
        (re * re + im * im).sqrt()
    }
}

/// 1차 올패스 `A(z) = (a + z⁻¹)/(1 + a·z⁻¹)`
///
/// `θ(ω) = -ω + 2·atan2(a·sinω, 1 + a·cosω)` 로 쓰면 |a|<1 에서 `1 + a·cosω > 0`
/// 이므로 atan2 가 감기지 않는다 → 언랩 없이 전 대역에서 정확하다.
/// DC 극한은 `(1-a)/(1+a)`. `a < 0` 이면 지연이 주파수에 따라 줄어들어 상위 하모닉이
/// 위로 밀린다 = 강성 있는 줄의 인하모니시티와 같은 방향.
pub struct Allpass;

impl Allpass {
    pub fn phase_delay(a: f64, w: f64) -> f64 {
        if w < 1e-12 {
            return (1.0 - a) / (1.0 + a);
        }
        let theta = -w + 2.0 * (a * w.sin()).atan2(1.0 + a * w.cos());
        -theta / w
    }
}

/// DC 차단기 `H(z) = (1 - z⁻¹)/(1 - R·z⁻¹)`
///
/// 왜 필요한가: 루프 필터를 기본음에서 단위 이득으로 정규화하면 `sustainSec` 이
/// 정확해지지만, 정규화 때문에 DC 이득이 1을 넘어 발산한다. DC 에서 이득이 정확히
/// 0인 단을 루프에 넣어야 그 정규화가 성립한다.
///
/// 위상은 저역에서 **앞선다**(지연이 음수) → 딜레이 라인이 그만큼 길어진다.
pub struct DcBlock;

impl DcBlock {
    pub fn phase_delay(r: f64, w: f64) -> f64 {
        if w < 1e-12 {
            return 0.0; // DC 에서는 진폭이 0이라 위상이 의미 없다
        }
        let num = PI / 2.0 - w / 2.0;
        let den = (r * w.sin()).atan2(1.0 - r * w.cos());
        -(num - den) / w
    }

    pub fn magnitude(r: f64, w: f64) -> f64 {
        let num = 2.0 * (w / 2.0).sin();
        let den = (1.0 - 2.0 * r * w.cos() + r * r).sqrt();
        if den < 1e-18 {
            0.0
        } else {
            num / den
        }
    }
}

/// 올패스 보간 계수의 허용 범위. 밖으로 나가면 보간 정확도·안정성이 나빠진다
pub const AP_COEF_MIN: f64 = -0.92;
pub const AP_COEF_MAX: f64 = 0.92;

/// 기본음 `w` 에서 위상 지연이 정확히 `frac` 샘플이 되는 올패스 계수.
///
/// 교과서의 `c = (1-frac)/(1+frac)` 는 **DC 에서만** 맞는다. 고음에서는 실제 지연이
/// 그보다 짧아져 음이 샤프해진다 (C8 에서 10~19센트). 위상 지연은 `a` 에 대해
/// 단조 감소하므로 이분법으로 정확히 찾는다.
pub fn solve_allpass_coef(frac: f64, w: f64) -> Option<f64> {
    if frac > Allpass::phase_delay(AP_COEF_MIN, w) {
        return None;
    }
    if frac < Allpass::phase_delay(AP_COEF_MAX, w) {
        return None;
    }
    let mut lo = AP_COEF_MIN;
    let mut hi = AP_COEF_MAX;
    for _ in 0..60 {
        let mid = 0.5 * (lo + hi);
        if Allpass::phase_delay(mid, w) > frac {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some(0.5 * (lo + hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 위상 지연 공식이 맞는지 **수치 미분으로 교차 검증**한다.
    /// 위상 지연 = -θ(ω)/ω 인데, 공식을 잘못 유도하면 부호나 역수가 뒤집혀도
    /// "그럴듯한 숫자"가 나온다. 독립적인 방법으로 확인해야 잡힌다.
    fn numeric_phase_delay<F>(response: F, w: f64) -> f64
    where
        F: Fn(f64) -> (f64, f64),
    {
        let (re, im) = response(w);
        let theta = im.atan2(re);
        -theta / w
    }

    #[test]
    fn one_zero_phase_delay_matches_response() {
        for s in [0.0f64, 0.05, 0.2, 0.4] {
            for w in [0.001f64, 0.05, 0.3, 1.0, 2.5] {
                let expected = numeric_phase_delay(|w| ((1.0 - s) + s * w.cos(), -s * w.sin()), w);
                let got = OneZero::phase_delay(s, w);
                assert!(
                    (got - expected).abs() < 1e-12,
                    "s={s} w={w}: {got} != {expected}"
                );
            }
        }
    }

    #[test]
    fn allpass_magnitude_is_unity() {
        // 올패스가 진폭을 바꾸면 루프 이득 계산이 전부 틀어진다
        for a in [-0.9f64, -0.4, 0.0, 0.4, 0.9] {
            for w in [0.01f64, 0.3, 1.0, 3.0] {
                let num = (a + w.cos(), -w.sin());
                let den = (1.0 + a * w.cos(), -a * w.sin());
                let mag =
                    (num.0 * num.0 + num.1 * num.1).sqrt() / (den.0 * den.0 + den.1 * den.1).sqrt();
                assert!((mag - 1.0).abs() < 1e-12, "a={a} w={w}: |H|={mag}");
            }
        }
    }

    #[test]
    fn allpass_phase_delay_dc_limit() {
        for a in [-0.8f64, -0.3, 0.0, 0.3, 0.8] {
            let expected = (1.0 - a) / (1.0 + a);
            let got = Allpass::phase_delay(a, 1e-7);
            assert!((got - expected).abs() < 1e-4, "a={a}: {got} != {expected}");
        }
    }

    #[test]
    fn negative_allpass_delay_decreases_with_frequency() {
        // 강성(인하모니시티)의 방향. a < 0 이어야 상위 하모닉이 위로 밀린다.
        // 부호를 뒤집으면 물리적으로 반대인 소리가 난다
        let a = -0.3f64;
        let mut previous = Allpass::phase_delay(a, 0.01);
        for w in [0.1f64, 0.3, 0.6, 1.0, 1.5] {
            let current = Allpass::phase_delay(a, w);
            assert!(current < previous, "w={w}: {current} >= {previous}");
            previous = current;
        }
    }

    #[test]
    fn dc_block_kills_dc_and_passes_audio() {
        let r = 1.0f64 - 1e-4;
        assert!(DcBlock::magnitude(r, 0.0) < 1e-9, "DC 가 통과한다");
        assert!(DcBlock::magnitude(r, 0.005) > 0.9, "저음이 과하게 깎인다");
        assert!((DcBlock::magnitude(r, 1.0) - 1.0).abs() < 0.01);
    }

    #[test]
    fn solve_allpass_coef_inverts_phase_delay() {
        // 교과서 공식 c=(1-d)/(1+d) 를 쓰면 고음에서 틀어진다. 여기서 푸는 값은
        // **해당 주파수에서** 정확히 목표 지연을 내야 한다
        for w in [0.01f64, 0.1, 0.3, 0.55] {
            for frac in [0.5f64, 0.8, 1.0, 1.3] {
                let Some(c) = solve_allpass_coef(frac, w) else {
                    continue;
                };
                let got = Allpass::phase_delay(c, w);
                assert!((got - frac).abs() < 1e-9, "w={w} frac={frac}: {got}");
            }
        }
    }

    #[test]
    fn textbook_coefficient_is_wrong_at_high_frequency() {
        // 왜 이분법이 필요한지 숫자로 남긴다. C8 부근(w≈0.55)에서 교과서 공식은
        // 목표 지연을 못 낸다
        let w = 0.548f64;
        let frac = 1.0_f64;
        let textbook = (1.0 - frac) / (1.0 + frac);
        let solved = solve_allpass_coef(frac, w).unwrap();
        let textbook_delay = Allpass::phase_delay(textbook, w);
        assert!(
            (textbook_delay - frac).abs() > 1e-6 || (textbook - solved).abs() < 1e-9,
            "교과서 공식이 이 지점에서 우연히 맞다면 테스트 전제를 다시 봐야 한다"
        );
    }

    #[test]
    fn out_of_range_fraction_returns_none() {
        // 조용히 엉뚱한 계수를 돌려주면 음정이 틀어진 채로 소리가 난다
        assert!(solve_allpass_coef(50.0, 0.5).is_none());
        assert!(solve_allpass_coef(0.0001, 0.5).is_none());
    }
}

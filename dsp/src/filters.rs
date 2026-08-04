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

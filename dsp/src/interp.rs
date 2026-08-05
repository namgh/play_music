//! 변조 가능한 분수 딜레이 — 음정 곡선(글라이드·비브라토)을 위한 보간기.
//!
//! **왜 올패스가 아닌가:** 올패스 보간기는 상태를 가진 필터다. 계수를 계속 바꾸면
//! 그 상태가 과도 응답을 만들어 지글거린다. 음정 곡선은 초당 수천 번 딜레이를
//! 바꾸므로 **상태 없는** 보간기가 필요하다.
//!
//! 그래서 4점 라그랑주(3차) 보간을 쓴다. 상태가 없어 변조에 안전하고, 대신
//! 올패스와 달리 진폭이 1이 아니다(고역에서 약간 깎인다) → 루프 이득 정규화에
//! 진폭을 포함해야 한다.
//!
//! 음정 정확도는 올패스 때와 같은 방법으로 지킨다: 보간 계수를 공식으로 쓰지 않고
//! **기본음 주파수에서 위상 지연이 목표와 같아지도록 푼다.**

/// 4점 라그랑주 계수. `d ∈ [0,1]` 은 `x[i]` 와 `x[i+1]` 사이의 위치.
///
/// 반환값은 **최신 탭 기준**으로 정렬돼 있다 (`c[0]` 이 가장 최근).
/// `d=0` 이면 순수 2샘플 지연, `d=1` 이면 1샘플 지연이 된다.
pub fn lagrange4(d: f64) -> [f64; 4] {
    let dm1 = d - 1.0;
    let dm2 = d - 2.0;
    let dp1 = d + 1.0;

    let h_minus1 = -d * dm1 * dm2 / 6.0;
    let h_0 = dp1 * dm1 * dm2 / 2.0;
    let h_1 = -dp1 * d * dm2 / 2.0;
    let h_2 = dp1 * d * dm1 / 6.0;

    // 탭 순서를 최신 → 과거로 뒤집는다
    [h_2, h_1, h_0, h_minus1]
}

/// 보간기의 주파수 응답 (진폭, 위상 지연). 위상 지연은 최신 탭 기준 샘플 수.
pub fn lagrange4_response(d: f64, w: f64) -> (f64, f64) {
    let c = lagrange4(d);
    let mut re = 0.0;
    let mut im = 0.0;
    for (m, coef) in c.iter().enumerate() {
        let phase = -(m as f64) * w;
        re += coef * phase.cos();
        im += coef * phase.sin();
    }
    let magnitude = (re * re + im * im).sqrt();
    let phase_delay = if w < 1e-12 {
        // DC 극한. c 의 무게중심이 2-d 에 있다
        2.0 - d
    } else {
        -im.atan2(re) / w
    };
    (magnitude, phase_delay)
}

/// `w` 에서 위상 지연이 정확히 `target` 이 되는 `d ∈ [0,1]`.
///
/// 위상 지연은 `d` 에 대해 단조 감소한다(대략 `2-d`). 범위를 벗어나면 None —
/// 호출자가 정수 탭을 옮겨 다시 시도한다.
pub fn solve_lagrange_fraction(target: f64, w: f64) -> Option<f64> {
    let (_, at_zero) = lagrange4_response(0.0, w);
    let (_, at_one) = lagrange4_response(1.0, w);
    if target > at_zero || target < at_one {
        return None;
    }
    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..50 {
        let mid = 0.5 * (lo + hi);
        if lagrange4_response(mid, w).1 > target {
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

    #[test]
    fn integer_positions_are_pure_delays() {
        // d=0 → x[i] 를 그대로, d=1 → x[i+1] 을 그대로 읽어야 한다.
        // 여기가 틀리면 정수 위치에서 보간이 값을 흐린다
        let c0 = lagrange4(0.0);
        assert!((c0[2] - 1.0).abs() < 1e-12, "d=0 에서 {c0:?}");
        assert!(c0[0].abs() + c0[1].abs() + c0[3].abs() < 1e-12);

        let c1 = lagrange4(1.0);
        assert!((c1[1] - 1.0).abs() < 1e-12, "d=1 에서 {c1:?}");
    }

    #[test]
    fn coefficients_sum_to_one() {
        // 합이 1이 아니면 DC 이득이 1이 아니고, 그러면 루프에 DC 가 새거나 죽는다
        for i in 0..=20 {
            let d = i as f64 / 20.0;
            let sum: f64 = lagrange4(d).iter().sum();
            assert!((sum - 1.0).abs() < 1e-12, "d={d}: 합 {sum}");
        }
    }

    #[test]
    fn phase_delay_matches_dc_limit() {
        for i in 0..=10 {
            let d = i as f64 / 10.0;
            let (_, pd) = lagrange4_response(d, 1e-7);
            assert!((pd - (2.0 - d)).abs() < 1e-4, "d={d}: {pd}");
        }
    }

    #[test]
    fn magnitude_is_lowpass_not_allpass() {
        // 올패스가 아니라는 사실을 고정한다. 이걸 잊고 루프 이득 정규화에서 빼면
        // 서스테인이 지정값보다 짧아진다
        let (m_low, _) = lagrange4_response(0.5, 0.01);
        let (m_high, _) = lagrange4_response(0.5, 1.5);
        assert!((m_low - 1.0).abs() < 1e-3, "저역 진폭 {m_low}");
        assert!(m_high < 0.99, "고역에서 깎이지 않는다: {m_high}");
    }

    #[test]
    fn solved_fraction_hits_target_phase_delay() {
        for w in [0.01f64, 0.1, 0.3, 0.55] {
            for target in [1.05f64, 1.3, 1.5, 1.7, 1.95] {
                let Some(d) = solve_lagrange_fraction(target, w) else {
                    continue;
                };
                let (_, pd) = lagrange4_response(d, w);
                assert!((pd - target).abs() < 1e-9, "w={w} target={target}: {pd}");
            }
        }
    }

    #[test]
    fn out_of_range_target_returns_none() {
        assert!(solve_lagrange_fraction(5.0, 0.3).is_none());
        assert!(solve_lagrange_fraction(0.1, 0.3).is_none());
    }
}

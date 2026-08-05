//! 음정 곡선 — `plan.md` 5-1 Phase 1 의 "음정 곡선(글라이드·흔들림) 편집",
//! 차별점 ①(음 단위 정밀 수정)의 핵심.
//!
//! 데이터 형태는 `plan.md` 5-4 의 `PitchCurve` 와 같다. 고수준 파라미터
//! (글라이드·비브라토)만 여기서 다룬다 — 사용자가 직접 그린 `points` 는
//! 상위 레이어가 샘플링해서 넘기는 것으로 나중에 확장한다.
//!
//! `sound.md` 4절이 Tier 5(현악·관악)의 대안으로 삼은 표현 곡선도 이 인프라 위에
//! 얹힌다. 그래서 여기가 비어 있으면 그 계획도 성립하지 않는다.

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PitchCurve {
    /// 시작 음정의 오프셋 (센트). 음수면 아래에서 올라온다
    pub glide_cents: f64,
    /// 목표 음정에 도달하는 시간 (ms)
    pub glide_ms: f64,
    /// 비브라토 진폭 (센트)
    pub vibrato_cents: f64,
    pub vibrato_hz: f64,
    /// 비브라토가 걸리기까지의 지연 (ms)
    pub vibrato_delay_ms: f64,
}

impl PitchCurve {
    /// 곡선이 아무 일도 하지 않는가. 그러면 검증된 올패스 경로를 그대로 쓴다
    pub fn is_flat(&self) -> bool {
        (self.glide_cents == 0.0 || self.glide_ms <= 0.0)
            && (self.vibrato_cents == 0.0 || self.vibrato_hz <= 0.0)
    }

    /// 노트 시작 후 `t` 초에서의 음정 오프셋 (센트).
    ///
    /// 글라이드는 지수적으로 수렴한다 — 손가락이 미끄러져 자리를 잡는 움직임에
    /// 가깝고, 선형 램프는 도착 지점에 각이 생겨 기계적으로 들린다.
    /// 시간상수를 `glide_ms/3` 으로 두어 `glide_ms` 에서 약 95% 도달한다.
    pub fn cents_at(&self, t: f64) -> f64 {
        let mut cents = 0.0;

        if self.glide_cents != 0.0 && self.glide_ms > 0.0 {
            let tau = (self.glide_ms / 1000.0) / 3.0;
            cents += self.glide_cents * (-t / tau).exp();
        }

        if self.vibrato_cents != 0.0 && self.vibrato_hz > 0.0 {
            let delay = self.vibrato_delay_ms / 1000.0;
            if t >= delay {
                // 위상 0에서 시작하므로 sin(0)=0 → 지연 지점에서 값이 튀지 않는다
                let phase = 2.0 * core::f64::consts::PI * self.vibrato_hz * (t - delay);
                cents += self.vibrato_cents * phase.sin();
            }
        }

        cents
    }

    /// 곡선이 만들 수 있는 최대 편차 (센트). 딜레이 라인 길이를 잡을 때 쓴다
    pub fn max_deviation_cents(&self) -> f64 {
        self.glide_cents.abs() + self.vibrato_cents.abs()
    }
}

/// 센트 오프셋 → 주파수 배율
pub fn cents_to_ratio(cents: f64) -> f64 {
    (cents / 1200.0).exp2()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_curve_is_detected() {
        assert!(PitchCurve::default().is_flat());
        assert!(PitchCurve {
            glide_cents: 30.0,
            glide_ms: 0.0, // 시간이 0이면 아무 일도 안 한다
            ..Default::default()
        }
        .is_flat());
        assert!(!PitchCurve {
            glide_cents: -24.0,
            glide_ms: 60.0,
            ..Default::default()
        }
        .is_flat());
    }

    #[test]
    fn glide_starts_at_offset_and_settles() {
        let curve = PitchCurve {
            glide_cents: -24.0,
            glide_ms: 60.0,
            ..Default::default()
        };
        assert!(
            (curve.cents_at(0.0) - -24.0).abs() < 1e-9,
            "시작이 오프셋이 아니다"
        );
        // glide_ms 에서 95% 도달
        let at_target = curve.cents_at(0.060);
        assert!(
            at_target.abs() < 24.0 * 0.06,
            "60ms 에서 아직 {at_target} 센트 남았다"
        );
        assert!(curve.cents_at(1.0).abs() < 1e-6, "1초 뒤에도 안 수렴했다");
    }

    #[test]
    fn vibrato_is_continuous_at_its_start() {
        // 지연 지점에서 값이 튀면 클릭이 난다
        let curve = PitchCurve {
            vibrato_cents: 20.0,
            vibrato_hz: 5.0,
            vibrato_delay_ms: 120.0,
            ..Default::default()
        };
        assert_eq!(curve.cents_at(0.119), 0.0);
        assert!(curve.cents_at(0.120).abs() < 1e-9);
        // 4분의 1주기 뒤에 최대
        let quarter = 0.120 + 1.0 / (4.0 * 5.0);
        assert!((curve.cents_at(quarter) - 20.0).abs() < 1e-6);
    }

    #[test]
    fn glide_and_vibrato_add_up() {
        let curve = PitchCurve {
            glide_cents: -20.0,
            glide_ms: 50.0,
            vibrato_cents: 10.0,
            vibrato_hz: 5.0,
            vibrato_delay_ms: 0.0,
        };
        // t=0: 글라이드 -20, 비브라토 0
        assert!((curve.cents_at(0.0) - -20.0).abs() < 1e-9);
        assert_eq!(curve.max_deviation_cents(), 30.0);
    }

    #[test]
    fn cents_to_ratio_matches_octave() {
        assert!((cents_to_ratio(1200.0) - 2.0).abs() < 1e-12);
        assert!((cents_to_ratio(0.0) - 1.0).abs() < 1e-12);
        assert!((cents_to_ratio(-1200.0) - 0.5).abs() < 1e-12);
    }
}

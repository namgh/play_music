//! 음정 곡선 — `plan.md` 5-1 Phase 1 의 "음정 곡선(글라이드·흔들림) 편집",
//! 차별점 ①(음 단위 정밀 수정)의 핵심.
//!
//! 데이터 형태는 `plan.md` 5-4 의 `PitchCurve` 와 같다. 고수준 파라미터
//! (글라이드·비브라토)만 여기서 다룬다 — 사용자가 직접 그린 `points` 는
//! 상위 레이어가 샘플링해서 넘기는 것으로 나중에 확장한다.
//!
//! `sound.md` 4절이 Tier 5(현악·관악)의 대안으로 삼은 표현 곡선도 이 인프라 위에
//! 얹힌다. 그래서 여기가 비어 있으면 그 계획도 성립하지 않는다.

/// 자유곡선의 점 개수 상한.
///
/// 고정 배열을 쓰는 이유: `PitchCurve` 는 보이스마다 복사돼 들어가는데, 오디오
/// 경로에서 힙을 건드리면 지연이 튄다 (`lib.rs` 머리말). 64점이면 한 음 안의
/// 모양을 그리는 데 충분하고, 보이스 40개를 다 합쳐도 20KB 다.
pub const MAX_CURVE_POINTS: usize = 64;

/// 사용자가 그린 자유곡선의 점 하나. `t_norm` 은 **음 길이로 정규화된 시간**(0~1)이다.
///
/// 초가 아니라 정규화 시간인 이유: 음을 늘리거나 줄여도 곡선 모양이 유지돼야 한다
/// (`plan.md` 5-4 의 `points`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CurvePoint {
    pub t_norm: f64,
    pub cents: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
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
    /// 사용자가 직접 그린 곡선. `point_count` 개만 유효하다
    pub points: [CurvePoint; MAX_CURVE_POINTS],
    pub point_count: usize,
    /// 정규화 시간을 초로 되돌릴 때 쓰는 음 길이. 0 이면 자유곡선을 쓰지 않는다
    pub duration_sec: f64,
}

impl Default for PitchCurve {
    fn default() -> Self {
        Self {
            glide_cents: 0.0,
            glide_ms: 0.0,
            vibrato_cents: 0.0,
            vibrato_hz: 0.0,
            vibrato_delay_ms: 0.0,
            points: [CurvePoint::default(); MAX_CURVE_POINTS],
            point_count: 0,
            duration_sec: 0.0,
        }
    }
}

impl PitchCurve {
    /// 자유곡선이 실제로 쓰이는가. **쓰이면 글라이드·비브라토를 대신한다** —
    /// `plan.md` 5-4 가 "사용자가 그리면 `points` 가 우선"이라고 정한 그대로다.
    ///
    /// 섞지 않는 이유: 사용자가 그린 모양 위에 자동 비브라토가 더해지면 **화면의
    /// 곡선과 들리는 음정이 달라진다.** 그게 이 기능에서 가장 하면 안 되는 일이다.
    pub fn uses_points(&self) -> bool {
        self.point_count > 0 && self.duration_sec > 0.0
    }

    /// 곡선이 아무 일도 하지 않는가. 그러면 검증된 올패스 경로를 그대로 쓴다
    pub fn is_flat(&self) -> bool {
        if self.uses_points() {
            return self.points[..self.point_count]
                .iter()
                .all(|p| p.cents == 0.0);
        }
        (self.glide_cents == 0.0 || self.glide_ms <= 0.0)
            && (self.vibrato_cents == 0.0 || self.vibrato_hz <= 0.0)
    }

    /// 자유곡선을 선형 보간해 읽는다. 점 사이를 직선으로 잇는다 —
    /// 사용자가 화면에서 보는 것과 같아야 하므로 화려한 보간을 쓰지 않는다.
    ///
    /// 점은 `t_norm` 오름차순이라고 가정한다. 첫 점 앞과 마지막 점 뒤는 **끝점 값을
    /// 유지한다** (0 으로 떨어뜨리면 음이 끝에서 튄다).
    fn points_cents_at(&self, t: f64) -> f64 {
        let n = self.point_count;
        let pts = &self.points[..n];
        let t_norm = (t / self.duration_sec).clamp(0.0, 1.0);

        if t_norm <= pts[0].t_norm {
            return pts[0].cents;
        }
        for pair in pts.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if t_norm <= b.t_norm {
                let span = b.t_norm - a.t_norm;
                if span <= 0.0 {
                    return b.cents;
                }
                let u = (t_norm - a.t_norm) / span;
                return a.cents + (b.cents - a.cents) * u;
            }
        }
        pts[n - 1].cents
    }

    /// 노트 시작 후 `t` 초에서의 음정 오프셋 (센트).
    ///
    /// 글라이드는 지수적으로 수렴한다 — 손가락이 미끄러져 자리를 잡는 움직임에
    /// 가깝고, 선형 램프는 도착 지점에 각이 생겨 기계적으로 들린다.
    /// 시간상수를 `glide_ms/3` 으로 두어 `glide_ms` 에서 약 95% 도달한다.
    pub fn cents_at(&self, t: f64) -> f64 {
        if self.uses_points() {
            return self.points_cents_at(t);
        }
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

    /// 곡선이 만들 수 있는 최대 편차 (센트). 딜레이 라인 길이를 잡을 때 쓴다.
    ///
    /// **덜 잡으면 딜레이 라인이 모자라 음정이 틀어진다.** 자유곡선은 실제 점들의
    /// 최대 절댓값을 본다
    pub fn max_deviation_cents(&self) -> f64 {
        if self.uses_points() {
            return self.points[..self.point_count]
                .iter()
                .fold(0.0f64, |max, p| max.max(p.cents.abs()));
        }
        self.glide_cents.abs() + self.vibrato_cents.abs()
    }

    /// 점을 채운다. 화면에서 온 값이므로 **여기서 정리한다** — 범위를 벗어난
    /// 정규화 시간, 뒤집힌 순서, 상한을 넘는 개수를 엔진 안쪽까지 들이지 않는다.
    pub fn set_points(&mut self, raw: &[CurvePoint], duration_sec: f64) {
        self.point_count = 0;
        self.duration_sec = 0.0;
        // NaN 을 명시적으로 거른다. 길이가 NaN 이면 정규화 시간을 초로 못 되돌린다
        if raw.is_empty() || duration_sec.is_nan() || duration_sec <= 0.0 {
            return;
        }

        let mut last = f64::NEG_INFINITY;
        for p in raw.iter().take(MAX_CURVE_POINTS) {
            if !p.t_norm.is_finite() || !p.cents.is_finite() {
                continue;
            }
            // 오름차순이 아니면 버린다. 정렬은 화면 쪽 일이고, 여기서 고치면
            // **화면과 소리가 달라도 조용히 넘어가게** 된다
            let t_norm = p.t_norm.clamp(0.0, 1.0);
            if t_norm < last {
                continue;
            }
            last = t_norm;
            self.points[self.point_count] = CurvePoint {
                t_norm,
                cents: p.cents,
            };
            self.point_count += 1;
        }
        if self.point_count > 0 {
            self.duration_sec = duration_sec;
        }
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
            ..Default::default()
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

#[cfg(test)]
mod point_tests {
    use super::*;

    fn curve_with(points: &[(f64, f64)], duration: f64) -> PitchCurve {
        let raw: Vec<CurvePoint> = points
            .iter()
            .map(|&(t_norm, cents)| CurvePoint { t_norm, cents })
            .collect();
        let mut curve = PitchCurve {
            // 자유곡선이 이것들을 **대신한다**는 것도 함께 확인한다
            glide_cents: -50.0,
            glide_ms: 40.0,
            vibrato_cents: 30.0,
            vibrato_hz: 6.0,
            ..Default::default()
        };
        curve.set_points(&raw, duration);
        curve
    }

    #[test]
    fn points_replace_glide_and_vibrato() {
        // plan.md 5-4: "사용자가 그리면 points 가 우선".
        // 섞으면 화면의 곡선과 들리는 음정이 달라진다
        let curve = curve_with(&[(0.0, 0.0), (1.0, 0.0)], 1.0);
        assert!(curve.uses_points());
        assert_eq!(curve.cents_at(0.5), 0.0, "글라이드가 새어 들어왔다");
        assert!(curve.is_flat(), "전부 0인 곡선인데 평평하지 않다고 한다");
    }

    #[test]
    fn interpolates_linearly_between_points() {
        let curve = curve_with(&[(0.0, 0.0), (1.0, 200.0)], 2.0);
        assert!((curve.cents_at(0.0) - 0.0).abs() < 1e-9);
        assert!(
            (curve.cents_at(1.0) - 100.0).abs() < 1e-9,
            "중간값이 틀렸다"
        );
        assert!((curve.cents_at(2.0) - 200.0).abs() < 1e-9);
    }

    #[test]
    fn holds_the_end_values_outside_the_note() {
        // 0 으로 떨어뜨리면 음이 끝에서 튄다
        let curve = curve_with(&[(0.25, 100.0), (0.75, -100.0)], 1.0);
        assert_eq!(curve.cents_at(0.0), 100.0, "첫 점 앞이 유지되지 않았다");
        assert_eq!(
            curve.cents_at(5.0),
            -100.0,
            "마지막 점 뒤가 유지되지 않았다"
        );
    }

    #[test]
    fn duration_scales_the_shape() {
        // 음을 늘려도 모양이 유지돼야 한다 — 그래서 초가 아니라 정규화 시간이다
        let short = curve_with(&[(0.0, 0.0), (1.0, 100.0)], 1.0);
        let long = curve_with(&[(0.0, 0.0), (1.0, 100.0)], 4.0);
        assert!((short.cents_at(0.5) - long.cents_at(2.0)).abs() < 1e-9);
    }

    #[test]
    fn max_deviation_covers_the_drawn_points() {
        // 덜 잡으면 딜레이 라인이 모자라 음정이 틀어진다
        let curve = curve_with(&[(0.0, -300.0), (0.5, 700.0), (1.0, 0.0)], 1.0);
        assert!(curve.max_deviation_cents() >= 700.0);
    }

    #[test]
    fn bad_input_is_rejected_not_smuggled_in() {
        let mut curve = PitchCurve::default();
        // 길이가 0 이면 정규화 시간을 초로 되돌릴 수 없다
        curve.set_points(
            &[CurvePoint {
                t_norm: 0.5,
                cents: 10.0,
            }],
            0.0,
        );
        assert!(!curve.uses_points());

        // 뒤집힌 순서는 버린다 — 여기서 정렬해 주면 화면과 소리가 달라도 조용히 넘어간다
        curve.set_points(
            &[
                CurvePoint {
                    t_norm: 0.8,
                    cents: 10.0,
                },
                CurvePoint {
                    t_norm: 0.2,
                    cents: 90.0,
                },
            ],
            1.0,
        );
        assert_eq!(curve.point_count, 1);

        // NaN 이 들어오면 그 점만 버린다
        curve.set_points(
            &[
                CurvePoint {
                    t_norm: 0.0,
                    cents: f64::NAN,
                },
                CurvePoint {
                    t_norm: 1.0,
                    cents: 50.0,
                },
            ],
            1.0,
        );
        assert_eq!(curve.point_count, 1);
        assert!(curve.cents_at(0.5).is_finite());
    }

    #[test]
    fn point_count_is_capped() {
        let many: Vec<CurvePoint> = (0..MAX_CURVE_POINTS * 3)
            .map(|i| CurvePoint {
                t_norm: i as f64 / (MAX_CURVE_POINTS * 3) as f64,
                cents: 10.0,
            })
            .collect();
        let mut curve = PitchCurve::default();
        curve.set_points(&many, 1.0);
        assert_eq!(curve.point_count, MAX_CURVE_POINTS);
    }
}

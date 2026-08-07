//! 비정규수(denormal) 처리 (`sound.md` 6-3).
//!
//! > 잔향·감쇠가 0으로 수렴할 때 부동소수점이 비정규 구간에 들어가면
//! > **CPU 가 수십 배로 튄다**
//! > flush-to-zero 설정 또는 아주 작은 DC 오프셋 주입
//!
//! # 왜 wasm 에서 직접 해야 하는가
//!
//! x86 에는 FTZ/DAZ 라는 CPU 플래그가 있어 한 번 켜면 하드웨어가 알아서 처리한다.
//! **wasm 에는 그 플래그가 없다** — 명세가 IEEE 754 를 엄격히 따르도록 정해 두었기
//! 때문이다. 그래서 값을 직접 0으로 눌러야 한다.
//!
//! # 어디에 걸어야 하는가
//!
//! **되먹임(피드백) 경로의 상태 변수**다. 줄의 딜레이 라인·필터 상태, 모달의 회전자,
//! 리버브 꼬리처럼 값이 0을 향해 끝없이 줄어드는 곳. 출력에만 걸면 소용없다 —
//! 느려지는 원인은 상태 변수끼리의 연산이기 때문이다.

/// 이 값보다 작으면 0으로 누른다.
///
/// f32 의 최소 정규수는 약 1.18e-38 이다. 그보다 넉넉히 위에서 자른다 —
/// 1e-30 은 -600dB 이라 어차피 들리지 않고, 여유를 두면 f64 중간 계산이
/// 비정규 구간에 들어가는 것도 막는다.
pub const THRESHOLD: f64 = 1e-30;

/// 비정규 구간이면 0으로 만든다
#[inline(always)]
pub fn flush(x: f64) -> f64 {
    if x.abs() < THRESHOLD {
        0.0
    } else {
        x
    }
}

/// 슬라이스 전체를 처리한다 (딜레이 라인처럼 긴 상태에 쓴다)
pub fn flush_slice(buffer: &mut [f32]) {
    for v in buffer.iter_mut() {
        if (*v as f64).abs() < THRESHOLD {
            *v = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushes_only_the_tiny_values() {
        assert_eq!(flush(0.0), 0.0);
        assert_eq!(flush(1e-40), 0.0);
        assert_eq!(flush(-1e-40), 0.0);
        // 들리는 크기는 건드리지 않는다
        assert_eq!(flush(1e-6), 1e-6);
        assert_eq!(flush(-0.5), -0.5);
    }

    #[test]
    fn threshold_is_above_f32_subnormal_range() {
        // f32 최소 정규수보다 위에서 잘라야 f32 로 저장할 때도 비정규가 안 된다
        let smallest_normal = f32::MIN_POSITIVE as f64;
        assert!(
            THRESHOLD > smallest_normal,
            "임계값 {THRESHOLD} 가 f32 최소 정규수 {smallest_normal} 보다 작다"
        );
    }

    #[test]
    fn threshold_is_inaudible() {
        // -600dB 이하. 24bit 의 최소 단위(-144dB)보다 한참 아래다
        let db = 20.0 * THRESHOLD.log10();
        assert!(db < -500.0, "임계값이 {db}dB — 들릴 수 있다");
    }

    #[test]
    fn flush_slice_clears_a_decayed_buffer() {
        let mut buffer = vec![1e-40f32; 64];
        buffer[0] = 0.25;
        flush_slice(&mut buffer);
        assert_eq!(buffer[0], 0.25);
        assert!(buffer[1..].iter().all(|v| *v == 0.0));
    }
}

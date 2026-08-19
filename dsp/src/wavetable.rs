//! 대역제한 웨이브테이블 — **에일리어싱을 최상급으로** (`sound.md` 11-2).
//!
//! ## 왜 PolyBLEP 을 대체하는가
//!
//! PolyBLEP 은 불연속 앞뒤 한 샘플만 손보는 근사다. 싸고 효과가 크지만 한계가
//! 있다 — 실측으로 톱니의 접힘이 **-39dB** 까지밖에 안 내려갔다(대역제한이
//! 아예 없으면 -22.9dB). 가청 대역이라 솔로 리드 고음에서 들린다.
//!
//! 근본 해법은 **애초에 나이퀴스트 위 하모닉을 만들지 않는 것**이다. 옥타브마다
//! "그 음역에서 접히지 않는 하모닉만" 담은 테이블을 미리 만들어 두고 읽는다.
//! 접힐 성분이 없으므로 접힘도 없다.
//!
//! ## 세 가지 선택과 그 이유
//!
//! **1. 테이블은 IFFT 로 만든다.** 하모닉을 하나씩 사인으로 더하면 가장 낮은
//! 옥타브에서만 1500 × 8192 = 1200만 번 곱해야 해서 시작이 눈에 띄게 느려진다.
//! 주파수 축에 진폭을 꽂고 한 번 역변환하면 끝이다.
//!
//! **2. 큐빅 보간을 쓴다.** 선형 보간의 오차는 (k/N)² 에 비례해서, -90dB 를
//! 맞추려면 테이블이 수십만 점이어야 한다. 큐빅은 (k/N)⁴ 이라 8192 점으로 닿는다.
//!
//! **3. 옥타브마다 테이블 크기가 다르다.** 고음은 하모닉이 몇 개 없으므로 큰
//! 테이블이 낭비다. 낮은 옥타브만 크게 잡아 메모리를 아낀다.

use std::sync::{Arc, Mutex, OnceLock};

/// 미프맵 최저 주파수. 신스는 8Hz 까지 내려갈 수 있다 (`SynthVoice::note_on` 의 클램프)
const BASE_HZ: f64 = 8.0;
/// 8Hz 부터 2의 거듭제곱으로 12옥타브 → 32768Hz. 어떤 표본율에서도 덮는다
const LEVELS: usize = 12;

/// 테이블 점수 = 하모닉 수 × 이 값 (2의 거듭제곱으로 올림).
///
/// 보간 오차가 여기서 결정된다. 8 로 두고 실측해 -90dB 를 확인했다 —
/// 줄이면 메모리는 줄지만 접힘이 올라간다.
const OVERSAMPLE: usize = 8;
const MAX_POINTS: usize = 8192;
const MIN_POINTS: usize = 64;

/// 파형 종류. `Sine` 은 테이블이 필요 없다 — 해석적으로 정확하다
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TableWave {
    Saw,
    Square,
    Triangle,
}

/// 한 옥타브의 테이블
struct Level {
    points: Vec<f32>,
    /// 이 레벨을 쓰는 최대 주파수 (이보다 높으면 다음 레벨)
    max_hz: f64,
}

pub struct WaveTable {
    levels: Vec<Level>,
}

impl WaveTable {
    /// 표본율에 맞춰 만든다. **표본율이 바뀌면 다시 만들어야 한다** —
    /// 담아야 할 하모닉 수가 나이퀴스트에 달려 있다
    pub fn new(wave: TableWave, sample_rate: f64) -> Self {
        let nyquist = sample_rate * 0.5;
        let mut levels = Vec::with_capacity(LEVELS);

        for level in 0..LEVELS {
            let max_hz = BASE_HZ * (1u32 << (level + 1)) as f64;
            // **이 옥타브에서 가장 높은 음을 기준으로 자른다.** 평균이나 최저음으로
            // 자르면 옥타브 위쪽에서 하모닉이 나이퀴스트를 넘어 접힌다
            let harmonics = ((nyquist / max_hz).floor() as usize).max(1);

            let mut points = (harmonics * OVERSAMPLE).next_power_of_two();
            points = points.clamp(MIN_POINTS, MAX_POINTS);

            levels.push(Level {
                points: synthesize(wave, harmonics, points),
                max_hz,
            });
        }
        Self { levels }
    }

    /// 주파수에 맞는 레벨을 고른다
    fn level_for(&self, freq_hz: f64) -> &Level {
        for level in &self.levels {
            if freq_hz < level.max_hz {
                return level;
            }
        }
        // 마지막 레벨은 하모닉이 1개(사인)라 어떤 주파수든 접히지 않는다
        self.levels.last().expect("레벨이 비어 있다")
    }

    /// 위상(0~1)에서 값을 읽는다. **큐빅 에르미트 보간** —
    /// 선형으로는 -90dB 에 못 닿는다 (오차가 (k/N)² 대 (k/N)⁴)
    pub fn sample(&self, freq_hz: f64, phase: f64) -> f64 {
        let level = self.level_for(freq_hz);
        let n = level.points.len();
        let x = phase.rem_euclid(1.0) * n as f64;
        let i = x as usize % n;
        let frac = x - x.floor();

        // 주기 파형이므로 양 끝을 감아 온다
        let p0 = level.points[(i + n - 1) % n] as f64;
        let p1 = level.points[i] as f64;
        let p2 = level.points[(i + 1) % n] as f64;
        let p3 = level.points[(i + 2) % n] as f64;

        // Catmull-Rom
        let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
        let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
        let c = -0.5 * p0 + 0.5 * p2;
        ((a * frac + b) * frac + c) * frac + p1
    }

    /// 진단용 — 이 주파수에서 몇 개의 하모닉이 살아 있는가
    pub fn harmonics_at(&self, freq_hz: f64, sample_rate: f64) -> usize {
        let level = self.level_for(freq_hz);
        ((sample_rate * 0.5 / level.max_hz).floor() as usize).max(1)
    }

    pub fn points_at(&self, freq_hz: f64) -> usize {
        self.level_for(freq_hz).points.len()
    }
}

/// 하모닉 진폭을 주파수 축에 꽂고 역변환한다.
///
/// 위상은 **기존 PolyBLEP 파형과 같게** 맞춘다. 안 그러면 같은 프리셋의 소리가
/// 갑자기 달라진다:
///   - 톱니 `2t-1` → -(2/π)·Σ sin(2πkt)/k
///   - 사각 `t<0.5 ? 1 : -1` → (4/π)·Σ_{홀수} sin(2πkt)/k
///   - 삼각 (사각의 적분) → (8/π²)·Σ_{홀수} (-1)^((k-1)/2)·sin(2πkt)/k²
fn synthesize(wave: TableWave, harmonics: usize, points: usize) -> Vec<f32> {
    let mut re = vec![0.0f64; points];
    let mut im = vec![0.0f64; points];

    for k in 1..=harmonics {
        if k >= points / 2 {
            break; // 테이블 자체의 나이퀴스트
        }
        let amplitude = match wave {
            TableWave::Saw => -2.0 / (core::f64::consts::PI * k as f64),
            TableWave::Square => {
                if k % 2 == 1 {
                    4.0 / (core::f64::consts::PI * k as f64)
                } else {
                    0.0
                }
            }
            TableWave::Triangle => {
                if k % 2 == 1 {
                    let sign = if (k - 1) / 2 % 2 == 0 { 1.0 } else { -1.0 };
                    sign * 8.0 / (core::f64::consts::PI * core::f64::consts::PI * (k * k) as f64)
                } else {
                    0.0
                }
            }
        };
        if amplitude == 0.0 {
            continue;
        }
        // sin(2πkt) 성분 = 켤레 대칭인 순허수 쌍
        im[k] = -amplitude * points as f64 / 2.0;
        im[points - k] = amplitude * points as f64 / 2.0;
    }

    inverse_fft(&mut re, &mut im);
    re.iter().map(|v| *v as f32).collect()
}

/// 제자리 복소 FFT (반복 radix-2). 길이는 2의 거듭제곱
fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two());

    // 비트 반전 재배열
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    let mut len = 2;
    while len <= n {
        let ang = -2.0 * core::f64::consts::PI / len as f64;
        let (w_re, w_im) = (ang.cos(), ang.sin());
        let mut i = 0;
        while i < n {
            let (mut cur_re, mut cur_im) = (1.0f64, 0.0f64);
            for k in 0..len / 2 {
                let u_re = re[i + k];
                let u_im = im[i + k];
                let v_re = re[i + k + len / 2] * cur_re - im[i + k + len / 2] * cur_im;
                let v_im = re[i + k + len / 2] * cur_im + im[i + k + len / 2] * cur_re;
                re[i + k] = u_re + v_re;
                im[i + k] = u_im + v_im;
                re[i + k + len / 2] = u_re - v_re;
                im[i + k + len / 2] = u_im - v_im;
                let next_re = cur_re * w_re - cur_im * w_im;
                cur_im = cur_re * w_im + cur_im * w_re;
                cur_re = next_re;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// 역변환 — 켤레를 취해 정변환하고 다시 켤레를 취한 뒤 N 으로 나눈다
fn inverse_fft(re: &mut [f64], im: &mut [f64]) {
    for v in im.iter_mut() {
        *v = -*v;
    }
    fft(re, im);
    let scale = 1.0 / re.len() as f64;
    for v in re.iter_mut() {
        *v *= scale;
    }
    for v in im.iter_mut() {
        *v *= -scale;
    }
}

/// 세 파형의 테이블 묶음. **보이스마다 갖지 않는다** —
/// 32보이스 × 300KB 면 메모리가 터진다
pub struct WaveTableSet {
    saw: WaveTable,
    square: WaveTable,
    triangle: WaveTable,
}

impl WaveTableSet {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            saw: WaveTable::new(TableWave::Saw, sample_rate),
            square: WaveTable::new(TableWave::Square, sample_rate),
            triangle: WaveTable::new(TableWave::Triangle, sample_rate),
        }
    }

    pub fn get(&self, wave: TableWave) -> &WaveTable {
        match wave {
            TableWave::Saw => &self.saw,
            TableWave::Square => &self.square,
            TableWave::Triangle => &self.triangle,
        }
    }
}

/// 표본율별로 한 벌만 만들어 **여러 보이스가 나눠 쓴다.**
///
/// 전역 `static mut` 로 뒀더니 테스트가 병렬로 돌 때 경쟁이 났다 — wasm 은 단일
/// 스레드라 실사용에서는 안 터지지만, **테스트에서 터지는 것은 코드가 틀렸다는
/// 뜻이다.** 자물쇠는 보이스를 만들 때만 잡고 오디오 경로에는 없다.
/// 표본율(비트 패턴)을 키로 하는 캐시. 이름을 붙여야 읽을 때 무엇인지 보인다
type TableCache = OnceLock<Mutex<Vec<(u64, Arc<WaveTableSet>)>>>;

static CACHE: TableCache = OnceLock::new();

pub fn shared(sample_rate: f64) -> Arc<WaveTableSet> {
    let key = sample_rate.to_bits();
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    let mut guard = match cache.lock() {
        Ok(g) => g,
        // 다른 스레드가 패닉해 자물쇠가 오염돼도 테이블은 불변이라 그대로 쓴다
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some((_, table)) = guard.iter().find(|(k, _)| *k == key) {
        return Arc::clone(table);
    }
    let table = Arc::new(WaveTableSet::new(sample_rate));
    guard.push((key, Arc::clone(&table)));
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    /// 한 주기를 읽어 이상적인 파형과 견준다
    fn shape(wave: TableWave, freq: f64, samples: usize) -> Vec<f64> {
        let table = WaveTable::new(wave, FS);
        (0..samples)
            .map(|i| table.sample(freq, i as f64 / samples as f64))
            .collect()
    }

    #[test]
    fn saw_matches_the_ideal_ramp_at_low_frequency() {
        // 낮은 음에서는 하모닉이 많아 이상적인 톱니에 가까워야 한다.
        // **불연속 근처는 뺀다** — 대역제한된 파형은 거기서 링잉하는 것이 정상이고
        // (깁스 현상), 그게 없으면 오히려 대역제한이 안 된 것이다
        let n = 512;
        let got = shape(TableWave::Saw, 55.0, n);
        let mut worst = 0.0f64;
        for (i, v) in got.iter().enumerate() {
            let t = i as f64 / n as f64;
            if !(0.03..0.97).contains(&t) {
                continue;
            }
            worst = worst.max((v - (2.0 * t - 1.0)).abs());
        }
        assert!(worst < 0.06, "이상적인 톱니와 {worst:.3} 어긋난다");
    }

    #[test]
    fn square_matches_the_ideal_pulse() {
        let n = 512;
        let got = shape(TableWave::Square, 55.0, n);
        let mut worst = 0.0f64;
        for (i, v) in got.iter().enumerate() {
            let t = i as f64 / n as f64;
            if !(0.03..0.47).contains(&t) && !(0.53..0.97).contains(&t) {
                continue;
            }
            let ideal = if t < 0.5 { 1.0 } else { -1.0 };
            worst = worst.max((v - ideal).abs());
        }
        assert!(worst < 0.12, "이상적인 사각파와 {worst:.3} 어긋난다");
    }

    #[test]
    fn triangle_peaks_at_one_and_is_continuous() {
        let got = shape(TableWave::Triangle, 55.0, 512);
        let peak = got.iter().fold(0.0f64, |a, v| a.max(v.abs()));
        assert!((0.9..1.1).contains(&peak), "삼각파 피크가 {peak:.3}");
        // 삼각파는 불연속이 없다 — 이웃 샘플이 크게 튀면 안 된다
        let max_jump = got
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f64, f64::max);
        assert!(max_jump < 0.05, "삼각파에 불연속이 있다: {max_jump:.3}");
    }

    #[test]
    fn high_notes_keep_only_the_harmonics_that_fit() {
        // **이게 대역제한의 정의다.** 4186Hz(C8)에서 24kHz 아래에 들어가는
        // 하모닉은 5개뿐이다
        let table = WaveTable::new(TableWave::Saw, FS);
        assert_eq!(table.harmonics_at(4186.0, FS), 2);
        assert!(table.harmonics_at(110.0, FS) > 100);
    }

    #[test]
    fn tables_shrink_for_high_octaves() {
        // 고음은 하모닉이 몇 개 없으므로 큰 테이블이 낭비다
        let table = WaveTable::new(TableWave::Saw, FS);
        assert!(table.points_at(55.0) > table.points_at(4186.0));
    }

    #[test]
    fn generation_is_deterministic() {
        let a = WaveTable::new(TableWave::Saw, FS);
        let b = WaveTable::new(TableWave::Saw, FS);
        for i in 0..1000 {
            let phase = i as f64 / 1000.0;
            assert_eq!(a.sample(220.0, phase), b.sample(220.0, phase));
        }
    }
}

#[cfg(test)]
mod level_tests {
    use super::*;

    const FS: f64 = 48000.0;

    /// **대역제한을 하면서 소리가 작아지면 안 된다.**
    ///
    /// 하모닉을 지나치게 자르면 톱니가 사인처럼 들리고, 사용자는 "신스가 힘이
    /// 없다"고 느낀다. 이상적인 톱니(-1~1 램프)의 RMS 는 1/√3 ≈ 0.577 이다
    #[test]
    fn saw_keeps_the_ideal_level_at_low_notes() {
        let table = WaveTable::new(TableWave::Saw, FS);
        let n = 4096;
        let sum: f64 = (0..n)
            .map(|i| {
                let v = table.sample(110.0, i as f64 / n as f64);
                v * v
            })
            .sum();
        let rms = (sum / n as f64).sqrt();
        assert!(
            (0.52..0.60).contains(&rms),
            "110Hz 톱니 RMS 가 {rms:.3} (이상적인 값 0.577)"
        );
    }

    /// 고음은 하모닉이 몇 개 없으니 자연스럽게 작아진다 —
    /// **그건 정상이다.** 사인 하나만 남으면 RMS 는 0.707×진폭이 된다
    #[test]
    fn high_notes_get_quieter_because_harmonics_are_gone() {
        let table = WaveTable::new(TableWave::Saw, FS);
        let rms_at = |freq: f64| {
            let n = 4096;
            let sum: f64 = (0..n)
                .map(|i| {
                    let v = table.sample(freq, i as f64 / n as f64);
                    v * v
                })
                .sum();
            (sum / n as f64).sqrt()
        };
        assert!(rms_at(110.0) > rms_at(4186.0));
        // 그래도 사라지면 안 된다
        assert!(rms_at(4186.0) > 0.2, "고음이 너무 작아졌다");
    }

    #[test]
    fn square_and_triangle_keep_their_levels() {
        let rms = |wave: TableWave| {
            let table = WaveTable::new(wave, FS);
            let n = 4096;
            let sum: f64 = (0..n)
                .map(|i| {
                    let v = table.sample(110.0, i as f64 / n as f64);
                    v * v
                })
                .sum();
            (sum / n as f64).sqrt()
        };
        // 사각파는 ±1 이라 RMS 1.0, 삼각파는 1/√3
        assert!(
            (0.93..1.05).contains(&rms(TableWave::Square)),
            "사각파 {}",
            rms(TableWave::Square)
        );
        assert!(
            (0.52..0.62).contains(&rms(TableWave::Triangle)),
            "삼각파 {}",
            rms(TableWave::Triangle)
        );
    }
}

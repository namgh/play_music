//! 샘플 재생 보이스 — 드럼·보컬·앙상블 (`sound.md` Tier 4, M5).
//!
//! > 드럼·퍼커션: 모달/2D 메시로 가능하나 CPU 가 비싸고, 샘플이 더 좋고 더 싸다
//! > 보컬·코러스: 성대·성도 모델링은 연구 영역. 납득할 품질 미달
//! > 앙상블 스트링: 다수 연주자의 미세한 불일치가 음색의 본질. 모델링 대상이 아니다
//!
//! **이건 후퇴가 아니라 정답이다** (`sound.md` 13절).
//!
//! # 포먼트 보존이 여기서 처음 의미를 갖는다
//!
//! 웨이브가이드 합성음은 음정을 딜레이 길이로 **직접 만들기** 때문에 포먼트가 밀릴
//! 일이 없다. 반면 샘플은 재생 속도를 바꿔 음정을 옮기므로 스펙트럼 전체가 같이
//! 밀린다 — 목소리를 올리면 만화 같아지는 그 현상이다.
//!
//! 그래서 `plan.md` 5-4 가 포먼트 보존을 "음이 아니라 **보이스의 능력**"으로 두었다.
//! 이 보이스만 그 능력을 갖는다.
//!
//! **에셋은 여기 없다.** 실제 드럼·보컬 샘플은 녹음이나 라이선스가 필요하고
//! (`sound.md` 3절 Tier 4), 그건 코드로 만들 수 있는 것이 아니다. 이 모듈은
//! 샘플이 주어졌을 때 그것을 **정확한 음정으로, 포먼트를 지키며** 재생하는 층이다.

use crate::smooth::{times, Smoothed};

/// 샘플 하나가 담기는 최대 길이 (초). 원샷 드럼·짧은 보컬 음절 기준
pub const MAX_SAMPLE_SEC: f64 = 8.0;

/// 4점 라그랑주 보간으로 분수 위치를 읽는다.
/// 선형 보간은 고역을 크게 깎아 심벌 같은 소리가 둔해진다.
fn read_interpolated(data: &[f32], position: f64) -> f64 {
    let index = position.floor() as isize;
    let frac = position - index as f64;

    let at = |offset: isize| -> f64 {
        let i = index + offset;
        if i < 0 || i as usize >= data.len() {
            0.0
        } else {
            data[i as usize] as f64
        }
    };

    let (xm1, x0, x1, x2) = (at(-1), at(0), at(1), at(2));
    let c0 = x0;
    let c1 = 0.5 * (x1 - xm1);
    let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
    let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    ((c3 * frac + c2) * frac + c1) * frac + c0
}

/// 샘플 데이터 하나. 여러 보이스가 공유한다
pub struct SampleData {
    pub frames: Vec<f32>,
    pub sample_rate: f64,
    /// 이 샘플이 녹음된 음정. 드럼처럼 음정이 없으면 0
    pub root_hz: f64,
}

impl SampleData {
    pub fn empty() -> Self {
        Self {
            frames: Vec::new(),
            sample_rate: 48000.0,
            root_hz: 0.0,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SamplerParams {
    /// 포먼트를 지킬지. 샘플 보이스만 이 능력을 갖는다 (`plan.md` 5-4)
    pub preserve_formant: bool,
    /// 시작 위치 (0~1). 드럼의 어택을 건너뛰거나 루프 지점을 잡을 때
    pub start: f64,
    /// 재생 게인
    pub level: f64,
}

impl Default for SamplerParams {
    fn default() -> Self {
        Self {
            preserve_formant: true,
            start: 0.0,
            level: 1.0,
        }
    }
}

/// 샘플 재생 보이스.
///
/// # 포먼트 보존은 PSOLA 로 한다
///
/// 처음에 "시변 딜레이 + 크로스페이드"로 만들었다가 실패했다 — 읽는 속도를 바꾸는
/// 것은 결국 리샘플링이고, 리샘플링은 **스펙트럼 전체를 민다**. 측정해 보니
/// 포먼트가 1204Hz → 2205Hz 로 83% 밀렸다. 포먼트를 지킨다는 말과 정반대다.
///
/// PSOLA(피치 동기 중첩 가산)는 다르게 접근한다:
///  - 읽기 위치는 **원본 속도 그대로** 나아간다 → 그레인 안의 파형이 원본과 같다
///    = 스펙트럼 포락선(포먼트)이 그대로다
///  - 그레인을 **새 주기 간격으로** 내보낸다 → 기본 주기만 바뀐다 = 음정이 바뀐다
///
/// 이게 "재생 속도를 바꾸지 않고 음정만 바꾼다"의 실제 구현이다.
pub struct SamplerVoice {
    sample_rate: f64,
    /// 원본에서 읽는 위치 (분수). 원본 속도로만 나아간다
    position: f64,
    /// 샘플레이트 보정 (음정과 무관)
    rate: f64,
    /// 음정 배율
    pitch_ratio: f64,
    preserve_formant: bool,
    /// 원본의 한 주기 (샘플). 그레인 크기와 배치 간격의 기준
    source_period: f64,
    /// 다음 그레인을 내보낼 때까지 남은 샘플
    grain_countdown: f64,
    /// 중첩 가산 버퍼 (링). 그레인들이 여기 겹쳐 쌓인다
    overlap: Vec<f32>,
    overlap_read: usize,
    level: Smoothed,
    velocity: f64,
    active: bool,
}

/// 중첩 버퍼 크기. 최저 근음(20Hz)의 그레인 두 개가 들어가야 한다
const OVERLAP_CAPACITY: usize = 16384;

impl SamplerVoice {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            position: 0.0,
            rate: 1.0,
            pitch_ratio: 1.0,
            preserve_formant: true,
            source_period: 0.0,
            grain_countdown: 0.0,
            overlap: vec![0.0; OVERLAP_CAPACITY],
            overlap_read: 0,
            level: Smoothed::new(1.0, times::GAIN_MS, sample_rate),
            velocity: 1.0,
            active: false,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn note_on(
        &mut self,
        freq_hz: f64,
        velocity: f64,
        sample: &SampleData,
        params: &SamplerParams,
    ) {
        if sample.is_empty() {
            self.active = false;
            return;
        }

        let rate_correction = sample.sample_rate / self.sample_rate;
        // 음정이 없는 샘플(드럼)은 음정을 바꾸지 않는다 — 킥을 반음 올리면 킥이 아니다
        let pitch_ratio = if sample.root_hz > 0.0 {
            (freq_hz / sample.root_hz).clamp(0.25, 4.0)
        } else {
            1.0
        };

        // 근음을 모르면 PSOLA 를 걸 수 없다 (주기를 모른다)
        self.preserve_formant = params.preserve_formant && sample.root_hz > 0.0;
        self.pitch_ratio = pitch_ratio;
        self.source_period = if sample.root_hz > 0.0 {
            (sample.sample_rate / sample.root_hz).clamp(8.0, (OVERLAP_CAPACITY / 4) as f64)
        } else {
            0.0
        };

        self.rate = if self.preserve_formant {
            // 읽기는 원본 속도. 음정은 그레인 간격이 만든다
            rate_correction
        } else {
            // 속도로 음정을 바꾼다 (포먼트가 같이 밀린다)
            rate_correction * pitch_ratio
        };

        self.position = params.start.clamp(0.0, 0.99) * sample.frames.len() as f64;
        self.grain_countdown = 0.0;
        self.overlap.fill(0.0);
        self.overlap_read = 0;
        self.velocity = velocity.clamp(0.0, 1.0);
        self.level.reset(params.level.clamp(0.0, 2.0));
        self.active = true;
    }

    pub fn note_off(&mut self) {
        // 원샷은 끝까지 간다. 루프 샘플이 들어오면 여기서 릴리즈를 건다
    }

    pub fn reset(&mut self) {
        self.active = false;
        self.position = 0.0;
        self.grain_countdown = 0.0;
        self.overlap.fill(0.0);
        self.overlap_read = 0;
    }

    /// 그레인 하나를 중첩 버퍼에 더한다. 해닝 창을 씌워 이음새를 없앤다
    fn emit_grain(&mut self, sample: &SampleData) {
        let length = (2.0 * self.source_period).round() as usize;
        if length < 4 {
            return;
        }
        let half = length as f64 / 2.0;

        for k in 0..length {
            let window = 0.5 - 0.5 * (2.0 * core::f64::consts::PI * k as f64 / length as f64).cos();
            let source = self.position - half + k as f64;
            if source < 0.0 || source >= sample.frames.len() as f64 {
                continue;
            }
            let index = (self.overlap_read + k) % OVERLAP_CAPACITY;
            self.overlap[index] += (read_interpolated(&sample.frames, source) * window) as f32;
        }
    }

    /// `out` 에 **더한다**
    pub fn process(&mut self, out: &mut [f32], sample: &SampleData) {
        if !self.active || sample.is_empty() {
            return;
        }
        let length = sample.frames.len() as f64;

        for slot in out.iter_mut() {
            if self.position >= length {
                self.active = false;
                break;
            }

            let gain = self.level.advance() * self.velocity;

            let value = if self.preserve_formant {
                if self.grain_countdown <= 0.0 {
                    self.emit_grain(sample);
                    // **새 주기 간격으로** 내보낸다 — 여기가 음정을 만드는 곳
                    self.grain_countdown += (self.source_period / self.pitch_ratio).max(4.0);
                }
                self.grain_countdown -= 1.0;

                let value = self.overlap[self.overlap_read] as f64;
                self.overlap[self.overlap_read] = 0.0;
                self.overlap_read = (self.overlap_read + 1) % OVERLAP_CAPACITY;
                // 그레인이 두 겹으로 쌓이므로 절반으로 되돌린다
                value * 0.5
            } else {
                read_interpolated(&sample.frames, self.position)
            };

            *slot += (value * gain) as f32;
            self.position += self.rate;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    /// 포먼트가 뚜렷한 시험 신호: 기본음 + 고정된 공진 봉우리.
    /// 사람 목소리를 흉내낸 것 — 기본음이 바뀌어도 봉우리 위치는 그대로여야 한다
    fn voice_like(freq: f64, formant_hz: f64, seconds: f64) -> SampleData {
        let n = (seconds * FS) as usize;
        let mut frames = vec![0.0f32; n];
        for (i, slot) in frames.iter_mut().enumerate() {
            let t = i as f64 / FS;
            let mut sum = 0.0;
            // 하모닉을 쌓되, 포먼트 주파수 근처를 강조한다
            for k in 1..=40 {
                let hz = freq * k as f64;
                if hz > FS * 0.45 {
                    break;
                }
                let distance = (hz - formant_hz).abs() / 400.0;
                let weight = (-distance * distance).exp() + 0.05;
                sum += weight * (2.0 * core::f64::consts::PI * hz * t).sin() / k as f64;
            }
            *slot = (sum * 0.3) as f32;
        }
        SampleData {
            frames,
            sample_rate: FS,
            root_hz: freq,
        }
    }

    fn render(sample: &SampleData, freq: f64, params: SamplerParams, n: usize) -> Vec<f32> {
        let mut voice = SamplerVoice::new(FS);
        voice.note_on(freq, 1.0, sample, &params);
        let mut out = vec![0.0f32; n];
        voice.process(&mut out, sample);
        out
    }

    fn magnitude_at(signal: &[f32], hz: f64) -> f64 {
        let w = 2.0 * core::f64::consts::PI * hz / FS;
        let n = signal.len();
        let (mut re, mut im, mut norm) = (0.0, 0.0, 0.0);
        for (i, s) in signal.iter().enumerate() {
            let window =
                0.5 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / (n - 1) as f64).cos();
            let v = *s as f64 * window;
            re += v * (w * i as f64).cos();
            im -= v * (w * i as f64).sin();
            norm += window;
        }
        2.0 * (re * re + im * im).sqrt() / norm.max(1.0)
    }

    /// 스펙트럼 무게중심 — 포먼트가 밀렸는지 보는 지표
    fn centroid(signal: &[f32]) -> f64 {
        let mut weighted = 0.0;
        let mut total = 0.0;
        let mut hz = 200.0;
        while hz < 5000.0 {
            let m = magnitude_at(signal, hz);
            weighted += hz * m;
            total += m;
            hz += 100.0;
        }
        if total > 0.0 {
            weighted / total
        } else {
            0.0
        }
    }

    #[test]
    fn plays_the_sample() {
        let sample = voice_like(220.0, 1200.0, 0.5);
        let out = render(&sample, 220.0, SamplerParams::default(), 8192);
        let peak = out.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.01, "소리가 안 난다: {peak}");
        assert!(out.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn empty_sample_is_silent_not_a_crash() {
        let empty = SampleData::empty();
        let mut voice = SamplerVoice::new(FS);
        voice.note_on(440.0, 1.0, &empty, &SamplerParams::default());
        assert!(!voice.is_active(), "빈 샘플로 보이스가 잡혔다");

        let mut out = vec![0.0f32; 512];
        voice.process(&mut out, &empty);
        assert!(out.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn without_formant_preservation_the_spectrum_shifts() {
        // 이게 문제의 존재다. 재생 속도로 음정을 올리면 포먼트가 같이 올라간다
        let sample = voice_like(220.0, 1200.0, 1.0);
        let params = SamplerParams {
            preserve_formant: false,
            ..Default::default()
        };

        let original = render(&sample, 220.0, params, 16384);
        let up = render(&sample, 440.0, params, 16384);

        let before = centroid(&original);
        let after = centroid(&up);
        assert!(
            after > before * 1.4,
            "속도 재생인데 스펙트럼이 안 밀렸다: {before:.0}Hz → {after:.0}Hz"
        );
    }

    #[test]
    fn formant_preservation_keeps_the_spectrum_in_place() {
        // `plan.md` 5-4: 샘플 리샘플 보이스만 이 능력이 의미를 갖는다
        let sample = voice_like(220.0, 1200.0, 1.0);
        let params = SamplerParams {
            preserve_formant: true,
            ..Default::default()
        };

        let original = render(&sample, 220.0, params, 16384);
        let up = render(&sample, 330.0, params, 16384);

        let before = centroid(&original);
        let after = centroid(&up);
        let shift = (after - before).abs() / before;
        assert!(
            shift < 0.25,
            "포먼트가 {before:.0}Hz → {after:.0}Hz 로 {:.0}% 밀렸다",
            shift * 100.0
        );
    }

    #[test]
    fn unpitched_samples_are_not_transposed() {
        // 킥 드럼을 반음 올리면 킥이 아니다. root_hz 가 0 이면 음정을 건드리지 않는다
        let mut drum = voice_like(80.0, 300.0, 0.3);
        drum.root_hz = 0.0;

        let low = render(&drum, 100.0, SamplerParams::default(), 8192);
        let high = render(&drum, 800.0, SamplerParams::default(), 8192);

        for (a, b) in low.iter().zip(high.iter()) {
            assert!((a - b).abs() < 1e-9, "음정 없는 샘플이 이조됐다");
        }
    }

    #[test]
    fn voice_frees_itself_at_the_end() {
        let sample = voice_like(220.0, 1000.0, 0.05); // 50ms
        let mut voice = SamplerVoice::new(FS);
        voice.note_on(220.0, 1.0, &sample, &SamplerParams::default());

        let mut out = vec![0.0f32; 4800]; // 100ms
        voice.process(&mut out, &sample);
        assert!(!voice.is_active(), "샘플이 끝났는데 보이스가 잡혀 있다");
    }

    #[test]
    fn extreme_pitch_ratios_stay_finite() {
        let sample = voice_like(220.0, 1200.0, 0.5);
        for freq in [30.0, 220.0, 6000.0] {
            for preserve in [true, false] {
                let out = render(
                    &sample,
                    freq,
                    SamplerParams {
                        preserve_formant: preserve,
                        ..Default::default()
                    },
                    8192,
                );
                assert!(
                    out.iter().all(|v| v.is_finite() && v.abs() < 4.0),
                    "{freq}Hz, 포먼트 {preserve}: 불안정"
                );
            }
        }
    }

    #[test]
    fn start_offset_skips_into_the_sample() {
        let sample = voice_like(220.0, 1200.0, 0.5);
        let from_start = render(&sample, 220.0, SamplerParams::default(), 4096);
        // 0.5 를 쓰면 안 된다 — 220Hz 에서 0.5 지점은 정확히 55주기라 파형이 같아
        // "시작 위치가 무시됐다"고 잘못 나온다
        let from_middle = render(
            &sample,
            220.0,
            SamplerParams {
                start: 0.31,
                ..Default::default()
            },
            4096,
        );

        let differing = from_start
            .iter()
            .zip(from_middle.iter())
            .filter(|(a, b)| (**a - **b).abs() > 1e-6)
            .count();
        assert!(differing > from_start.len() / 4, "시작 위치가 무시됐다");
    }
}

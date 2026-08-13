//! 오버샘플링 (`sound.md` 6-1 — 최우선 신호 품질 항목).
//!
//! > 비선형 단계는 반드시 오버샘플링한다. 앰프 왜곡, 해머 비선형, 웨이브셰이퍼 등
//! > 권장: 비선형 구간만 4배 오버샘플링 → 처리 → 저역통과 → 다운샘플
//! > 전체를 오버샘플링하지 말 것 — 필요한 구간만
//!
//! 왜: 비선형은 하모닉을 새로 만든다. 입력이 5kHz 면 왜곡은 10·15·20kHz 를 만들고,
//! 48kHz 샘플레이트에서 24kHz 를 넘는 성분은 **접혀 들어와** 원래 없던 낮은 음이 된다.
//! 그게 "싸구려 디지털 왜곡" 소리다. 접히기 전에 여유 대역을 만들어 두고 잘라낸다.
//!
//! 이 모듈은 **비선형 함수를 받는 껍데기**다. 무엇을 왜곡할지는 호출자가 정한다 —
//! 앰프, 해머, 웨이브셰이퍼가 같은 껍데기를 쓴다.

/// 오버샘플링 배수. 4배면 나이퀴스트가 4배로 밀려 3차 하모닉까지 접히지 않는다
pub const FACTOR: usize = 4;

/// 한 번에 처리하는 최대 프레임 수 (내부 버퍼 크기를 고정하기 위해)
pub const MAX_FRAMES: usize = 2048;

/// 컷오프 / 샘플레이트. 48kHz 에서 12kHz.
///
/// 나이퀴스트(0.5)에 붙이면 전이 구간이 그 위로 새어 접힌 성분이 남는다.
/// 0.25 로 내리는 대가는 12kHz 위 고역인데, 왜곡 뒤에는 캐비닛 IR 이 오고
/// 그게 5kHz 위를 크게 깎으므로(`sound.md` 5절) 실질적인 손실이 아니다.
const CUTOFF_RATIO: f64 = 0.25;

/// 2차 버터워스 저역통과 하나. 두 개를 겹쳐 4차로 쓴다.
///
/// 왜 직접 만드는가: 업샘플 후에는 원래 나이퀴스트 위를 **확실히** 없애야 하고,
/// 다운샘플 전에는 새로 생긴 고역을 없애야 한다. 감쇠가 부족하면 오버샘플링을
/// 해도 접힌 성분이 남는다 — 그러면 안 한 것과 같다.
#[derive(Clone, Copy, Debug, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    /// 저역통과. `q` 를 바꿔 두 단을 겹치면 4차 버터워스가 된다
    fn lowpass(cutoff_hz: f64, sample_rate: f64, q: f64) -> Self {
        let w0 = 2.0 * core::f64::consts::PI * cutoff_hz / sample_rate;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * q);

        let b0 = (1.0 - cos_w0) / 2.0;
        let b1 = 1.0 - cos_w0;
        let b2 = (1.0 - cos_w0) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            ..Default::default()
        }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        // 비정규수 방지 (`sound.md` 6-3). 무음이 이어질 때 필터 상태가 0으로 수렴한다
        self.y1 = crate::denormal::flush(y);
        y
    }

    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

/// 버터워스 저역통과 차수. 8차 = 2차 4단.
///
/// 왜 8차인가: 데시메이션 필터는 **최종 나이퀴스트(24kHz) 위를 60dB 이상 깎아야**
/// 한다. 접히는 자리는 오버샘플 배수와 무관하게 최종 레이트로 정해지기 때문이다.
/// 4차로는 24kHz 에서 5dB 밖에 안 깎여 오버샘플링을 해도 접힌 성분이 남았다
/// (실측 -24dB). 차수를 올리고 컷오프를 내려야 기준을 만족한다.
const ORDER: usize = 8;
const STAGES: usize = ORDER / 2;

/// 8차 버터워스 저역통과
#[derive(Clone, Copy, Debug, Default)]
struct ButterworthLowpass {
    stages: [Biquad; STAGES],
}

impl ButterworthLowpass {
    fn new(cutoff_hz: f64, sample_rate: f64) -> Self {
        let mut stages = [Biquad::default(); STAGES];
        for (k, stage) in stages.iter_mut().enumerate() {
            // 버터워스 극의 Q: 1 / (2·cos(π(2k+1)/(2N)))
            let angle = core::f64::consts::PI * (2 * k + 1) as f64 / (2 * ORDER) as f64;
            let q = 1.0 / (2.0 * angle.cos());
            *stage = Biquad::lowpass(cutoff_hz, sample_rate, q);
        }
        Self { stages }
    }

    fn process(&mut self, x: f64) -> f64 {
        let mut y = x;
        for stage in self.stages.iter_mut() {
            y = stage.process(y);
        }
        y
    }

    fn reset(&mut self) {
        for stage in self.stages.iter_mut() {
            stage.reset();
        }
    }
}

/// 비선형 구간을 4배 오버샘플링으로 감싸는 껍데기.
///
/// 사용법: `process(입력, |x| 왜곡(x))`. 왜곡 함수는 오버샘플된 레이트에서
/// 샘플마다 호출된다.
pub struct Oversampler {
    /// 업샘플 직후 (원래 나이퀴스트 위를 없앤다)
    up_filter: ButterworthLowpass,
    /// 다운샘플 직전 (비선형이 만든 고역을 없앤다)
    down_filter: ButterworthLowpass,
    /// 오버샘플된 작업 버퍼. 미리 잡아 둔다 — 오디오 경로에서 할당하지 않는다
    scratch: Vec<f64>,
}

impl Oversampler {
    pub fn new(sample_rate: f64) -> Self {
        Self::with_cutoff(sample_rate, sample_rate * CUTOFF_RATIO)
    }

    /// 컷오프를 직접 정한다. 캐비닛 IR 이 뒤에 오는 앰프처럼 고역을 어차피
    /// 깎는 경우 더 낮춰도 되고, 반대로 넓게 남기고 싶으면 올린다
    /// (단 올리면 에일리어싱이 늘어난다 — 11-2 테스트로 확인할 것)
    pub fn with_cutoff(sample_rate: f64, cutoff_hz: f64) -> Self {
        let oversampled = sample_rate * FACTOR as f64;
        Self {
            up_filter: ButterworthLowpass::new(cutoff_hz, oversampled),
            down_filter: ButterworthLowpass::new(cutoff_hz, oversampled),
            scratch: vec![0.0; MAX_FRAMES * FACTOR],
        }
    }

    pub fn reset(&mut self) {
        self.up_filter.reset();
        self.down_filter.reset();
    }

    /// `buffer` 를 제자리에서 왜곡한다. `nonlinear` 는 오버샘플된 레이트에서 호출된다.
    ///
    /// **길이 제한이 없다.** 내부 작업 버퍼보다 길면 나눠서 처리한다 —
    /// 조용히 앞부분만 처리하면 뒤쪽이 왜곡 없이 지나가고, 그건 찾기 어려운 버그가 된다.
    pub fn process<F>(&mut self, buffer: &mut [f32], mut nonlinear: F)
    where
        F: FnMut(f64) -> f64,
    {
        for chunk in buffer.chunks_mut(MAX_FRAMES) {
            self.process_chunk(chunk, &mut nonlinear);
        }
    }

    fn process_chunk<F>(&mut self, buffer: &mut [f32], nonlinear: &mut F)
    where
        F: FnMut(f64) -> f64,
    {
        let frames = buffer.len();

        // 업샘플: 0 을 끼워 넣고 저역통과 (zero-stuffing).
        // 0 을 끼우면 진폭이 1/FACTOR 로 줄므로 그만큼 되돌린다
        for (i, sample) in buffer.iter().enumerate() {
            let base = i * FACTOR;
            self.scratch[base] = self.up_filter.process(*sample as f64 * FACTOR as f64);
            for k in 1..FACTOR {
                self.scratch[base + k] = self.up_filter.process(0.0);
            }
        }

        // 비선형 + 다운샘플 직전 저역통과
        for value in self.scratch[..frames * FACTOR].iter_mut() {
            *value = self.down_filter.process(nonlinear(*value));
        }

        // 다운샘플: FACTOR 개마다 하나만 취한다 (이미 대역제한됨)
        for (i, sample) in buffer.iter_mut().enumerate() {
            *sample = self.scratch[i * FACTOR] as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    /// 특정 주파수 성분의 크기 (Goertzel 대신 단순 복조)
    fn magnitude_at(signal: &[f32], hz: f64, sample_rate: f64) -> f64 {
        let w = 2.0 * core::f64::consts::PI * hz / sample_rate;
        let n = signal.len();
        let mut re = 0.0;
        let mut im = 0.0;
        // **윈도우 이득으로 나눈다.** 해닝의 코히런트 이득은 0.5 이므로 이걸 빼먹으면
        // 진폭이 정확히 절반으로 보고된다 (처음 이걸로 속았다)
        let mut norm = 0.0;
        for (i, sample) in signal.iter().enumerate() {
            let window =
                0.5 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / (n - 1) as f64).cos();
            let s = *sample as f64 * window;
            re += s * (w * i as f64).cos();
            im -= s * (w * i as f64).sin();
            norm += window;
        }
        2.0 * (re * re + im * im).sqrt() / norm.max(1.0)
    }

    fn sine(hz: f64, amplitude: f64, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (amplitude * (2.0 * core::f64::consts::PI * hz * i as f64 / FS).sin()) as f32)
            .collect()
    }

    /// 강한 왜곡. 홀수 하모닉을 많이 만든다
    fn hard_drive(x: f64) -> f64 {
        (x * 6.0).tanh()
    }

    #[test]
    fn passes_signal_through_when_linear() {
        // 비선형이 항등함수면 입력이 (지연·필터를 제외하면) 그대로 나와야 한다
        let mut os = Oversampler::new(FS);
        let mut buffer = sine(1000.0, 0.5, 4096);
        os.process(&mut buffer, |x| x);

        let level = magnitude_at(&buffer[1024..], 1000.0, FS);
        assert!(
            (level - 0.5).abs() < 0.06,
            "1kHz 레벨이 {level} (기대 0.5 근처)"
        );
    }

    #[test]
    fn nonlinear_creates_expected_harmonics() {
        // 왜곡이 실제로 하모닉을 만드는지 — 안 만들면 아래 에일리어싱 테스트가 무의미하다
        let mut os = Oversampler::new(FS);
        let mut buffer = sine(1000.0, 0.5, 8192);
        os.process(&mut buffer, hard_drive);

        let fundamental = magnitude_at(&buffer[2048..], 1000.0, FS);
        let third = magnitude_at(&buffer[2048..], 3000.0, FS);
        assert!(third > fundamental * 0.05, "3차 하모닉이 없다: {third}");
    }

    /// **여유가 얼마나 있는지 숫자로 남긴다.** 기준(-60dB)을 통과하는 것과
    /// 최상급(-90dB)인 것은 다른 이야기다 — "상~최상" 을 말하려면 여유를 알아야 한다
    #[test]
    fn report_actual_aliasing_margin() {
        let mut os = Oversampler::new(FS);
        let mut buffer = sine(5000.0, 0.7, 16384);
        os.process(&mut buffer, hard_drive);
        let analyzed = &buffer[4096..];
        let fundamental = magnitude_at(analyzed, 5000.0, FS);
        let mut worst = -200.0_f64;
        for folded in [23000.0, 21000.0, 18000.0, 16000.0, 13000.0, 11000.0, 8000.0] {
            let db = 20.0 * (magnitude_at(analyzed, folded, FS) / fundamental).log10();
            println!("  {folded:7.0}Hz : {db:7.1} dB");
            worst = worst.max(db);
        }
        println!("오버샘플 최악 에일리어싱: {worst:.1} dB");
    }

    #[test]
    fn aliasing_is_below_60db() {
        // `sound.md` 11-2 의 기준: 하모닉 대비 에일리어싱 성분 -60dB 이하.
        //
        // 5kHz 를 강하게 왜곡하면 하모닉이 10·15·20·25·30kHz... 로 뻗는다.
        // 25kHz 성분은 48kHz 에서 접혀 23kHz 로, 30kHz 는 18kHz 로 나타난다.
        // 두 지점 모두 하모닉이 아닌 자리이므로 여기 에너지가 있으면 에일리어싱이다.
        let mut os = Oversampler::new(FS);
        let mut buffer = sine(5000.0, 0.7, 16384);
        os.process(&mut buffer, hard_drive);

        let analyzed = &buffer[4096..];
        let fundamental = magnitude_at(analyzed, 5000.0, FS);

        // 접혀 들어올 자리들 (5kHz 의 정수배가 아닌 지점)
        for folded in [23000.0, 18000.0, 13000.0, 8000.0] {
            let level = magnitude_at(analyzed, folded, FS);
            let db = 20.0 * (level / fundamental).log10();
            assert!(
                db < -60.0,
                "{folded}Hz 에 에일리어싱 {db:.1}dB (기준 -60dB)"
            );
        }
    }

    #[test]
    fn without_oversampling_aliasing_is_audible() {
        // 오버샘플링이 정말 필요한지 숫자로 남긴다. 같은 왜곡을 그냥 적용하면
        // 위 테스트의 자리에 에너지가 나타나야 한다
        let mut naive = sine(5000.0, 0.7, 16384);
        for sample in naive.iter_mut() {
            *sample = hard_drive(*sample as f64) as f32;
        }

        let analyzed = &naive[4096..];
        let fundamental = magnitude_at(analyzed, 5000.0, FS);
        let folded = magnitude_at(analyzed, 23000.0, FS);
        let db = 20.0 * (folded / fundamental).log10();
        assert!(
            db > -60.0,
            "오버샘플링 없이도 {db:.1}dB 라면 이 모듈의 근거를 다시 봐야 한다"
        );
    }

    #[test]
    fn is_stable_and_finite() {
        let mut os = Oversampler::new(FS);
        for amplitude in [0.0, 0.001, 1.0, 4.0] {
            let mut buffer = sine(440.0, amplitude, 2048);
            os.process(&mut buffer, hard_drive);
            assert!(
                buffer.iter().all(|v| v.is_finite()),
                "진폭 {amplitude} 에서 유한하지 않다"
            );
            assert!(
                buffer.iter().all(|v| v.abs() < 2.0),
                "진폭 {amplitude} 에서 발산했다"
            );
        }
    }

    #[test]
    fn reset_clears_state() {
        let mut os = Oversampler::new(FS);
        let mut loud = sine(200.0, 1.0, 512);
        os.process(&mut loud, hard_drive);
        os.reset();

        // 리셋 후 무음을 넣으면 무음이 나와야 한다 (필터에 잔향이 남지 않는다)
        let mut silence = vec![0.0f32; 512];
        os.process(&mut silence, |x| x);
        assert!(
            silence.iter().all(|v| v.abs() < 1e-9),
            "리셋 후에도 잔향이 남는다"
        );
    }

    #[test]
    fn processes_the_whole_buffer_however_long() {
        // 조용히 앞부분만 처리하면 뒤쪽이 왜곡 없이 지나간다. 처음 이 버그로
        // 테스트가 "하모닉이 없다"고 나왔다 — 처리 안 된 구간을 분석하고 있었다
        let mut os = Oversampler::new(FS);
        let n = MAX_FRAMES * 3 + 137;
        let mut buffer = sine(1000.0, 0.5, n);
        os.process(&mut buffer, hard_drive);

        // 버퍼 끝부분에도 왜곡이 걸려 있어야 한다
        let tail = &buffer[n - 4096..];
        let fundamental = magnitude_at(tail, 1000.0, FS);
        let third = magnitude_at(tail, 3000.0, FS);
        assert!(
            third > fundamental * 0.05,
            "끝부분에 왜곡이 걸리지 않았다: 3차 {third}, 기본음 {fundamental}"
        );
        assert!(buffer.iter().all(|v| v.is_finite()));
    }
}


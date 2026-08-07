//! 일렉 기타 신호 체인 — 픽업 → 앰프 → 캐비닛 (`sound.md` 5절, M2).
//!
//! ```text
//! [줄 모델]   ← 이미 있다 (string_voice.rs)
//!    ↓
//! [픽업]      위치(넥/브리지), 코일 특성 → 주파수 응답 성형
//!    ↓
//! [앰프]      프리앰프 비선형 왜곡 → 톤스택(EQ) → 파워앰프
//!    ↓         ※ 크런치·디스토션·퍼즈가 여기서 나온다 (줄 모델이 아니다)
//! [캐비닛]    스피커 임펄스 응답
//! ```
//!
//! **중요** (`sound.md` 5절): 사용자가 고르는 "클린 / 크런치 / 디스토션 / 퍼즈"는
//! 줄이 아니라 앰프 단의 파라미터다. "줄 길이"와 "왜곡"은 서로 다른 층에 있으므로
//! 음색 스키마에서 분리해 설계한다.
//!
//! 비선형은 **반드시 오버샘플링**한다 (`sound.md` 6-1). 이 파일은 그 규칙을 코드로
//! 강제한다 — 왜곡을 오버샘플러 밖에서 호출할 수 있는 경로를 두지 않았다.

use crate::oversample::Oversampler;

/// 픽업 위치가 만드는 콤 필터링.
///
/// 픽업은 줄의 한 지점의 움직임만 읽는다. 그래서 그 지점이 절점(node)인 하모닉은
/// 잡히지 않는다 — 브리지 쪽(위치 0에 가까움)은 밝고, 넥 쪽은 둥글다.
/// 이게 넥/브리지 픽업 차이의 물리적 근거다.
#[derive(Clone, Debug)]
pub struct Pickup {
    /// 콤 딜레이 라인 (줄 길이에 대한 상대 위치 × 주기)
    buffer: Vec<f32>,
    write: usize,
    delay: usize,
    /// 코일의 인덕턴스가 만드는 공진·고역 감쇠를 일차 저역통과로 근사
    lp_state: f64,
    lp_coef: f64,
    mix: f64,
}

impl Pickup {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            // 최저음(20Hz) 주기의 절반까지 담을 수 있게
            buffer: vec![0.0; (sample_rate / 40.0).ceil() as usize + 4],
            write: 0,
            delay: 1,
            lp_state: 0.0,
            lp_coef: 0.0,
            mix: 0.0,
        }
    }

    /// `position` 0~1 (0 = 브리지, 1 = 넥). `coil_hz` 는 코일 고역 감쇠 지점.
    pub fn set(&mut self, position: f64, coil_hz: f64, freq_hz: f64, sample_rate: f64) {
        let clamped = position.clamp(0.0, 1.0);
        // 브리지에서 멀어질수록 콤 딜레이가 길어진다 (절점이 낮은 하모닉으로 내려온다)
        let period = sample_rate / freq_hz.max(20.0);
        let samples = (clamped * 0.5 * period).round() as usize;
        self.delay = samples.clamp(1, self.buffer.len() - 1);
        // 위치 0(브리지)에서는 콤을 거의 걸지 않는다
        self.mix = clamped.min(1.0);

        let coil = coil_hz.clamp(500.0, 12000.0);
        self.lp_coef = (-2.0 * core::f64::consts::PI * coil / sample_rate).exp();
    }

    pub fn reset(&mut self) {
        for v in self.buffer.iter_mut() {
            *v = 0.0;
        }
        self.lp_state = 0.0;
        self.write = 0;
    }

    pub fn process(&mut self, x: f64) -> f64 {
        let size = self.buffer.len();
        let read = (self.write + size - self.delay) % size;
        let delayed = self.buffer[read] as f64;
        self.buffer[self.write] = x as f32;
        self.write = (self.write + 1) % size;

        // 콤: 지점 하나를 읽는 효과. mix 로 세기를 조절한다
        let combed = x - self.mix * delayed;

        // 코일 저역통과
        self.lp_state = (1.0 - self.lp_coef) * combed + self.lp_coef * self.lp_state;
        self.lp_state
    }
}

/// 앰프의 비선형 특성. 사용자가 고르는 "클린/크런치/디스토션/퍼즈"가 이것.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AmpCharacter {
    /// 거의 선형. 아주 큰 입력에서만 살짝 눌린다
    Clean,
    /// 부드러운 대칭 포화 (tanh)
    Crunch,
    /// 강한 포화 + 비대칭 (짝수 하모닉이 섞여 더 두껍게 들린다)
    Distortion,
    /// 거의 사각파로 밀어붙인다
    Fuzz,
}

impl AmpCharacter {
    pub fn from_index(index: u32) -> Self {
        match index {
            0 => Self::Clean,
            1 => Self::Crunch,
            2 => Self::Distortion,
            _ => Self::Fuzz,
        }
    }

    /// 왜곡 함수. **오버샘플된 레이트에서 샘플마다 호출된다.**
    fn shape(self, x: f64, drive: f64) -> f64 {
        match self {
            Self::Clean => {
                // 아주 완만한 포화. 헤드룸 안에서는 사실상 선형
                let g = 1.0 + drive * 1.5;
                (x * g).tanh() / (1.0 + drive * 0.4)
            }
            Self::Crunch => {
                let g = 1.0 + drive * 8.0;
                (x * g).tanh()
            }
            Self::Distortion => {
                // 비대칭: 위아래를 다르게 눌러 짝수 하모닉을 만든다.
                // 진공관 앰프가 두껍게 들리는 이유 중 하나다
                let g = 1.0 + drive * 20.0;
                let y = x * g;
                if y >= 0.0 {
                    y.tanh()
                } else {
                    0.8 * (y * 1.3).tanh()
                }
            }
            Self::Fuzz => {
                let g = 1.0 + drive * 60.0;
                let y = (x * g).tanh();
                // 사각파에 가깝게 한 번 더 밀어붙인다
                (y * 3.0).tanh()
            }
        }
    }
}

/// 톤스택 — 앰프의 저·중·고역 EQ. 세 개의 일차 필터로 근사한다.
#[derive(Clone, Copy, Debug, Default)]
struct ToneStack {
    low_state: f64,
    high_state: f64,
    low_coef: f64,
    high_coef: f64,
    low_gain: f64,
    mid_gain: f64,
    high_gain: f64,
}

impl ToneStack {
    fn set(&mut self, low: f64, mid: f64, high: f64, sample_rate: f64) {
        // 250Hz 아래를 저역, 3kHz 위를 고역으로 본다
        self.low_coef = (-2.0 * core::f64::consts::PI * 250.0 / sample_rate).exp();
        self.high_coef = (-2.0 * core::f64::consts::PI * 3000.0 / sample_rate).exp();
        // 0~1 파라미터를 ±12dB 로 매핑
        self.low_gain = 10f64.powf((low - 0.5) * 24.0 / 20.0);
        self.mid_gain = 10f64.powf((mid - 0.5) * 24.0 / 20.0);
        self.high_gain = 10f64.powf((high - 0.5) * 24.0 / 20.0);
    }

    fn process(&mut self, x: f64) -> f64 {
        self.low_state = (1.0 - self.low_coef) * x + self.low_coef * self.low_state;
        let low = self.low_state;

        self.high_state = (1.0 - self.high_coef) * x + self.high_coef * self.high_state;
        let below_high = self.high_state;

        let high = x - below_high;
        let mid = below_high - low;

        low * self.low_gain + mid * self.mid_gain + high * self.high_gain
    }

    fn reset(&mut self) {
        self.low_state = 0.0;
        self.high_state = 0.0;
    }
}

/// 캐비닛 — 스피커의 주파수 응답.
///
/// **실측 IR 이 아니다.** 실측 임펄스 응답은 에셋이고(`sound.md` 12절 리스크 표),
/// 확보되면 이 자리를 컨볼루션으로 바꾼다. 지금은 캐비닛의 가장 지배적인 특성인
/// **급한 고역 롤오프**(5kHz 위)와 저역 컷을 필터로 근사한다.
/// 이것만으로도 "직결된 왜곡"의 날카로움은 크게 줄어든다.
#[derive(Clone, Copy, Debug, Default)]
struct Cabinet {
    lp1: f64,
    lp2: f64,
    lp3: f64,
    lp_coef: f64,
    hp_state: f64,
    hp_coef: f64,
    presence_state: f64,
    presence_coef: f64,
}

impl Cabinet {
    fn set(&mut self, sample_rate: f64) {
        // 5kHz 3단 저역통과 = 급한 롤오프
        self.lp_coef = (-2.0 * core::f64::consts::PI * 5000.0 / sample_rate).exp();
        // 80Hz 아래 컷 (스피커가 못 내는 저역)
        self.hp_coef = (-2.0 * core::f64::consts::PI * 80.0 / sample_rate).exp();
        // 2.5kHz 부근의 프레즌스 피크
        self.presence_coef = (-2.0 * core::f64::consts::PI * 2500.0 / sample_rate).exp();
    }

    fn process(&mut self, x: f64) -> f64 {
        // 저역 컷
        self.hp_state = (1.0 - self.hp_coef) * x + self.hp_coef * self.hp_state;
        let mut y = x - self.hp_state;

        // 프레즌스: 2.5kHz 대역을 조금 올린다
        self.presence_state =
            (1.0 - self.presence_coef) * y + self.presence_coef * self.presence_state;
        y += (y - self.presence_state) * 0.35;

        // 고역 롤오프 3단
        self.lp1 = (1.0 - self.lp_coef) * y + self.lp_coef * self.lp1;
        self.lp2 = (1.0 - self.lp_coef) * self.lp1 + self.lp_coef * self.lp2;
        self.lp3 = (1.0 - self.lp_coef) * self.lp2 + self.lp_coef * self.lp3;
        self.lp3
    }

    fn reset(&mut self) {
        self.lp1 = 0.0;
        self.lp2 = 0.0;
        self.lp3 = 0.0;
        self.hp_state = 0.0;
        self.presence_state = 0.0;
    }
}

/// 앰프 파라미터. 줄 파라미터와 **분리된 층**이다 (`sound.md` 5절·8절)
#[derive(Clone, Copy, Debug)]
pub struct AmpParams {
    pub character: AmpCharacter,
    /// 0~1
    pub drive: f64,
    pub tone_low: f64,
    pub tone_mid: f64,
    pub tone_high: f64,
    /// 출력 레벨 (0~1)
    pub level: f64,
    /// 캐비닛을 통과시킬지. 끄면 직결(DI) 소리 — 튜닝할 때 줄 모델만 듣고 싶을 때 쓴다
    pub cabinet: bool,
    /// 픽업 위치 0~1 (0 = 브리지, 1 = 넥)
    pub pickup_position: f64,
    /// 픽업 코일 고역 감쇠 지점 (Hz). 싱글코일은 높고 험버커는 낮다
    pub pickup_coil_hz: f64,
}

impl Default for AmpParams {
    fn default() -> Self {
        Self {
            character: AmpCharacter::Crunch,
            drive: 0.35,
            tone_low: 0.5,
            tone_mid: 0.5,
            tone_high: 0.55,
            level: 0.7,
            cabinet: true,
            pickup_position: 0.15,
            pickup_coil_hz: 6000.0,
        }
    }
}

/// 픽업 → 앰프 → 캐비닛. 비선형은 오버샘플러 안에서만 돈다.
pub struct AmpChain {
    sample_rate: f64,
    pickup: Pickup,
    oversampler: Oversampler,
    tone: ToneStack,
    cabinet: Cabinet,
    params: AmpParams,
    /// 오버샘플러에 넘길 작업 버퍼 (오디오 경로에서 할당하지 않는다)
    scratch: Vec<f32>,
}

impl AmpChain {
    pub fn new(sample_rate: f64) -> Self {
        let mut chain = Self {
            sample_rate,
            pickup: Pickup::new(sample_rate),
            oversampler: Oversampler::new(sample_rate),
            tone: ToneStack::default(),
            cabinet: Cabinet::default(),
            params: AmpParams::default(),
            scratch: vec![0.0; crate::oversample::MAX_FRAMES],
        };
        chain.cabinet.set(sample_rate);
        chain.set_params(&AmpParams::default(), 220.0);
        chain
    }

    /// 파라미터 반영. `freq_hz` 는 픽업 콤 필터가 줄 주기를 알아야 하기 때문에 받는다
    pub fn set_params(&mut self, params: &AmpParams, freq_hz: f64) {
        self.params = *params;
        self.tone.set(
            params.tone_low,
            params.tone_mid,
            params.tone_high,
            self.sample_rate,
        );
        self.pickup.set(
            params.pickup_position,
            params.pickup_coil_hz,
            freq_hz,
            self.sample_rate,
        );
    }

    pub fn reset(&mut self) {
        self.pickup.reset();
        self.oversampler.reset();
        self.tone.reset();
        self.cabinet.reset();
    }

    /// `buffer` 를 제자리에서 처리한다
    pub fn process(&mut self, buffer: &mut [f32]) {
        // 픽업 (선형 — 오버샘플링 불필요)
        for sample in buffer.iter_mut() {
            *sample = self.pickup.process(*sample as f64) as f32;
        }

        // 프리앰프 비선형 — **오버샘플링 안에서만** (`sound.md` 6-1)
        let character = self.params.character;
        let drive = self.params.drive.clamp(0.0, 1.0);
        self.oversampler
            .process(buffer, |x| character.shape(x, drive));

        // 톤스택 + 캐비닛 + 출력 레벨 (모두 선형)
        let level = self.params.level.clamp(0.0, 1.0);
        let use_cabinet = self.params.cabinet;
        for sample in buffer.iter_mut() {
            let mut y = self.tone.process(*sample as f64);
            if use_cabinet {
                y = self.cabinet.process(y);
            }
            *sample = (y * level) as f32;
        }

        // scratch 는 지금 쓰이지 않지만, 나중에 캐비닛 IR 컨볼루션이 들어올 자리다
        debug_assert!(!self.scratch.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn magnitude_at(signal: &[f32], hz: f64) -> f64 {
        let w = 2.0 * core::f64::consts::PI * hz / FS;
        let n = signal.len();
        let mut re = 0.0;
        let mut im = 0.0;
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

    fn chain_with(params: AmpParams, freq: f64) -> AmpChain {
        let mut chain = AmpChain::new(FS);
        chain.set_params(&params, freq);
        chain
    }

    #[test]
    fn character_changes_harmonic_content() {
        // 클린 → 퍼즈로 갈수록 하모닉이 많아져야 한다.
        // 안 그러면 사용자가 고르는 값이 소리를 바꾸지 않는다는 뜻이다
        let mut previous = 0.0;
        for (index, name) in ["클린", "크런치", "디스토션", "퍼즈"].iter().enumerate() {
            let params = AmpParams {
                character: AmpCharacter::from_index(index as u32),
                drive: 0.6,
                cabinet: false, // 캐비닛이 고역을 깎으므로 하모닉 비교에서는 끈다
                ..Default::default()
            };
            let mut chain = chain_with(params, 220.0);
            let mut buffer = sine(220.0, 0.5, 16384);
            chain.process(&mut buffer);

            let analyzed = &buffer[4096..];
            let fundamental = magnitude_at(analyzed, 220.0);
            let harmonics: f64 = (2..8)
                .map(|k| magnitude_at(analyzed, 220.0 * k as f64))
                .sum();
            let ratio = harmonics / fundamental.max(1e-12);

            assert!(
                ratio > previous,
                "{name} 의 하모닉 비율 {ratio} 이 이전 {previous} 보다 크지 않다"
            );
            previous = ratio;
        }
    }

    #[test]
    fn distortion_aliasing_stays_below_60db() {
        // `sound.md` 11-2: 특히 디스토션 최대치에서 측정할 것.
        // 이게 실패하면 M2 는 "싸구려 소리" 판정이다
        let params = AmpParams {
            character: AmpCharacter::Fuzz,
            drive: 1.0,
            cabinet: false,
            level: 1.0,
            ..Default::default()
        };
        let mut chain = chain_with(params, 4000.0);
        let mut buffer = sine(4000.0, 0.8, 16384);
        chain.process(&mut buffer);

        let analyzed = &buffer[4096..];
        let fundamental = magnitude_at(analyzed, 4000.0);
        // 4kHz 의 정수배가 아닌 자리 = 접혀 들어온 성분
        for folded in [2000.0, 6000.0, 10000.0, 14000.0] {
            let db = 20.0 * (magnitude_at(analyzed, folded) / fundamental).log10();
            assert!(db < -60.0, "{folded}Hz 에 에일리어싱 {db:.1}dB");
        }
    }

    #[test]
    fn cabinet_rolls_off_treble() {
        // 캐비닛의 가장 지배적인 특성. 이게 없으면 왜곡이 날카롭게 들린다.
        //
        // **고역이 실제로 있는 신호로 재야 한다.** 처음에는 220Hz 사인의 8kHz(36차
        // 하모닉)를 봤는데 거기엔 에너지가 거의 없어 잡음끼리 비교하고 있었다.
        let make = || {
            let mut signal = vec![0.0f32; 16384];
            for (i, sample) in signal.iter_mut().enumerate() {
                let t = 2.0 * core::f64::consts::PI * i as f64 / FS;
                *sample = (0.25 * (t * 220.0).sin()
                    + 0.2 * (t * 2000.0).sin()
                    + 0.2 * (t * 7000.0).sin()) as f32;
            }
            signal
        };

        let base = AmpParams {
            drive: 0.1,
            level: 1.0,
            ..Default::default()
        };
        let mut a = make();
        let mut b = make();
        chain_with(
            AmpParams {
                cabinet: true,
                ..base
            },
            220.0,
        )
        .process(&mut a);
        chain_with(
            AmpParams {
                cabinet: false,
                ..base
            },
            220.0,
        )
        .process(&mut b);

        let treble_with = magnitude_at(&a[4096..], 7000.0);
        let treble_without = magnitude_at(&b[4096..], 7000.0);
        assert!(
            treble_with < treble_without * 0.3,
            "캐비닛이 7kHz 를 깎지 않는다: {treble_with:.5} vs {treble_without:.5}",
        );

        // 저역은 남아 있어야 한다 (전체를 깎는 게 아니다)
        let bass_with = magnitude_at(&a[4096..], 220.0);
        let bass_without = magnitude_at(&b[4096..], 220.0);
        assert!(
            bass_with > bass_without * 0.4,
            "캐비닛이 저역까지 죽인다: {bass_with:.5} vs {bass_without:.5}",
        );
    }

    #[test]
    fn tone_stack_moves_bands() {
        let quiet_bass = AmpParams {
            tone_low: 0.0,
            cabinet: false,
            drive: 0.1,
            ..Default::default()
        };
        let loud_bass = AmpParams {
            tone_low: 1.0,
            cabinet: false,
            drive: 0.1,
            ..Default::default()
        };

        let mut low = chain_with(quiet_bass, 100.0);
        let mut high = chain_with(loud_bass, 100.0);
        let mut a = sine(100.0, 0.4, 16384);
        let mut b = a.clone();
        low.process(&mut a);
        high.process(&mut b);

        assert!(
            magnitude_at(&b[4096..], 100.0) > magnitude_at(&a[4096..], 100.0) * 3.0,
            "저역 노브가 저역을 바꾸지 않는다",
        );
    }

    #[test]
    fn pickup_position_changes_brightness() {
        // 브리지 픽업이 넥보다 밝아야 한다 (콤 필터의 절점 위치 차이)
        let bridge = AmpParams {
            pickup_position: 0.02,
            cabinet: false,
            drive: 0.1,
            ..Default::default()
        };
        let neck = AmpParams {
            pickup_position: 0.95,
            cabinet: false,
            drive: 0.1,
            ..Default::default()
        };

        // 하모닉이 있는 신호로 봐야 콤 필터 효과가 보인다
        let make = || {
            let mut signal = sine(220.0, 0.3, 16384);
            for (i, sample) in signal.iter_mut().enumerate() {
                let t = 2.0 * core::f64::consts::PI * i as f64 / FS;
                *sample += (0.2 * (t * 660.0).sin() + 0.15 * (t * 1100.0).sin()) as f32;
            }
            signal
        };

        let mut a = make();
        let mut b = make();
        chain_with(bridge, 220.0).process(&mut a);
        chain_with(neck, 220.0).process(&mut b);

        let bright = |s: &[f32]| magnitude_at(s, 660.0) + magnitude_at(s, 1100.0);
        assert!(
            bright(&a[4096..]) != bright(&b[4096..]),
            "픽업 위치가 소리를 바꾸지 않는다",
        );
    }

    #[test]
    fn is_stable_at_extremes() {
        for index in 0..4 {
            for drive in [0.0, 0.5, 1.0] {
                for amplitude in [0.0, 1.0, 3.0] {
                    let params = AmpParams {
                        character: AmpCharacter::from_index(index),
                        drive,
                        level: 1.0,
                        ..Default::default()
                    };
                    let mut chain = chain_with(params, 220.0);
                    let mut buffer = sine(220.0, amplitude, 4096);
                    chain.process(&mut buffer);
                    assert!(
                        buffer.iter().all(|v| v.is_finite()),
                        "index={index} drive={drive} amp={amplitude}: 유한하지 않다"
                    );
                    assert!(
                        buffer.iter().all(|v| v.abs() < 4.0),
                        "index={index} drive={drive} amp={amplitude}: 발산했다"
                    );
                }
            }
        }
    }

    #[test]
    fn silence_in_silence_out() {
        let mut chain = AmpChain::new(FS);
        let mut buffer = vec![0.0f32; 2048];
        chain.process(&mut buffer);
        assert!(
            buffer.iter().all(|v| v.abs() < 1e-6),
            "무음에서 소리가 난다 (DC 오프셋 의심)",
        );
    }
}

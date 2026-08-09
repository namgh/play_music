//! 공명현 (`ROADMAP.md` S2-5).
//!
//! 기타를 칠 때 누르지 않은 줄들이 같이 운다. 피아노는 댐퍼를 뗀 현 전체가 운다.
//! 이 울림이 "몸통이 있는 악기"라는 인상의 큰 부분인데, 지금까지 우리 소리에는
//! 연주한 줄 하나만 있었다.
//!
//! **물리로 다 풀지 않는다.** 실제 공명현은 브리지를 통해 양방향으로 결합하지만,
//! 그걸 제대로 풀면 줄 개수의 제곱만큼 비싸진다. 여기서는 **한 방향 결합**만 쓴다 —
//! 연주한 소리를 공명체에 넣고 그 울림을 되돌려 섞는다. 귀로는 거의 같고 CPU 는
//! 딜레이 라인 몇 개 값이다 (`sound.md` 의 "바디는 IR 로 대체"와 같은 판단).
//!
//! 보이스 안이 아니라 **보이스 합**에 건다. 실제로도 공명은 한 줄이 아니라 악기
//! 전체에서 일어나고, 그래야 여러 음이 함께 울릴 때 서로를 울린다.

/// 공명 줄의 개수와 음정 (반음). 기타 표준 조율 EADGBE 의 간격이다.
///
/// 악기마다 실제 조율은 다르지만, 이 간격은 4도 중심이라 12평균율 어디에 놓아도
/// 배음이 잘 걸린다. 하프·피아노처럼 줄이 훨씬 많은 악기도 **들리는 결과는
/// "관련된 음정들이 함께 운다"** 이므로 여섯 개로 충분하다.
const STRING_SEMITONES: [f64; 6] = [0.0, 5.0, 10.0, 15.0, 19.0, 24.0];

/// 공명 줄의 감쇠 시간. 실제 개방현은 꽤 오래 운다
const RESONANCE_T60_SEC: f64 = 2.2;

/// 공명현 하나 — 딜레이 라인 + 저역통과 되먹임.
struct Resonator {
    buffer: Vec<f32>,
    write: usize,
    delay: usize,
    gain: f64,
    lp_state: f64,
    lp_coef: f64,
}

impl Resonator {
    fn new(max_delay: usize) -> Self {
        Self {
            buffer: vec![0.0; max_delay.max(2)],
            write: 0,
            delay: 1,
            gain: 0.0,
            lp_state: 0.0,
            lp_coef: 0.5,
        }
    }

    fn tune(&mut self, freq_hz: f64, sample_rate: f64) {
        let period = sample_rate / freq_hz.max(20.0);
        self.delay = (period.round() as usize).clamp(1, self.buffer.len() - 1);

        // T60 에서 -60dB 가 되도록 되먹임 이득을 잡는다.
        // **전체 주기 기준**이다 — 딜레이 길이로 잡으면 필터가 먹은 만큼 덜 감쇠한다
        // (`HANDOFF.md` 4번)
        let loops = (RESONANCE_T60_SEC * sample_rate) / period;
        self.gain = 10f64.powf(-3.0 / loops).min(0.999);
        // 고역은 빨리 죽는다 — 공명은 둔한 소리다
        self.lp_coef = 0.45;
    }

    fn reset(&mut self) {
        for v in self.buffer.iter_mut() {
            *v = 0.0;
        }
        self.write = 0;
        self.lp_state = 0.0;
    }

    /// 한 샘플을 넣고 울림을 돌려준다
    fn process(&mut self, input: f64) -> f64 {
        let size = self.buffer.len();
        let read = (self.write + size - self.delay) % size;
        let delayed = self.buffer[read] as f64;

        let lp = (1.0 - self.lp_coef) * delayed + self.lp_coef * self.lp_state;
        self.lp_state = lp;

        self.buffer[self.write] = (input + lp * self.gain) as f32;
        self.write += 1;
        if self.write == size {
            self.write = 0;
        }
        delayed
    }
}

/// 공명현 다발. 트랙 하나에 하나씩 둔다 (앰프와 같은 층이다).
pub struct SympatheticStrings {
    sample_rate: f64,
    strings: Vec<Resonator>,
    amount: f64,
    base_hz: f64,
}

impl SympatheticStrings {
    pub fn new(sample_rate: f64) -> Self {
        // 가장 낮은 공명현이 20Hz 여도 담기게
        let max_delay = (sample_rate / 20.0).ceil() as usize + 4;
        let mut this = Self {
            sample_rate,
            strings: (0..STRING_SEMITONES.len())
                .map(|_| Resonator::new(max_delay))
                .collect(),
            amount: 0.0,
            base_hz: 0.0,
        };
        this.set(0.0, 82.41);
        this
    }

    /// `amount` 가 0 이면 완전히 꺼진다 (소리도 CPU 도 예전 그대로).
    /// `base_hz` 는 가장 낮은 공명현의 음정이다.
    pub fn set(&mut self, amount: f64, base_hz: f64) {
        self.amount = amount.clamp(0.0, 1.0);
        let base = if base_hz > 0.0 { base_hz } else { 82.41 };
        if (base - self.base_hz).abs() < 1e-6 {
            return;
        }
        self.base_hz = base;
        for (string, semitone) in self.strings.iter_mut().zip(STRING_SEMITONES.iter()) {
            string.tune(base * (semitone / 12.0).exp2(), self.sample_rate);
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.amount > 0.0
    }

    pub fn reset(&mut self) {
        for string in self.strings.iter_mut() {
            string.reset();
        }
    }

    /// `buffer` 를 제자리에서 처리한다. 원음은 그대로 두고 울림을 **더한다**
    pub fn process(&mut self, buffer: &mut [f32]) {
        if !self.is_enabled() {
            return;
        }
        // 줄 여섯 개가 각자 받아 울린다. 넣는 양을 나눠 두지 않으면 줄 수만큼 커진다
        let drive = self.amount / STRING_SEMITONES.len() as f64;
        for sample in buffer.iter_mut() {
            let input = *sample as f64;
            let mut sum = 0.0;
            for string in self.strings.iter_mut() {
                sum += string.process(input * drive);
            }
            *sample = (input + sum) as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn impulse(n: usize) -> Vec<f32> {
        let mut x = vec![0.0f32; n];
        x[0] = 1.0;
        x
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }

    #[test]
    fn disabled_leaves_the_signal_untouched() {
        // 켜지 않은 악기는 예전과 **완전히** 같은 소리여야 한다
        let mut s = SympatheticStrings::new(FS);
        s.set(0.0, 82.41);
        let mut x = impulse(1000);
        let before = x.clone();
        s.process(&mut x);
        assert_eq!(x, before);
    }

    #[test]
    fn rings_after_the_input_stops() {
        // 공명은 원음이 끝난 뒤에도 남아야 한다. 그게 이 기능의 전부다
        let mut s = SympatheticStrings::new(FS);
        s.set(0.5, 82.41);
        let mut x = impulse(20000);
        s.process(&mut x);
        let tail = rms(&x[10000..]);
        assert!(tail > 1e-5, "임펄스 뒤에 울림이 남지 않는다: {tail:e}");
    }

    #[test]
    fn ringing_decays_and_does_not_blow_up() {
        // 되먹임이 1 을 넘으면 발산한다 — 그러면 그 시점부터 트랙 전체가 망가진다
        let mut s = SympatheticStrings::new(FS);
        s.set(1.0, 82.41);
        let mut x = impulse((FS * 6.0) as usize);
        s.process(&mut x);
        assert!(x.iter().all(|v| v.is_finite()), "발산했다");

        let early = rms(&x[..(FS * 0.5) as usize]);
        let late = rms(&x[(FS * 5.0) as usize..]);
        assert!(late < early * 0.2, "감쇠하지 않는다: {early:e} → {late:e}");
    }

    #[test]
    fn resonates_more_at_the_tuned_pitches() {
        // 공명현에 맞는 음정을 넣으면 아닌 음정보다 크게 울려야 한다.
        // 안 그러면 그냥 리버브를 하나 더 건 것과 같다
        let tone = |hz: f64| {
            let n = (FS * 1.0) as usize;
            let mut x = vec![0.0f32; n];
            // 앞 0.3초만 울리고 끊는다 — 꼬리를 봐야 공명이 보인다
            for (i, v) in x.iter_mut().enumerate() {
                if (i as f64) < FS * 0.3 {
                    *v = (0.3 * (2.0 * core::f64::consts::PI * hz * i as f64 / FS).sin()) as f32;
                }
            }
            let mut s = SympatheticStrings::new(FS);
            s.set(0.8, 82.41);
            s.process(&mut x);
            rms(&x[(FS * 0.45) as usize..])
        };

        // 110Hz = A2 = 기준(82.41Hz)에서 5반음 위 → 공명현이 있다
        let on_pitch = tone(110.0);
        // 그 사이 (반음의 절반쯤) → 공명현이 없다
        let off_pitch = tone(116.0);
        assert!(
            on_pitch > off_pitch * 1.5,
            "맞는 음정이 더 울리지 않는다: {on_pitch:e} vs {off_pitch:e}"
        );
    }
}

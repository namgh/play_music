//! 피치 시프터 (시간 영역, 두 머리 교차) — 딜레이를 다른 속도로 읽으면 음정이 바뀐다.
//! 읽는 머리 둘을 반 창씩 엇갈리게 두고 한 머리가 창 끝에 닿을 때 다른 머리로 사인 제곱 교차.
//! 창이 길면 매끄럽고(지연↑), 짧으면 빠르다. 쉬머·하모나이저·옥타버·보컬 트랜스포머가 쓴다.

use super::delay::DelayLine;

pub struct PitchShifter {
    line: DelayLine,
    window: f32,
    phase: f32,
    ratio: f32,
}

impl PitchShifter {
    pub fn new(sample_rate: f32, window_ms: f32) -> Self {
        let window = (window_ms * 0.001 * sample_rate).max(64.0);
        Self {
            line: DelayLine::new(window as usize * 2 + 64),
            window,
            phase: 0.0,
            ratio: 1.0,
        }
    }

    pub fn set_window(&mut self, window_ms: f32, sample_rate: f32) {
        self.window =
            (window_ms * 0.001 * sample_rate).clamp(64.0, self.line.capacity() as f32 / 2.0 - 8.0);
    }

    /// 반음
    pub fn set_semitones(&mut self, semis: f32) {
        self.ratio = 2f32.powf(semis / 12.0);
    }

    pub fn set_ratio(&mut self, ratio: f32) {
        self.ratio = ratio.clamp(0.25, 4.0);
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        self.line.push(x);
        // 머리의 지연은 (1 − 비율) 만큼씩 변한다: 비율 > 1 이면 지연이 줄며 따라잡는다
        self.phase += (1.0 - self.ratio) / self.window;
        self.phase = self.phase.rem_euclid(1.0);
        let p2 = (self.phase + 0.5).fract();
        let d1 = 1.0 + self.phase * self.window;
        let d2 = 1.0 + p2 * self.window;
        // 지연이 창의 가장자리일 때 그 머리의 크기가 0 (사인 제곱 = 두 머리 합이 1)
        let w1 = (std::f32::consts::PI * self.phase).sin().powi(2);
        let w2 = 1.0 - w1;
        self.line.read(d1) * w1 + self.line.read(d2) * w2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn octave_up_doubles_frequency() {
        let sr = 48000.0;
        let mut p = PitchShifter::new(sr, 40.0);
        p.set_semitones(12.0);
        let f = 220.0;
        let y: Vec<f32> = (0..48000)
            .map(|n| p.tick((std::f32::consts::TAU * f * n as f32 / sr).sin()))
            .collect();
        // 알갱이마다 위상이 달라 긴 창의 푸리에 합은 상쇄된다 — 영점 교차로 음정을 잰다
        let mut zc = 0;
        for i in 24001..48000 {
            if y[i - 1] < 0.0 && y[i] >= 0.0 {
                zc += 1;
            }
        }
        let hz = zc as f32 * 2.0;
        assert!((hz - 440.0).abs() < 30.0, "한 옥타브 위 {hz}Hz");
    }
}

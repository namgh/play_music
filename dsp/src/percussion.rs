//! 합성 드럼 — 킥·스네어·하이햇·탐·클랩.
//!
//! # 왜 샘플이 아닌가
//!
//! `sound.md` 3절은 드럼을 Tier 4(샘플)로 둔다. 어쿠스틱 드럼은 샘플이 품질·비용
//! 모두 우세하고 그 판단은 지금도 맞다. **하지만 그 샘플이 없다** — 녹음이나
//! 라이선스가 필요하고 코드로 만들 수 있는 것이 아니다.
//!
//! 드럼이 아예 없으면 `plan.md` 5-1 의 Phase 1 완료 조건("AI 없이 곡 하나를 끝내고
//! 내보낼 수 있다")이 성립하지 않는다. 리듬 없이 곡을 끝낼 수는 없다.
//!
//! 그래서 **합성 드럼**을 넣는다. 이건 어쿠스틱 드럼을 흉내 내려는 것이 아니라
//! 전자 드럼이라는 **별개의 실재하는 악기**다 (TR-808 계열이 그 자체로 하나의 음색인
//! 것처럼). 어쿠스틱 드럼 샘플은 에셋이 확보되면 샘플러 보이스로 따로 들어온다.
//!
//! 합성으로 만드는 이상 이 소리는 "드럼 흉내"가 아니라 그 자체로 판단받아야 한다.

use crate::denormal::flush;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrumKind {
    Kick,
    Snare,
    HiHatClosed,
    HiHatOpen,
    Tom,
    Clap,
}

impl DrumKind {
    pub fn from_index(index: u32) -> Self {
        match index {
            0 => Self::Kick,
            1 => Self::Snare,
            2 => Self::HiHatClosed,
            3 => Self::HiHatOpen,
            4 => Self::Tom,
            _ => Self::Clap,
        }
    }

    /// 음정을 따라가는가. 킥·탐은 음정이 있고 하이햇·클랩은 없다
    fn is_pitched(self) -> bool {
        matches!(self, Self::Kick | Self::Tom)
    }
}

/// 이상적인 원형 막의 모드 비율 (베셀 함수 영점). **정수배가 아니다** —
/// 그래서 북은 음정이 뚜렷하지 않고 "퉁" 하고 울린다
const MEMBRANE_RATIOS: [f64; MAX_MODES] = [1.0, 1.594, 2.136, 2.296, 2.918, 3.501];

/// 금속판(심벌·하이햇)의 모드. 막보다 훨씬 촘촘하고 불규칙하다
const METAL_RATIOS: [f64; MAX_MODES] = [1.0, 1.41, 1.93, 2.51, 3.17, 4.07];

pub const MAX_MODES: usize = 6;

/// 막 진동 모드 하나. 사인 하나가 아니라 이것들이 겹쳐야 북 소리가 된다.
///
/// **예전에는 사인 하나뿐이었다.** 그래서 킥(원래 사인에 가깝다)은 그럴듯했지만
/// 스네어·탐은 "삐" 소리에 노이즈를 얹은 것처럼 들렸다 — 실제 막은 여러 모드가
/// 동시에 울리고 각자 다른 속도로 죽는다.
#[derive(Clone, Copy, Debug, Default)]
struct Mode {
    phase: f64,
    ratio: f64,
    gain: f64,
    env: f64,
    decay: f64,
}

/// 결정론적 노이즈. 오디오 스레드에서 OS 난수를 부를 수 없다
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.0 as f64 / 4294967296.0) * 2.0 - 1.0
    }
}

/// 2극 대역통과 — 노이즈에서 특정 대역만 뽑는다
#[derive(Clone, Copy, Debug, Default)]
struct BandPass {
    low: f64,
    band: f64,
    f: f64,
    q: f64,
}

impl BandPass {
    fn set(&mut self, hz: f64, resonance: f64, sample_rate: f64) {
        let cutoff = hz.clamp(20.0, sample_rate * 0.45);
        self.f = 2.0 * (core::f64::consts::PI * cutoff / sample_rate).sin();
        self.f = self.f.clamp(0.0, 1.2);
        self.q = (1.0 - resonance.clamp(0.0, 0.95)).max(0.05);
    }

    fn process(&mut self, x: f64) -> f64 {
        let high = x - self.low - self.q * self.band;
        self.band = flush(self.band + self.f * high);
        self.low = flush(self.low + self.f * self.band);
        // **`q` 를 곱해 정규화한다.** 대역통과의 공진점 이득은 Q 에 비례하므로
        // 그냥 두면 공진을 세울수록 소리가 커진다 — 하이햇이 **한 번만 쳐도**
        // +2.4dBFS 로 잘렸다 (`body.rs` 에서 이미 밟은 것과 같은 함정)
        self.band * self.q
    }

    fn reset(&mut self) {
        self.low = 0.0;
        self.band = 0.0;
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DrumParams {
    pub kind: DrumKind,
    /// 몸통의 감쇠 시간 (초)
    pub decay_sec: f64,
    /// 음정 스윕 깊이 — 킥의 "둥" 소리를 만드는 것
    pub pitch_drop: f64,
    /// 노이즈 성분의 양 (0~1). 스네어의 "샤" 소리
    pub noise_amount: f64,
    /// 밝기 (노이즈 대역의 중심)
    pub tone: f64,
    /// 막 모드 개수 (1~6). 1 이면 예전과 같은 사인 하나다
    pub mode_count: usize,
    /// 0 이면 배음이 정수배(음정이 뚜렷), 1 이면 이상적인 막(퉁 소리)
    pub inharmonicity: f64,
    /// 스네어 줄의 달그락거림 (0~1)
    pub snare_wires: f64,
}

impl Default for DrumParams {
    fn default() -> Self {
        Self {
            kind: DrumKind::Kick,
            decay_sec: 0.35,
            pitch_drop: 0.7,
            noise_amount: 0.0,
            tone: 0.5,
            // 기본은 **모드 하나** — 예전과 완전히 같은 소리다.
            // 악기가 켜야 막 진동이 생긴다
            mode_count: 1,
            inharmonicity: 0.0,
            snare_wires: 0.0,
        }
    }
}

pub struct DrumVoice {
    sample_rate: f64,
    kind: DrumKind,
    /// 막 진동 모드. `[0]` 이 기본 모드다
    modes: [Mode; MAX_MODES],
    mode_count: usize,
    /// 스네어 줄 — 막이 울리는 동안 달그락거린다
    wires: f64,
    wire_env: f64,

    /// 몸통 사인의 위상
    phase: f64,
    base_hz: f64,
    /// 음정 스윕의 현재 배율 (1 로 수렴한다)
    sweep: f64,
    sweep_decay: f64,

    body_env: f64,
    body_decay: f64,
    noise_env: f64,
    noise_decay: f64,
    noise_amount: f64,

    noise: Noise,
    /// **DC 차단.** 피치 스윕과 비대칭 노이즈 버스트는 DC 를 남긴다 —
    /// 안 들리지만 헤드룸을 먹고, 드럼은 트랙에서 가장 크게 치는 소리라 그 손해가
    /// 그대로 합주의 헤드룸이 된다. 앰프에 붙인 것과 같은 이유다
    dc_x1: f64,
    dc_y1: f64,
    dc_x2: f64,
    dc_y2: f64,
    dc_coef: f64,
    band: BandPass,
    /// 클랩의 여러 번 튀는 어택
    clap_countdown: f64,
    clap_left: u32,

    velocity: f64,
    active: bool,
}

impl DrumVoice {
    pub fn new(sample_rate: f64, seed: u32) -> Self {
        Self {
            sample_rate,
            kind: DrumKind::Kick,
            modes: [Mode::default(); MAX_MODES],
            mode_count: 1,
            wires: 0.0,
            wire_env: 0.0,
            phase: 0.0,
            base_hz: 50.0,
            sweep: 1.0,
            sweep_decay: 0.999,
            body_env: 0.0,
            body_decay: 0.999,
            noise_env: 0.0,
            noise_decay: 0.999,
            noise_amount: 0.0,
            noise: Noise(seed | 1),
            dc_x1: 0.0,
            dc_y1: 0.0,
            dc_x2: 0.0,
            dc_y2: 0.0,
            dc_coef: 1.0 - (2.0 * core::f64::consts::PI * 5.0 / sample_rate),
            band: BandPass::default(),
            clap_countdown: 0.0,
            clap_left: 0,
            velocity: 1.0,
            active: false,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// `freq_hz` 는 음정이 있는 드럼(킥·탐)에만 쓰인다.
    /// 하이햇을 반음 올려 봐야 하이햇이 아니므로 무시한다.
    /// 노이즈 씨앗을 음마다 고정한다. **하이햇 16분이 가장 중요한 경우다** —
    /// 씨앗이 음마다 다르면 변주가 살아 있고(머신건이 아니고), 같은 음이면
    /// 언제 렌더해도 같은 소리가 난다
    pub fn seed_noise(&mut self, seed: u32) {
        // **`clap_left` 는 건드리지 않는다.** 난수처럼 보이지만 클랩이 몇 번 더
        // 튈지 세는 카운터다 — 여기에 해시를 넣었더니 40억 번 재타격하며
        // 노이즈가 끝없이 되살아났다 (내가 넣은 버그다)
        self.noise = Noise((seed ^ 0x165667b1).wrapping_mul(0x85eb_ca6b) | 1);
    }

    pub fn note_on(&mut self, freq_hz: f64, velocity: f64, params: &DrumParams) {
        self.kind = params.kind;
        self.velocity = velocity.clamp(0.0, 1.0);
        self.phase = 0.0;
        self.sweep = 1.0 + params.pitch_drop.clamp(0.0, 4.0) * 3.0;
        self.band.reset();
        // **DC 차단기 상태를 지운다.** 안 지우면 앞 타격의 잔여가 남아서 같은
        // 음이라도 앞에 무엇을 쳤느냐에 따라 달라진다 (`reproducibility.test.ts`)
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
        self.dc_x2 = 0.0;
        self.dc_y2 = 0.0;

        let rate = |sec: f64| (-1.0 / (sec.max(0.002) * self.sample_rate)).exp();
        let decay = params.decay_sec.clamp(0.01, 4.0);

        match params.kind {
            DrumKind::Kick => {
                self.base_hz = if freq_hz > 0.0 {
                    freq_hz.clamp(30.0, 120.0)
                } else {
                    50.0
                };
                self.body_decay = rate(decay);
                // 스윕이 빨라야 "둥"이 되고 느리면 "우웅"이 된다
                self.sweep_decay = rate(decay * 0.08);
                self.noise_decay = rate(0.004);
                self.noise_amount = params.noise_amount.clamp(0.0, 1.0) * 0.3;
                self.band.set(3000.0, 0.2, self.sample_rate);
            }
            DrumKind::Tom => {
                self.base_hz = if freq_hz > 0.0 {
                    freq_hz.clamp(60.0, 400.0)
                } else {
                    120.0
                };
                self.body_decay = rate(decay);
                self.sweep_decay = rate(decay * 0.25);
                self.noise_decay = rate(0.01);
                self.noise_amount = params.noise_amount.clamp(0.0, 1.0) * 0.2;
                self.band.set(2000.0, 0.2, self.sample_rate);
            }
            DrumKind::Snare => {
                self.base_hz = 190.0;
                self.body_decay = rate(decay * 0.35);
                self.sweep_decay = rate(decay * 0.05);
                self.noise_decay = rate(decay);
                self.noise_amount = 0.6 + params.noise_amount.clamp(0.0, 1.0) * 0.4;
                self.band.set(
                    1200.0 + params.tone.clamp(0.0, 1.0) * 3000.0,
                    0.35,
                    self.sample_rate,
                );
            }
            DrumKind::HiHatClosed | DrumKind::HiHatOpen => {
                self.base_hz = 0.0;
                let length = if params.kind == DrumKind::HiHatOpen {
                    decay
                } else {
                    decay * 0.18
                };
                self.body_decay = 0.0;
                self.noise_decay = rate(length);
                self.noise_amount = 1.0;
                self.band.set(
                    6000.0 + params.tone.clamp(0.0, 1.0) * 4000.0,
                    0.5,
                    self.sample_rate,
                );
            }
            DrumKind::Clap => {
                self.base_hz = 0.0;
                self.body_decay = 0.0;
                self.noise_decay = rate(decay * 0.5);
                self.noise_amount = 1.0;
                self.band.set(
                    1500.0 + params.tone.clamp(0.0, 1.0) * 2000.0,
                    0.4,
                    self.sample_rate,
                );
                // 클랩은 여러 손바닥이 살짝 어긋나 부딪히는 소리다
                self.clap_left = 3;
                self.clap_countdown = 0.008 * self.sample_rate;
            }
        }

        self.body_env = if params.kind.is_pitched() || params.kind == DrumKind::Snare {
            1.0
        } else {
            0.0
        };

        // 막 진동 모드를 세운다 (`ROADMAP.md` 드럼 개선).
        //
        // 실제 북은 사인 하나가 아니라 여러 모드가 겹쳐 울리고 **각자 다른 속도로
        // 죽는다** — 높은 모드가 먼저 사라지면서 "탕 → 퉁" 으로 변한다.
        // 그 변화가 없으면 아무리 노이즈를 얹어도 신호음처럼 들린다.
        self.mode_count = params.mode_count.clamp(1, MAX_MODES);
        let blend = params.inharmonicity.clamp(0.0, 1.0);
        let metal = matches!(params.kind, DrumKind::HiHatClosed | DrumKind::HiHatOpen);
        for (i, mode) in self.modes[..self.mode_count].iter_mut().enumerate() {
            let ideal = if metal {
                METAL_RATIOS[i]
            } else {
                MEMBRANE_RATIOS[i]
            };
            // 0 이면 정수배(음정이 뚜렷), 1 이면 이상적인 막(퉁 소리)
            mode.ratio = (i as f64 + 1.0) * (1.0 - blend) + ideal * blend;
            // 높은 모드일수록 작고 빨리 죽는다 — 실제 막이 그렇다
            mode.gain = 1.0 / (1.0 + i as f64 * 1.4);
            mode.decay = rate(decay / (1.0 + i as f64 * 0.9));
            mode.env = 1.0;
            mode.phase = 0.0;
        }

        // 스네어 줄. 막이 울리는 동안 달그락거린다 — 노이즈 하나로는 안 나는 소리다
        self.wires = if params.kind == DrumKind::Snare {
            params.snare_wires.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.wire_env = 1.0;

        self.noise_env = 1.0;
        self.active = true;
    }

    pub fn note_off(&mut self) {
        // 원샷이다. 하이햇 오픈을 클로즈로 막는 것은 상위 레이어(초크 그룹)의 일이다
    }

    pub fn reset(&mut self) {
        self.active = false;
        self.body_env = 0.0;
        self.noise_env = 0.0;
        self.wire_env = 0.0;
        for mode in self.modes.iter_mut() {
            mode.env = 0.0;
        }
        self.band.reset();
    }

    /// `out` 에 **더한다**
    pub fn process(&mut self, out: &mut [f32]) {
        if !self.active {
            return;
        }

        for slot in out.iter_mut() {
            // 몸통: 음정이 아래로 떨어지는 막 진동.
            //
            // **장력 변조(sweep)는 모든 모드에 함께 걸린다** — 실제로 막 전체가
            // 같이 팽팽해졌다 풀리기 때문이다. 모드마다 따로 걸면 화음이 흔들린다
            let mut value = 0.0;
            if self.body_env > 1e-5 && self.base_hz > 0.0 {
                let fundamental = self.base_hz * self.sweep;
                let mut sum = 0.0;
                let mut norm = 0.0;
                for mode in self.modes[..self.mode_count].iter_mut() {
                    if mode.env <= 1e-5 {
                        continue;
                    }
                    mode.phase += (fundamental * mode.ratio) / self.sample_rate;
                    if mode.phase >= 1.0 {
                        mode.phase -= 1.0;
                    }
                    sum += (2.0 * core::f64::consts::PI * mode.phase).sin() * mode.gain * mode.env;
                    norm += mode.gain;
                    mode.env = flush(mode.env * mode.decay);
                }
                // 모드 수가 늘어도 전체 크기가 변하지 않게 정규화한다.
                // 안 하면 모드를 켤 때마다 드럼이 커진다
                if norm > 0.0 {
                    value += (sum / norm) * self.body_env;
                }
                self.sweep = 1.0 + (self.sweep - 1.0) * self.sweep_decay;
                self.body_env = flush(self.body_env * self.body_decay);
            }

            // 스네어 줄 — 막의 울림에 실려 달그락거린다.
            // 막 엔벌로프를 곱하므로 막이 죽으면 줄도 조용해진다 (실제로 그렇다)
            if self.wires > 0.0 && self.wire_env > 1e-5 {
                let rattle = self.noise.next() * self.noise.next().abs();
                value += rattle * self.wires * self.wire_env * self.body_env * 1.6;
                self.wire_env = flush(self.wire_env * self.noise_decay);
            }

            // 노이즈: 대역통과를 거쳐 "샤" 소리를 만든다.
            //
            // **엔벌로프는 노이즈 양과 무관하게 감쇠시켜야 한다.** 처음에
            // `noise_amount > 0` 일 때만 줄였더니, 노이즈가 0인 킥은 엔벌로프가
            // 영원히 1로 남아 보이스가 반환되지 않았다 — 치다 보면 보이스 풀이
            // 차서 소리가 끊기는 증상이 된다
            if self.noise_env > 1e-5 {
                // 클랩은 여러 번 다시 튄다
                if self.clap_left > 0 {
                    self.clap_countdown -= 1.0;
                    if self.clap_countdown <= 0.0 {
                        self.noise_env = 1.0;
                        self.clap_left -= 1;
                        self.clap_countdown = 0.008 * self.sample_rate;
                    }
                }
                if self.noise_amount > 0.0 {
                    let filtered = self.band.process(self.noise.next());
                    value += filtered * self.noise_env * self.noise_amount;
                }
                self.noise_env = flush(self.noise_env * self.noise_decay);
            }

            // **헤드룸.** 0.6 이던 것을 0.42 로 내렸다.
            //
            // 근거: 씨앗 40개를 돌려 최악 피크를 쟀더니 스네어가 **+1.50 dBTP** 로
            // 넘쳤다(샘플 피크 +0.77 dBFS). 노이즈 실현값에 따라 몸통·줄·노이즈가
            // 겹치는 순간이 있고, 그때 잘린다 — 한 음만 쳐도 넘으면 화음을 못 친다.
            //
            // 0.42 면 스네어 최악이 -1.6 dBTP 로 들어오고, 나머지 드럼도
            // 스트리밍 권장선(-1 dBTP)을 지킨다. 드럼만 조용해지는 것은 트랙
            // 게인으로 올리면 되지만, **잘린 소리는 되돌릴 수 없다**
            // 5Hz 일차 고역통과. 킥의 40Hz 를 건드리지 않으면서 DC 만 뺀다
            // 2차 (1차 두 단) — 근접-DC 성분까지 깎는다
            let stage1 = value - self.dc_x1 + self.dc_coef * self.dc_y1;
            self.dc_x1 = value;
            self.dc_y1 = stage1;
            let blocked = stage1 - self.dc_x2 + self.dc_coef * self.dc_y2;
            self.dc_x2 = stage1;
            self.dc_y2 = blocked;

            *slot += (blocked * self.velocity * 0.42) as f32;
        }

        if self.body_env <= 1e-5 && self.noise_env <= 1e-5 {
            self.active = false;
        }
    }
}

#[cfg(test)]
mod modal_tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn render(params: DrumParams, freq: f64, seconds: f64) -> Vec<f32> {
        let mut voice = DrumVoice::new(FS, 0x9e3b);
        voice.note_on(freq, 1.0, &params);
        let mut out = vec![0.0f32; (FS * seconds) as usize];
        for chunk in out.chunks_mut(256) {
            voice.process(chunk);
        }
        out
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }

    fn tom(mode_count: usize, inharmonicity: f64) -> DrumParams {
        DrumParams {
            kind: DrumKind::Tom,
            decay_sec: 0.6,
            noise_amount: 0.0,
            mode_count,
            inharmonicity,
            ..Default::default()
        }
    }

    #[test]
    fn single_mode_is_the_old_sound() {
        // **모드 하나 = 예전 동작.** 켜지 않은 악기가 흔들리면 안 된다
        let a = render(tom(1, 0.0), 120.0, 0.3);
        let b = render(tom(1, 1.0), 120.0, 0.3);
        // 모드가 하나면 비조화도는 아무 영향이 없다 (첫 모드 비율은 항상 1)
        assert_eq!(a, b);
    }

    #[test]
    fn more_modes_change_the_sound() {
        let one = render(tom(1, 0.6), 120.0, 0.3);
        let many = render(tom(5, 0.6), 120.0, 0.3);
        let differs = one.iter().zip(many.iter()).filter(|(a, b)| a != b).count();
        assert!(differs > one.len() / 2, "모드를 켰는데 소리가 그대로다");
    }

    #[test]
    fn mode_count_does_not_change_loudness() {
        // 정규화가 빠지면 모드를 켤 때마다 드럼이 커진다
        let one = rms(&render(tom(1, 0.5), 120.0, 0.4));
        let many = rms(&render(tom(6, 0.5), 120.0, 0.4));
        let ratio = many / one;
        assert!(
            (0.5..2.0).contains(&ratio),
            "모드 수로 크기가 {ratio:.2}배 변했다"
        );
    }

    #[test]
    fn high_modes_die_first() {
        // "탕 → 퉁" 으로 변하는 것이 북의 특징이다. 높은 모드가 먼저 사라져야 한다
        let x = render(tom(6, 0.8), 120.0, 0.8);
        let window = (FS * 0.05) as usize;
        // 영점 통과 횟수로 대략의 밝기를 센다 — 높은 모드가 살아 있으면 더 자주 지난다
        let crossings = |from: usize| {
            x[from..(from + window).min(x.len())]
                .windows(2)
                .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
                .count()
        };
        let early = crossings((FS * 0.01) as usize);
        let late = crossings((FS * 0.4) as usize);
        assert!(early > late, "어택이 더 밝지 않다 ({early} vs {late})");
    }

    #[test]
    fn snare_wires_add_rattle_that_follows_the_head() {
        // 줄은 막이 울리는 동안만 달그락거린다 — 막이 죽으면 줄도 조용해진다
        let base = DrumParams {
            kind: DrumKind::Snare,
            decay_sec: 0.25,
            snare_wires: 0.0,
            mode_count: 4,
            inharmonicity: 0.7,
            ..Default::default()
        };
        let dry = render(base, 0.0, 0.6);
        let wet = render(
            DrumParams {
                snare_wires: 1.0,
                ..base
            },
            0.0,
            0.6,
        );
        assert!(rms(&wet) > rms(&dry), "줄을 켰는데 안 들린다");

        // 꼬리에서는 둘 다 조용해야 한다 (줄이 막보다 오래 남으면 안 된다)
        let tail = (FS * 0.5) as usize;
        assert!(
            rms(&wet[tail..]) < rms(&wet[..tail]) * 0.3,
            "줄이 막보다 오래 남는다"
        );
    }

    #[test]
    fn stays_finite_at_extremes() {
        for count in 1..=MAX_MODES {
            for blend in [0.0, 0.5, 1.0] {
                let x = render(tom(count, blend), 400.0, 0.2);
                assert!(
                    x.iter().all(|v| v.is_finite()),
                    "{count}모드 {blend} 에서 발산"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn render(params: DrumParams, freq: f64, n: usize) -> Vec<f32> {
        let mut voice = DrumVoice::new(FS, 12345);
        voice.note_on(freq, 1.0, &params);
        let mut out = vec![0.0f32; n];
        voice.process(&mut out);
        out
    }

    fn rms(signal: &[f32]) -> f64 {
        let mut sum = 0.0;
        for v in signal {
            sum += (*v as f64) * (*v as f64);
        }
        (sum / signal.len() as f64).sqrt()
    }

    /// 대략적인 스펙트럼 무게중심 — 밝기 비교용
    fn brightness(signal: &[f32]) -> f64 {
        let mut edges = 0.0;
        for pair in signal.windows(2) {
            edges += ((pair[1] - pair[0]) as f64).abs();
        }
        edges / signal.len() as f64 / rms(signal).max(1e-12)
    }

    #[test]
    fn every_kind_makes_sound_and_stays_finite() {
        for index in 0..6 {
            let out = render(
                DrumParams {
                    kind: DrumKind::from_index(index),
                    ..Default::default()
                },
                60.0,
                24000,
            );
            assert!(
                out.iter().all(|v| v.is_finite()),
                "종류 {index}: 유한하지 않다"
            );
            assert!(out.iter().all(|v| v.abs() < 2.0), "종류 {index}: 발산");
            assert!(rms(&out) > 1e-4, "종류 {index}: 소리가 안 난다");
        }
    }

    #[test]
    fn kick_is_low_and_hihat_is_bright() {
        // 종류가 실제로 다른 소리를 내는지. 안 그러면 이름만 다른 것이다
        let kick = render(
            DrumParams {
                kind: DrumKind::Kick,
                ..Default::default()
            },
            50.0,
            24000,
        );
        let hihat = render(
            DrumParams {
                kind: DrumKind::HiHatClosed,
                ..Default::default()
            },
            50.0,
            24000,
        );
        assert!(
            brightness(&hihat) > brightness(&kick) * 3.0,
            "하이햇이 킥보다 밝지 않다: {} vs {}",
            brightness(&hihat),
            brightness(&kick)
        );
    }

    #[test]
    fn kick_pitch_sweeps_downward() {
        // "둥" 소리의 정체. 스윕이 없으면 그냥 삑 소리가 난다
        let out = render(
            DrumParams {
                kind: DrumKind::Kick,
                pitch_drop: 1.0,
                decay_sec: 0.5,
                ..Default::default()
            },
            50.0,
            24000,
        );

        // 앞부분의 영교차가 뒷부분보다 촘촘해야 한다 (= 주파수가 높다)
        let crossings = |s: &[f32]| {
            let mut count = 0;
            for pair in s.windows(2) {
                if (pair[0] < 0.0) != (pair[1] < 0.0) {
                    count += 1;
                }
            }
            count
        };
        let early = crossings(&out[200..2400]);
        let late = crossings(&out[12000..14200]);
        assert!(early > late, "음정이 안 떨어진다: 앞 {early} 뒤 {late}");
    }

    #[test]
    fn unpitched_kinds_ignore_the_note() {
        // 하이햇을 반음 올려 봐야 하이햇이다
        let low = render(
            DrumParams {
                kind: DrumKind::HiHatClosed,
                ..Default::default()
            },
            40.0,
            8000,
        );
        let high = render(
            DrumParams {
                kind: DrumKind::HiHatClosed,
                ..Default::default()
            },
            2000.0,
            8000,
        );
        for (a, b) in low.iter().zip(high.iter()) {
            assert!((a - b).abs() < 1e-9, "음정 없는 드럼이 이조됐다");
        }
    }

    #[test]
    fn pitched_kinds_follow_the_note() {
        let low = render(
            DrumParams {
                kind: DrumKind::Tom,
                pitch_drop: 0.0,
                ..Default::default()
            },
            80.0,
            8000,
        );
        let high = render(
            DrumParams {
                kind: DrumKind::Tom,
                pitch_drop: 0.0,
                ..Default::default()
            },
            300.0,
            8000,
        );
        let crossings = |s: &[f32]| {
            let mut count = 0;
            for pair in s.windows(2) {
                if (pair[0] < 0.0) != (pair[1] < 0.0) {
                    count += 1;
                }
            }
            count
        };
        assert!(
            crossings(&high) > crossings(&low) * 2,
            "탐이 음정을 안 따라간다"
        );
    }

    #[test]
    fn open_hihat_rings_longer_than_closed() {
        let closed = render(
            DrumParams {
                kind: DrumKind::HiHatClosed,
                decay_sec: 0.4,
                ..Default::default()
            },
            0.0,
            24000,
        );
        let open = render(
            DrumParams {
                kind: DrumKind::HiHatOpen,
                decay_sec: 0.4,
                ..Default::default()
            },
            0.0,
            24000,
        );
        assert!(
            rms(&open[12000..]) > rms(&closed[12000..]) * 3.0,
            "오픈 하이햇이 더 길게 울리지 않는다"
        );
    }

    #[test]
    fn voice_frees_itself() {
        let mut voice = DrumVoice::new(FS, 1);
        voice.note_on(
            50.0,
            1.0,
            &DrumParams {
                decay_sec: 0.05,
                ..Default::default()
            },
        );
        for _ in 0..30 {
            let mut out = vec![0.0f32; 4800];
            voice.process(&mut out);
        }
        assert!(!voice.is_active(), "끝났는데 보이스가 잡혀 있다");
    }

    #[test]
    fn velocity_scales_the_hit() {
        let mut soft = DrumVoice::new(FS, 1);
        soft.note_on(50.0, 0.2, &DrumParams::default());
        let mut a = vec![0.0f32; 8000];
        soft.process(&mut a);

        let mut hard = DrumVoice::new(FS, 1);
        hard.note_on(50.0, 1.0, &DrumParams::default());
        let mut b = vec![0.0f32; 8000];
        hard.process(&mut b);

        assert!(rms(&b) > rms(&a) * 3.0, "세기가 반영되지 않는다");
    }
}

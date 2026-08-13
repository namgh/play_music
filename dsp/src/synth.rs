//! 버추얼 아날로그 신스 (`sound.md` Tier 3, M4).
//!
//! > 물리 모델링 무관. **에일리어싱 방지 오실레이터(PolyBLEP 등)만 제대로 하면 됨**
//!
//! 왜 PolyBLEP 인가: 순진한 톱니파는 매 주기마다 값이 뚝 떨어진다. 그 불연속은
//! 무한한 하모닉을 만들고, 나이퀴스트 위 성분이 전부 접혀 들어와 **즉시 지저분해진다**
//! (`sound.md` 6-1). PolyBLEP 은 그 불연속 지점만 다항식으로 매끄럽게 만들어
//! 접히는 성분을 없앤다. 오실레이터는 매 샘플 도는 코드라 오버샘플링보다 훨씬 싸다.
//!
//! 완료 판정 (`sound.md` 10절 M4): 대역제한 오실레이터 에일리어싱 측정 통과.

use crate::denormal::flush;
use crate::oversample::Oversampler;
use crate::smooth::{times, Smoothed};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Waveform {
    Saw,
    Square,
    Triangle,
    Sine,
}

impl Waveform {
    pub fn from_index(index: u32) -> Self {
        match index {
            0 => Self::Saw,
            1 => Self::Square,
            2 => Self::Triangle,
            _ => Self::Sine,
        }
    }
}

/// PolyBLEP 보정항.
///
/// `t` 는 불연속 지점까지의 위상 거리(0~1), `dt` 는 한 샘플당 위상 증가.
/// 불연속 앞뒤 한 샘플씩만 손본다.
fn poly_blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// 대역제한 오실레이터 하나
#[derive(Clone, Copy, Debug, Default)]
struct Oscillator {
    phase: f64,
    /// 삼각파는 사각파를 적분해 만든다 — 그 적분 상태
    integrator: f64,
}

impl Oscillator {
    fn reset(&mut self, phase: f64) {
        self.phase = phase;
        self.integrator = 0.0;
    }

    fn next(&mut self, waveform: Waveform, dt: f64) -> f64 {
        let t = self.phase;
        let value = match waveform {
            Waveform::Sine => (2.0 * core::f64::consts::PI * t).sin(),
            Waveform::Saw => {
                // 순진한 톱니: 2t-1. 불연속은 t=0 에 있다
                let naive = 2.0 * t - 1.0;
                naive - poly_blep(t, dt)
            }
            Waveform::Square => {
                let naive = if t < 0.5 { 1.0 } else { -1.0 };
                // 불연속이 t=0 과 t=0.5 두 곳에 있다
                let half = (t + 0.5) % 1.0;
                naive + poly_blep(t, dt) - poly_blep(half, dt)
            }
            Waveform::Triangle => {
                // 대역제한된 사각파를 적분하면 삼각파가 된다.
                // 적분이 DC 를 쌓으므로 살짝 새는 적분기를 쓴다
                let naive = if t < 0.5 { 1.0 } else { -1.0 };
                let half = (t + 0.5) % 1.0;
                let square = naive + poly_blep(t, dt) - poly_blep(half, dt);
                self.integrator = self.integrator * 0.9995 + square * dt * 4.0;
                self.integrator
            }
        };

        self.phase += dt;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        value
    }
}

/// ADSR 엔벌로프. 신스는 줄과 달리 감쇠가 물리로 정해지지 않으므로 필요하다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy, Debug)]
struct Envelope {
    stage: Stage,
    value: f64,
    attack_rate: f64,
    decay_rate: f64,
    sustain: f64,
    release_rate: f64,
}

impl Envelope {
    fn new() -> Self {
        Self {
            stage: Stage::Idle,
            value: 0.0,
            attack_rate: 1.0,
            decay_rate: 1.0,
            sustain: 0.7,
            release_rate: 1.0,
        }
    }

    fn set(&mut self, attack_ms: f64, decay_ms: f64, sustain: f64, release_ms: f64, sr: f64) {
        let rate = |ms: f64| 1.0 / (ms.max(0.5) / 1000.0 * sr);
        self.attack_rate = rate(attack_ms);
        self.decay_rate = rate(decay_ms);
        self.release_rate = rate(release_ms);
        self.sustain = sustain.clamp(0.0, 1.0);
    }

    fn note_on(&mut self) {
        self.stage = Stage::Attack;
    }

    fn note_off(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }

    fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    fn advance(&mut self) -> f64 {
        match self.stage {
            Stage::Idle => self.value = 0.0,
            Stage::Attack => {
                self.value += self.attack_rate;
                if self.value >= 1.0 {
                    self.value = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.value -= self.decay_rate * (1.0 - self.sustain);
                if self.value <= self.sustain {
                    self.value = self.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => self.value = self.sustain,
            Stage::Release => {
                self.value -= self.release_rate;
                if self.value <= 0.0 {
                    self.value = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.value
    }
}

/// 감산 합성의 필터 — TPT(zero-delay feedback) 상태 변수 필터.
///
/// **왜 고전 Chamberlin SVF 가 아닌가:** 그건 컷오프가 `fs/6`(48kHz 에서 8kHz)을
/// 넘으면 불안정해진다. 처음 그걸로 만들었다가 컷오프 18kHz 에서 NaN 이 났다.
/// TPT 는 전 대역에서 안정하고, 컷오프가 아날로그 프로토타입과 정확히 맞는다.
#[derive(Clone, Copy, Debug, Default)]
struct StateVariableFilter {
    /// 적분기 상태 (등가 전압)
    ic1: f64,
    ic2: f64,
    a1: f64,
    a2: f64,
    a3: f64,
}

impl StateVariableFilter {
    fn set(&mut self, cutoff_hz: f64, resonance: f64, sample_rate: f64) {
        // 나이퀴스트에 붙으면 tan 이 발산하므로 살짝 아래로 자른다
        let cutoff = cutoff_hz.clamp(20.0, sample_rate * 0.49);
        let g = (core::f64::consts::PI * cutoff / sample_rate).tan();
        // k = 1/Q. 작을수록 레조넌스가 강하다. 0 이면 자기 발진하므로 하한을 둔다
        let k = (2.0 - 1.94 * resonance.clamp(0.0, 1.0)).max(0.06);
        self.a1 = 1.0 / (1.0 + g * (g + k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }

    fn process(&mut self, x: f64) -> f64 {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        // 비정규수 방지 (`sound.md` 6-3) — 릴리즈 꼬리에서 적분기가 0으로 수렴한다
        self.ic1 = flush(2.0 * v1 - self.ic1);
        self.ic2 = flush(2.0 * v2 - self.ic2);
        v2
    }

    fn is_finite(&self) -> bool {
        self.ic1.is_finite() && self.ic2.is_finite()
    }

    fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SynthParams {
    pub waveform: Waveform,
    /// 두 번째 오실레이터의 디튠 (센트). 0 이면 하나만 쓴다
    pub detune_cents: f64,
    pub cutoff_hz: f64,
    pub resonance: f64,
    /// 엔벌로프가 컷오프를 얼마나 올리는지 (0~1)
    pub filter_env: f64,
    pub attack_ms: f64,
    pub decay_ms: f64,
    pub sustain: f64,
    pub release_ms: f64,
    /// 출력 왜곡 (0 이면 없음). 있으면 오버샘플링을 거친다
    pub drive: f64,

    // --- 두께와 움직임 (`ROADMAP.md` 신스 확장) ---
    //
    // 여기까지는 **에일리어싱은 잡혔지만 얇았다.** 오실레이터 둘에 ADSR 하나뿐이라
    // 소리가 정지해 있었다. 실제 신스가 두껍게 들리는 이유는 파형이 아니라
    // **유니즌·서브·노이즈·LFO** 다.
    /// 유니즌 보이스 수 (1~7). 여러 개를 조금씩 디튠해 겹친다
    pub unison: usize,
    /// 유니즌 보이스 사이의 최대 디튠 (센트)
    pub unison_detune_cents: f64,
    /// 한 옥타브 아래 사인. 저역을 받쳐 준다 (0~1)
    pub sub_level: f64,
    /// 노이즈 섞기 (0~1). 어택의 바람 소리
    pub noise_level: f64,
    /// LFO 속도 (Hz). 0 이면 안 돈다
    pub lfo_hz: f64,
    /// LFO → 음정 (센트). 비브라토
    pub lfo_to_pitch_cents: f64,
    /// LFO → 컷오프 (0~1). 필터가 흔들린다
    pub lfo_to_cutoff: f64,
}

/// 유니즌 보이스 수의 상한. 오디오 경로에서 할당하지 않으려고 고정 배열을 쓴다
pub const MAX_UNISON: usize = 7;

/// 유니즌 보이스들의 디튠 오프셋 (센트). **순수 함수라 테스트가 직접 본다.**
///
/// **±대칭이어야 한다.** 한쪽으로 걸면 여러 보이스의 평균 음정이 밀려 곡 전체가
/// 샤프해진다 — `HANDOFF.md` 10번(신스 디튠)에서 이미 한 번 밟은 함정이다.
/// 오디오로 재려 하면 유니즌이 만드는 맥놀이가 음정 추정을 오염시켜 무엇이 틀렸는지
/// 알 수 없다. 그래서 배치 계산을 따로 떼어 직접 검증한다.
pub fn unison_detune_offsets(unison: usize, spread_cents: f64) -> ([f64; MAX_UNISON], usize) {
    let count = unison.clamp(1, MAX_UNISON);
    let mut out = [0.0; MAX_UNISON];
    if count < 2 || spread_cents.is_nan() || spread_cents <= 0.0 {
        return (out, count);
    }
    for (i, slot) in out[..count].iter_mut().enumerate() {
        // -1 ~ +1 로 고르게 편 뒤 폭의 절반을 곱한다
        let position = (i as f64 / (count as f64 - 1.0)) * 2.0 - 1.0;
        *slot = position * spread_cents * 0.5;
    }
    (out, count)
}

impl Default for SynthParams {
    fn default() -> Self {
        Self {
            waveform: Waveform::Saw,
            detune_cents: 8.0,
            cutoff_hz: 3000.0,
            resonance: 0.2,
            unison: 1,
            unison_detune_cents: 0.0,
            sub_level: 0.0,
            noise_level: 0.0,
            lfo_hz: 0.0,
            lfo_to_pitch_cents: 0.0,
            lfo_to_cutoff: 0.0,
            filter_env: 0.5,
            attack_ms: 5.0,
            decay_ms: 300.0,
            sustain: 0.6,
            release_ms: 250.0,
            drive: 0.0,
        }
    }
}

pub struct SynthVoice {
    sample_rate: f64,
    /// 출력 DC 차단 상태. 톱니·유니즌은 구간 평균이 0 이 아니라 DC 가 남는다 —
    /// 안 들리지만 헤드룸을 먹고 트랙을 쌓을수록 클리핑이 빨라진다
    dc_x1: f64,
    dc_y1: f64,
    osc_a: Oscillator,
    osc_b: Oscillator,
    /// 유니즌 보이스. `osc_a`·`osc_b` 와 별개로 겹친다
    unison: [Oscillator; MAX_UNISON],
    /// 한 옥타브 아래 사인
    sub: Oscillator,
    /// LFO 위상
    lfo_phase: f64,
    /// 노이즈용 결정론적 난수
    noise: u32,
    envelope: Envelope,
    filter: StateVariableFilter,
    oversampler: Oversampler,
    params: SynthParams,
    freq_hz: f64,
    velocity: f64,
    cutoff: Smoothed,
    active: bool,
}

impl SynthVoice {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            dc_x1: 0.0,
            dc_y1: 0.0,
            osc_a: Oscillator::default(),
            osc_b: Oscillator::default(),
            unison: [Oscillator::default(); MAX_UNISON],
            sub: Oscillator::default(),
            lfo_phase: 0.0,
            noise: 0x02f6_e2b1,
            envelope: Envelope::new(),
            filter: StateVariableFilter::default(),
            oversampler: Oversampler::new(sample_rate),
            params: SynthParams::default(),
            freq_hz: 440.0,
            velocity: 1.0,
            cutoff: Smoothed::new(3000.0, times::FILTER_MS, sample_rate),
            active: false,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn note_on(&mut self, freq_hz: f64, velocity: f64, params: &SynthParams) {
        self.params = *params;
        self.freq_hz = freq_hz.clamp(8.0, self.sample_rate * 0.45);
        self.velocity = velocity.clamp(0.0, 1.0);

        // **위상을 씨앗에서 뽑는다.** 두 가지를 동시에 지켜야 한다:
        //
        //   1. *결정적이어야 한다* — 안 그러면 같은 음이 앞에 무엇을 쳤느냐에 따라
        //      달라지고, 중간부터 미리듣기하면 내보내기와 다른 소리가 난다
        //   2. *음마다 어긋나야 한다* — 고정값으로 초기화했더니 동시에 울리는
        //      보이스들의 위상이 정렬돼 피크가 그대로 더해졌다. **7트랙 합주가
        //      +0.5dBFS 로 잘렸다** (그 전까지 통과하던 테스트다)
        //
        // 자유 난수는 1번을, 고정값은 2번을 깬다. 씨앗에서 뽑으면 둘 다 지킨다
        // 음마다 다른 출발점 하나를 뽑고, 나머지는 **그 기준에서 상대적으로** 배치한다
        let mut phase_rng = crate::string_voice::Lcg(self.noise | 1);
        let base = phase_rng.next_unit();
        self.osc_a.reset(base);
        self.osc_b.reset((base + 0.37) % 1.0);

        // **유니즌은 균등하게 편다.** 무작위로 흩으면 서로 겹치거나 상쇄돼서
        // 음량이 씨앗마다 달라진다 (실측 0.22배 — "유니즌은 두꺼워지되 커지지
        // 않는다"는 테스트가 깨졌다). 균등 배치는 결정적이면서 합이 일정하다
        // **유니즌은 같은 위상에서 출발해 디튠으로 벌어진다.** 그게 슈퍼소가
        // 두꺼워지는 원리다.
        //
        // 한 주기에 고르게 펴 봤더니 서로 상쇄돼서 7보이스가 1보이스의 0.27배로
        // 작아졌다 — 주기 파형을 균등 분산하면 합이 거의 0 이 된다. 위상을 흩는
        // 것은 *동시에 울리는 다른 음* 사이에 필요한 것이지 한 음 안에서가 아니다
        for osc in self.unison.iter_mut() {
            osc.reset(base);
        }
        self.sub.reset(base);
        // **LFO 는 0 에서 시작한다.** 오실레이터와 달리 피크를 더하는 성분이 아니라
        // 흔드는 성분이라 어긋나게 할 이유가 없고, 무작위로 시작하면 비브라토의
        // 깊이·속도가 지정값과 안 맞는다 (그렇게 테스트를 깨뜨렸다)
        self.lfo_phase = 0.0;
        // DC 차단기 상태도 남으면 안 된다 — 앞 음의 잔여 DC 가 새 음의 첫 순간을
        // 밀어 놓는다. 크지 않지만 "같은 음이 같은 소리"를 깨는 마지막 조각이었다
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
        self.filter.reset();
        self.oversampler.reset();

        self.envelope.set(
            params.attack_ms,
            params.decay_ms,
            params.sustain,
            params.release_ms,
            self.sample_rate,
        );
        self.envelope.note_on();
        self.cutoff.reset(params.cutoff_hz);
        self.active = true;
    }

    pub fn note_off(&mut self) {
        self.envelope.note_off();
    }

    pub fn set_params_live(&mut self, params: &SynthParams) {
        if !self.active {
            return;
        }
        self.params = *params;
        self.cutoff.set_target(params.cutoff_hz);
        self.envelope.set(
            params.attack_ms,
            params.decay_ms,
            params.sustain,
            params.release_ms,
            self.sample_rate,
        );
    }

    pub fn reset(&mut self) {
        self.filter.reset();
        self.oversampler.reset();
        self.envelope.stage = Stage::Idle;
        self.envelope.value = 0.0;
        self.active = false;
    }

    /// `out` 에 **더한다**
    /// 노이즈 씨앗을 음마다 고정한다 — 줄·픽 노이즈와 같은 이유
    /// (`string_voice::seed_excitation`). 자유 난수면 중간부터 미리듣기할 때
    /// 내보내기와 다른 소리가 난다
    pub fn seed_noise(&mut self, seed: u32) {
        self.noise = (seed ^ 0x27d4_eb2f).wrapping_mul(0x9e37_79b9) | 1;
    }

    pub fn process(&mut self, out: &mut [f32]) {
        if !self.active {
            return;
        }

        // **디튠은 ±절반으로 대칭 배치한다.** 한쪽으로만 걸면 두 오실레이터의
        // 평균 음정이 디튠의 절반만큼 샤프해진다 (8센트 디튠에서 +4센트 오차가 났다).
        // 다른 악기와 겹쳐 쓸 때 바로 드러나는 오차다
        let half = self.params.detune_cents / 2.0;
        let waveform = self.params.waveform;
        let use_second = self.params.detune_cents.abs() > 0.01;
        let drive = self.params.drive.clamp(0.0, 1.0);

        // 유니즈 보이스는 **±대칭으로 편다.** 한쪽으로 걸면 음정이 평균만큼 밀린다
        // (`HANDOFF.md` 10번과 같은 함정)
        let (unison_offsets, unison_count) =
            unison_detune_offsets(self.params.unison, self.params.unison_detune_cents);
        let sub_level = self.params.sub_level.clamp(0.0, 1.0);
        let noise_level = self.params.noise_level.clamp(0.0, 1.0);
        let lfo_step = self.params.lfo_hz.max(0.0) / self.sample_rate;
        let lfo_pitch = self.params.lfo_to_pitch_cents;
        let lfo_cutoff = self.params.lfo_to_cutoff.clamp(0.0, 1.0);

        for sample in out.iter_mut() {
            let env = self.envelope.advance();

            // LFO — 음정과 컷오프를 함께 흔든다. 이게 없으면 소리가 정지해 있다
            let lfo = if lfo_step > 0.0 {
                self.lfo_phase += lfo_step;
                if self.lfo_phase >= 1.0 {
                    self.lfo_phase -= 1.0;
                }
                (2.0 * core::f64::consts::PI * self.lfo_phase).sin()
            } else {
                0.0
            };
            let vibrato = if lfo_pitch != 0.0 {
                (lfo * lfo_pitch / 1200.0).exp2()
            } else {
                1.0
            };
            let freq = self.freq_hz * vibrato;
            let dt_a = (freq * (-half / 1200.0).exp2() / self.sample_rate).min(0.49);
            let dt_b = (freq * (half / 1200.0).exp2() / self.sample_rate).min(0.49);

            let mut raw = self.osc_a.next(waveform, dt_a);
            let mut voices = 1.0;
            if use_second {
                raw += self.osc_b.next(waveform, dt_b);
                voices += 1.0;
            }

            // 유니즌 — 조금씩 다른 음정으로 겹친다. 신스가 "두껍다"고 느끼는 것의 정체다
            if unison_count > 1 {
                for (osc, cents) in self.unison[..unison_count]
                    .iter_mut()
                    .zip(unison_offsets[..unison_count].iter())
                {
                    let dt = (freq * (cents / 1200.0).exp2() / self.sample_rate).min(0.49);
                    raw += osc.next(waveform, dt);
                    voices += 1.0;
                }
            }
            raw /= voices;

            // 서브 — 한 옥타브 아래 사인. 저역을 받쳐 준다
            if sub_level > 0.0 {
                let dt = (freq * 0.5 / self.sample_rate).min(0.49);
                raw += self.sub.next(Waveform::Sine, dt) * sub_level;
            }

            // 노이즈 — 어택의 바람 소리
            if noise_level > 0.0 {
                self.noise = self.noise.wrapping_mul(1664525).wrapping_add(1013904223);
                let white = (self.noise as f64 / 4294967296.0) * 2.0 - 1.0;
                raw += white * noise_level * 0.3;
            }

            // 엔벌로프가 컷오프를 밀어 올린다 (감산 합성의 기본 움직임)
            let base = self.cutoff.advance();
            let cutoff =
                base * (1.0 + self.params.filter_env * env * 3.0) * (1.0 + lfo * lfo_cutoff * 0.6);
            self.filter
                .set(cutoff.max(20.0), self.params.resonance, self.sample_rate);

            let filtered = self.filter.process(raw);
            // DC 차단 — 20Hz 아래만 걷어낸다
            let dc_out = filtered - self.dc_x1 + 0.9995 * self.dc_y1;
            self.dc_x1 = filtered;
            self.dc_y1 = crate::denormal::flush(dc_out);
            *sample += (dc_out * env * self.velocity * 0.4) as f32;
        }

        // 출력 왜곡은 **오버샘플링 안에서만** (`sound.md` 6-1)
        if drive > 0.0 {
            let gain = 1.0 + drive * 12.0;
            self.oversampler.process(out, |x| (x * gain).tanh());
        }

        if self.envelope.is_idle() {
            self.active = false;
        }
        if !self.filter.is_finite() {
            self.reset();
        }
    }
}

#[cfg(test)]
mod thickness_tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn render(params: SynthParams, freq: f64, n: usize) -> Vec<f32> {
        let mut voice = SynthVoice::new(FS);
        voice.note_on(freq, 1.0, &params);
        let mut out = vec![0.0f32; n];
        for chunk in out.chunks_mut(256) {
            voice.process(chunk);
        }
        out
    }

    fn base() -> SynthParams {
        SynthParams {
            waveform: Waveform::Saw,
            cutoff_hz: 8000.0,
            filter_env: 0.0,
            attack_ms: 1.0,
            decay_ms: 5000.0,
            sustain: 1.0,
            detune_cents: 0.0,
            ..Default::default()
        }
    }

    #[test]
    fn defaults_are_the_old_sound() {
        // **전부 0 이면 예전과 완전히 같아야 한다** — 이미 맞춰 둔 프리셋이 흔들리면 안 된다
        let a = render(base(), 220.0, 8192);
        let b = render(
            SynthParams {
                unison: 1,
                unison_detune_cents: 0.0,
                sub_level: 0.0,
                noise_level: 0.0,
                lfo_hz: 0.0,
                ..base()
            },
            220.0,
            8192,
        );
        assert_eq!(a, b);
    }

    #[test]
    fn unison_keeps_the_pitch_centered() {
        // **오디오로 재지 않는다.** 유니즌은 맥놀이를 만들어 음정 추정을 오염시킨다 —
        // 무엇이 틀렸는지 알 수 없게 된다. 배치 계산을 직접 본다
        // (`HANDOFF.md` 10번: 한쪽으로 걸면 평균 음정이 디튠의 절반만큼 밀린다)
        for unison in 2..=MAX_UNISON {
            let (offsets, count) = unison_detune_offsets(unison, 30.0);
            assert_eq!(count, unison);
            let sum: f64 = offsets[..count].iter().sum();
            assert!(
                sum.abs() < 1e-9,
                "{unison} 유니즌의 평균이 {sum} 센트 밀렸다"
            );
            let span = offsets[count - 1] - offsets[0];
            assert!((span - 30.0).abs() < 1e-9, "폭이 {span} 센트다");
        }
        let (offsets, count) = unison_detune_offsets(1, 30.0);
        assert_eq!(count, 1);
        assert_eq!(offsets[0], 0.0, "하나뿐인데 디튠이 걸렸다");
    }

    #[test]
    fn unison_thickens_without_getting_louder() {
        // 정규화가 빠지면 유니즌을 켤 때마다 커진다
        let rms = |x: &[f32]| {
            (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
        };
        let thin = rms(&render(base(), 220.0, 8192));
        let thick = rms(&render(
            SynthParams {
                unison: 7,
                unison_detune_cents: 20.0,
                ..base()
            },
            220.0,
            8192,
        ));
        let ratio = thick / thin;
        assert!(
            (0.5..1.6).contains(&ratio),
            "유니즌으로 크기가 {ratio:.2}배 변했다"
        );
    }

    #[test]
    fn sub_adds_low_end() {
        // **한 옥타브 아래에 실제로 에너지가 생기는지** 본다.
        // 영점 통과로 재려다 실패했다 — 톱니의 기본음이 그대로 남아 있어 통과 횟수가
        // 줄지 않는다. 코드가 아니라 측정이 틀렸던 것이다
        let goertzel = |x: &[f32], hz: f64| {
            let w = 2.0 * core::f64::consts::PI * hz / FS;
            let (mut re, mut im) = (0.0, 0.0);
            for (i, v) in x.iter().enumerate() {
                re += *v as f64 * (w * i as f64).cos();
                im -= *v as f64 * (w * i as f64).sin();
            }
            (re * re + im * im).sqrt() / x.len() as f64
        };
        let n = 16384;
        let with_sub = render(
            SynthParams {
                sub_level: 1.0,
                ..base()
            },
            440.0,
            n,
        );
        let without = render(base(), 440.0, n);
        assert!(
            goertzel(&with_sub, 220.0) > goertzel(&without, 220.0) * 3.0,
            "서브가 한 옥타브 아래에 에너지를 안 더한다"
        );
    }

    #[test]
    fn lfo_moves_the_sound() {
        let still = render(base(), 220.0, (FS * 0.5) as usize);
        let moving = render(
            SynthParams {
                lfo_hz: 5.0,
                lfo_to_pitch_cents: 25.0,
                ..base()
            },
            220.0,
            (FS * 0.5) as usize,
        );
        let differs = still
            .iter()
            .zip(moving.iter())
            .filter(|(a, b)| a != b)
            .count();
        assert!(differs > still.len() / 2, "LFO 를 켰는데 소리가 그대로다");
    }

    #[test]
    fn stays_finite_at_extremes() {
        for unison in 1..=MAX_UNISON {
            let x = render(
                SynthParams {
                    unison,
                    unison_detune_cents: 100.0,
                    sub_level: 1.0,
                    noise_level: 1.0,
                    lfo_hz: 20.0,
                    lfo_to_pitch_cents: 200.0,
                    lfo_to_cutoff: 1.0,
                    drive: 1.0,
                    ..base()
                },
                880.0,
                8192,
            );
            assert!(
                x.iter().all(|v| v.is_finite()),
                "{unison} 유니즌에서 발산했다"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn magnitude_at(signal: &[f32], hz: f64) -> f64 {
        let w = 2.0 * core::f64::consts::PI * hz / FS;
        let n = signal.len();
        let (mut re, mut im, mut norm) = (0.0, 0.0, 0.0);
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

    fn render(params: SynthParams, freq: f64, n: usize) -> Vec<f32> {
        let mut voice = SynthVoice::new(FS);
        voice.note_on(freq, 1.0, &params);
        let mut out = vec![0.0f32; n];
        voice.process(&mut out);
        out
    }

    /// 대역제한 없이 만든 톱니 — 비교용
    fn naive_saw(freq: f64, n: usize) -> Vec<f32> {
        let dt = freq / FS;
        let mut phase = 0.0;
        (0..n)
            .map(|_| {
                let v = (2.0 * phase - 1.0) as f32;
                phase += dt;
                if phase >= 1.0 {
                    phase -= 1.0;
                }
                v * 0.4
            })
            .collect()
    }

    #[test]
    fn oscillator_produces_expected_pitch() {
        // 신스도 음정이 맞아야 한다 (제품 주장은 악기를 가리지 않는다)
        for freq in [55.0, 220.0, 440.0, 2000.0] {
            let params = SynthParams {
                cutoff_hz: 18000.0,
                resonance: 0.0,
                filter_env: 0.0,
                attack_ms: 1.0,
                decay_ms: 5000.0,
                sustain: 1.0,
                detune_cents: 0.0,
                ..SynthParams::default()
            };
            let out = render(params, freq, 16384);
            let at_f = magnitude_at(&out[2048..], freq);
            let off = magnitude_at(&out[2048..], freq * 1.5);
            assert!(
                at_f > off * 5.0,
                "{freq}Hz 에 에너지가 없다: {at_f} vs {off}"
            );
        }
    }

    /// **여유를 숫자로 남긴다.** 톱니는 하모닉이 무한히 뻗어 에일리어싱이
    /// 가장 나기 쉬운 파형이라, 여기 값이 신스의 실질적인 한계다
    #[test]
    fn report_oscillator_aliasing_margin() {
        for freq in [2093.0, 4186.0, 1046.5] {
            let params = SynthParams {
                waveform: Waveform::Saw,
                cutoff_hz: 20000.0,
                resonance: 0.0,
                filter_env: 0.0,
                attack_ms: 1.0,
                decay_ms: 5000.0,
                sustain: 1.0,
                detune_cents: 0.0,
                drive: 0.0,
                release_ms: 200.0,
                ..Default::default()
            };
            let banded = render(params, freq, 16384);
            let naive = naive_saw(freq, 16384);
            let fund = magnitude_at(&banded[2048..], freq);
            let naive_fund = magnitude_at(&naive[2048..], freq);

            // 접혀 들어오는 자리를 여러 개 본다
            let mut worst = -200.0_f64;
            let mut worst_naive = -200.0_f64;
            for h in 12..24 {
                let up = freq * h as f64;
                if up <= 24000.0 {
                    continue;
                }
                let folded = (48000.0 - up).abs();
                if !(20.0..20000.0).contains(&folded) {
                    continue;
                }
                let db =
                    20.0 * (magnitude_at(&banded[2048..], folded) / fund).log10();
                let nb =
                    20.0 * (magnitude_at(&naive[2048..], folded) / naive_fund).log10();
                worst = worst.max(db);
                worst_naive = worst_naive.max(nb);
            }
            println!(
                "  톱니 {freq:6.0}Hz : PolyBLEP {worst:6.1} dB  (대역제한 없으면 {worst_naive:6.1} dB)"
            );
        }
    }

    #[test]
    fn polyblep_removes_aliasing() {
        // M4 완료 판정 (`sound.md` 10절): 대역제한 오실레이터 에일리어싱 측정 통과.
        //
        // 2093Hz 톱니의 하모닉은 2093 배수로 뻗는다. 24kHz 를 넘는 성분이 접히면
        // 배수가 아닌 자리에 에너지가 생긴다
        let freq = 2093.0;
        let params = SynthParams {
            waveform: Waveform::Saw,
            cutoff_hz: 20000.0,
            resonance: 0.0,
            filter_env: 0.0,
            attack_ms: 1.0,
            decay_ms: 5000.0,
            sustain: 1.0,
            detune_cents: 0.0,
            drive: 0.0,
            release_ms: 200.0,
            ..Default::default()
        };
        let banded = render(params, freq, 16384);
        let naive = naive_saw(freq, 16384);

        // 접혀 들어오는 자리: 13×2093 = 27209 → 48000-27209 = 20791Hz
        let folded = 20791.0;
        let banded_db = 20.0
            * (magnitude_at(&banded[2048..], folded) / magnitude_at(&banded[2048..], freq)).log10();
        let naive_db = 20.0
            * (magnitude_at(&naive[2048..], folded) / magnitude_at(&naive[2048..], freq)).log10();

        assert!(
            naive_db > banded_db + 12.0,
            "PolyBLEP 이 에일리어싱을 줄이지 못했다: 순진 {naive_db:.1}dB vs 대역제한 {banded_db:.1}dB"
        );
        assert!(banded_db < -40.0, "대역제한 후에도 {banded_db:.1}dB 남는다");
    }

    #[test]
    fn every_waveform_is_finite_and_bounded() {
        for index in 0..4 {
            for freq in [40.0, 440.0, 4000.0] {
                let params = SynthParams {
                    waveform: Waveform::from_index(index),
                    resonance: 0.95,
                    drive: 1.0,
                    ..Default::default()
                };
                let out = render(params, freq, 8192);
                assert!(
                    out.iter().all(|v| v.is_finite()),
                    "파형 {index}, {freq}Hz: 유한하지 않다"
                );
                assert!(
                    out.iter().all(|v| v.abs() < 4.0),
                    "파형 {index}, {freq}Hz: 발산했다"
                );
            }
        }
    }

    #[test]
    fn envelope_shapes_the_note() {
        let params = SynthParams {
            attack_ms: 50.0,
            decay_ms: 100.0,
            sustain: 0.5,
            release_ms: 100.0,
            filter_env: 0.0,
            cutoff_hz: 8000.0,
            ..Default::default()
        };
        let out = render(params, 440.0, 24000);

        let rms = |from: usize, to: usize| {
            let mut sum = 0.0;
            for v in &out[from..to] {
                sum += (*v as f64) * (*v as f64);
            }
            (sum / (to - from) as f64).sqrt()
        };

        // 어택 중(0~20ms)이 서스테인 구간(300ms 부근)보다 조용해야 한다
        let attacking = rms(0, 960);
        let sustaining = rms(14400, 19200);
        assert!(
            attacking < sustaining,
            "어택이 없다: {attacking} vs {sustaining}"
        );
    }

    #[test]
    fn note_off_releases_and_frees_the_voice() {
        let params = SynthParams {
            release_ms: 20.0,
            ..Default::default()
        };
        let mut voice = SynthVoice::new(FS);
        voice.note_on(440.0, 1.0, &params);
        let mut out = vec![0.0f32; 4800];
        voice.process(&mut out);
        assert!(voice.is_active());

        voice.note_off();
        for _ in 0..10 {
            let mut tail = vec![0.0f32; 4800];
            voice.process(&mut tail);
        }
        assert!(!voice.is_active(), "릴리즈 후에도 보이스가 잡혀 있다");
    }

    #[test]
    fn detune_creates_beating() {
        // 두 오실레이터를 디튠하면 맥놀이가 생긴다 — 신스가 두껍게 들리는 이유
        let params = SynthParams {
            detune_cents: 12.0,
            filter_env: 0.0,
            cutoff_hz: 12000.0,
            attack_ms: 1.0,
            decay_ms: 5000.0,
            sustain: 1.0,
            ..Default::default()
        };
        let out = render(params, 220.0, 48000);

        let rms = |from: usize, to: usize| {
            let mut sum = 0.0;
            for v in &out[from..to] {
                sum += (*v as f64) * (*v as f64);
            }
            (sum / (to - from) as f64).sqrt()
        };

        // 맥놀이 주기 = 220 * (2^(12/1200) - 1) ≈ 1.53Hz → 약 0.65초
        let mut lowest = f64::MAX;
        let mut highest: f64 = 0.0;
        for k in 0..8 {
            let level = rms(k * 6000, (k + 1) * 6000);
            lowest = lowest.min(level);
            highest = highest.max(level);
        }
        assert!(
            highest > lowest * 1.15,
            "맥놀이가 없다: {lowest} ~ {highest}"
        );
    }

    #[test]
    fn resonance_emphasizes_the_cutoff() {
        let base = SynthParams {
            waveform: Waveform::Saw,
            cutoff_hz: 1000.0,
            filter_env: 0.0,
            attack_ms: 1.0,
            decay_ms: 5000.0,
            sustain: 1.0,
            detune_cents: 0.0,
            ..Default::default()
        };
        let flat = render(
            SynthParams {
                resonance: 0.0,
                ..base
            },
            110.0,
            16384,
        );
        let peaky = render(
            SynthParams {
                resonance: 0.9,
                ..base
            },
            110.0,
            16384,
        );

        // 컷오프 부근(990Hz = 9배음)이 레조넌스로 올라와야 한다
        let flat_level = magnitude_at(&flat[2048..], 990.0);
        let peaky_level = magnitude_at(&peaky[2048..], 990.0);
        assert!(
            peaky_level > flat_level * 1.5,
            "레조넌스가 컷오프를 강조하지 않는다: {flat_level:.5} vs {peaky_level:.5}"
        );
    }
}

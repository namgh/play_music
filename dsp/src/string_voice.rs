//! 웨이브가이드 줄 보이스 (`sound.md` 3절 Tier 1).
//!
//! M0 스파이크에서 확인한 함정을 전부 반영했다:
//!  1. 올패스 보간 계수를 **기본음 주파수에서 푼다** — 교과서 공식은 DC 에서만 맞다
//!  2. 루프 안 모든 필터의 위상 지연을 뺀다 — 분산 3단이 C8 에서 4샘플을 먹는다
//!  3. 여진의 DC 를 제거하고 여진 길이를 딜레이 라인과 **정확히** 맞춘다
//!     (`delay_int + 1` 로 잡으면 첫 샘플이 한 번도 읽히지 않아 DC 모드가 살아난다)
//!  4. 감쇠가 고음의 기본음까지 죽인다
//!
//! 그리고 M0 에서 **미해결이던 4번을 여기서 해결한다**:
//! 루프 필터를 기본음에서 단위 이득으로 정규화해 `sustain_sec` 이 실제 T60 이 되게 하고,
//! 그 정규화가 DC 를 발산시키지 않도록 루프에 DC 차단기를 넣는다.

use crate::curve::{cents_to_ratio, PitchCurve};
use crate::denormal::{flush, flush_slice};
use crate::filters::{solve_allpass_coef, Allpass, DcBlock, OneZero};
use crate::interp::{lagrange4, lagrange4_response, solve_lagrange_fraction};
use crate::smooth::{times, Smoothed};

/// 분산 단의 **최대** 개수. 실제로 몇 개를 쓰는지는 비조화도가 정한다.
///
/// 3단으로 고정돼 있을 때는 분산이 전체 루프 지연의 2% 밖에 안 돼서, 계수를 최대로
/// 올려도 **8배음이 6센트도 안 움직였다** — 사실상 분산이 없는 것과 같았다.
/// 실제 피아노는 저역에서 8배음이 30~50센트까지 밀린다.
///
/// 단을 늘리면 그만큼 루프 지연이 늘어나므로 딜레이 라인이 짧아진다. 고음에서는
/// 그 여유가 없어 `compute_loop` 이 계수를 줄여 대응한다.
pub const MAX_DISPERSION_STAGES: usize = 12;
/// 비조화도를 안 준 악기가 쓰는 단 수 — **예전과 같은 소리**
pub const DISPERSION_STAGES: usize = 3;

/// 비조화도 → 분산 단 수. **순수 함수라 테스트가 직접 본다**
pub fn dispersion_stages(inharmonicity: f64) -> usize {
    let amount = inharmonicity.clamp(0.0, 1.0);
    if amount <= 0.0 {
        return DISPERSION_STAGES;
    }
    DISPERSION_STAGES
        + ((MAX_DISPERSION_STAGES - DISPERSION_STAGES) as f64 * amount).round() as usize
}
const MIN_FREQ_HZ: f64 = 20.0;
const REF_SCALE_MM: f64 = 648.0;

/// DC 차단기의 극. 1에 아주 가깝게 둔다 — 최저음(E1 부근)에서도 진폭이 거의 1이어야
/// 하모닉에서 루프 이득이 1을 넘지 않는다
const DC_BLOCK_POLE: f64 = 1.0 - 1e-4;

/// 루프 이득 상한. 정확히 1이면 감쇠가 멈춘다
/// `process_scaled` 가 스택에 잡는 작업 버퍼. 워크렛 블록(128)보다 넉넉하고
/// `MAX_BLOCK`(2048)까지 받는다 — 오디오 경로에서 힙을 쓰지 않기 위해서다
const MAX_SCALED_BLOCK: usize = 2048;

const MAX_LOOP_GAIN: f64 = 0.9999;

/// 음정 곡선을 몇 샘플마다 다시 계산할지.
/// 48kHz 에서 32샘플 = 0.67ms → 비브라토(5~7Hz)에 충분히 촘촘하고,
/// 계수 풀이(이분법)를 매 샘플 돌리지 않아도 된다
const MOD_BLOCK: usize = 32;

#[derive(Clone, Copy, Debug)]
pub struct StringParams {
    pub scale_length_mm: f64,
    pub stiffness: f64,
    pub damping: f64,
    pub sustain_sec: f64,
    pub pluck_position: f64,
    pub pluck_hardness: f64,
    /// 두 번째 편광의 디튠 (센트). 0 이면 편광이 하나뿐이다 (예전 동작)
    pub polarization_detune_cents: f64,
    /// 두 번째 편광의 섞는 양 (0~1)
    pub polarization_mix: f64,
    /// 두 번째 편광의 감쇠 배율. 실제 줄은 브리지에 세로로 더 잘 붙어 먼저 죽는다
    pub polarization_decay_ratio: f64,
    /// 편광 디튠이 음역에 따라 줄어드는 기준음과 하한. 0 이면 엔진 기본값
    pub detune_ref_hz: f64,
    pub detune_min_scale: f64,
    /// **비조화도를 직접 지정한다** (0~1). 0 이면 `stiffness` 만 쓴다.
    ///
    /// 왜 따로 두나: `stiffness` 는 줄 길이에 `L⁻⁴` 로 묶여 있다. 그건 같은 줄을
    /// 길이만 바꿀 때는 맞지만, **피아노처럼 긴 줄에 굵은 강선을 쓰는 악기**에는
    /// 안 맞는다 — 실제 B 는 굵기·장력이 함께 정하고, 피아노는 길어도 비조화도가 크다.
    /// 그 결과 피아노가 사실상 분산 없이 울리고 있었다 (실측: 강성을 15배 올려도
    /// 8배음이 2센트도 안 움직였다).
    pub inharmonicity: f64,
}

impl Default for StringParams {
    fn default() -> Self {
        Self {
            scale_length_mm: REF_SCALE_MM,
            stiffness: 0.012,
            damping: 0.05,
            sustain_sec: 3.0,
            pluck_position: 0.18,
            pluck_hardness: 0.4,
            // 기본은 꺼짐 — 악기가 켜야 예전 소리가 안 바뀐다
            polarization_detune_cents: 0.0,
            polarization_mix: 0.0,
            polarization_decay_ratio: 0.35,
            detune_ref_hz: 0.0,
            detune_min_scale: 0.0,
            inharmonicity: 0.0,
        }
    }
}

/// 노트 시작 시 정해지는 루프 계수
#[derive(Clone, Copy, Debug, Default)]
pub struct LoopSetup {
    pub delay_int: usize,
    pub ap_coef: f64,
    pub disp_coef: f64,
    /// 실제로 쓰는 분산 단 수
    pub disp_stages: usize,
    pub lp_coef: f64,
    pub loop_gain: f64,
    /// 딜레이 라인 + 분수 보간이 담당하는 지연
    pub line_delay: f64,
}

/// 파라미터 → 루프 계수. 테스트가 이 함수를 직접 검증할 수 있게 밖으로 낸다.
pub fn compute_loop(freq_hz: f64, params: &StringParams, sample_rate: f64) -> LoopSetup {
    let w = 2.0 * core::f64::consts::PI * freq_hz / sample_rate;
    // **줄 길이 0 을 그대로 나누면 무한대가 되고 그때부터 전부 NaN 이다.**
    // `sound.md` 6-5 가 요구하는 클램프다 — 위에서 걸러 주기를 기대하지 않는다.
    // 실제로 보이스 타입을 안 넘긴 호출이 이 경로로 들어와 트랙 전체를 무음으로
    // 만들 뻔했다
    let scale_mm = if params.scale_length_mm.is_finite() && params.scale_length_mm > 1.0 {
        params.scale_length_mm
    } else {
        REF_SCALE_MM
    };
    let ratio = REF_SCALE_MM / scale_mm;

    let lp_coef = (params.damping * ratio).clamp(0.0, 0.4);

    // 분산(강성): 같은 음정을 짧은 줄로 내면 장력이 낮아 인하모니시티가 커진다 (B ∝ L⁻⁴).
    // 고음은 주기가 짧아 보정할 여유가 없으므로 딜레이가 남는 선까지 되돌린다.
    // 비조화도를 직접 준 악기는 그것을 쓰고, 아니면 예전처럼 줄 길이에 묶인 강성을 쓴다.
    // **둘 중 큰 쪽**이라 값을 안 준 악기는 소리가 그대로다
    let from_stiffness = params.stiffness * ratio.powi(4);
    // ## 여기가 피아노를 막고 있는 지점이다 (실측 기록)
    //
    // 1차 올패스의 위상 지연은 `|a|` 가 작으면 **나이퀴스트 근처에서만** 변한다.
    // 그래서 110Hz 음의 1~8배음이 전부 "평평한 구간"에 들어가고, 계수를 상한까지
    // 올려도 **8배음이 6센트도 안 밀린다** — 사실상 분산이 없다.
    //
    // `a → -1` 로 올리면 변화 지점이 저역으로 내려오지만, 0.9 부근에서 루프가
    // 무너진다 (배음 크기가 10배 떨어졌다). 단 수를 3 → 12 로 늘려도 마찬가지다.
    //
    // **계수 조정으로 될 일이 아니다.** 목표 비조화도 B 에 맞춰 올패스 계수를
    // 설계로 푸는 전용 분산 필터가 필요하다 (Rauhala-Välimäki 계열). 그건 별도
    // 작업이고, 그때까지 이 값은 **안전한 범위에서만** 동작한다.
    let from_inharmonicity = params.inharmonicity.clamp(0.0, 1.0) * 0.5;
    let mut disp_mag = from_stiffness.max(from_inharmonicity).min(0.6);
    // 단 수도 비조화도가 정한다. 3단으로는 전체 지연의 2% 라 배음이 안 밀린다
    let stages = dispersion_stages(params.inharmonicity);
    let target_delay = sample_rate / freq_hz;
    let mut line_delay = 0.0;
    for _ in 0..64 {
        let in_loop = OneZero::phase_delay(lp_coef, w)
            + stages as f64 * Allpass::phase_delay(-disp_mag, w)
            + DcBlock::phase_delay(DC_BLOCK_POLE, w);
        line_delay = target_delay - in_loop;
        if line_delay >= 2.0 || disp_mag <= 0.0 {
            break;
        }
        disp_mag = (disp_mag - 0.02).max(0.0);
    }

    // 분수 딜레이 — 기본음에서 계수를 직접 푼다
    let mut delay_int = ((line_delay - 0.5).floor() as isize).max(1) as usize;
    let mut ap_coef = solve_allpass_coef(line_delay - delay_int as f64, w);
    if ap_coef.is_none() {
        'search: for step in 1..=4isize {
            for cand in [delay_int as isize + step, delay_int as isize - step] {
                if cand < 1 {
                    continue;
                }
                if let Some(c) = solve_allpass_coef(line_delay - cand as f64, w) {
                    delay_int = cand as usize;
                    ap_coef = Some(c);
                    break 'search;
                }
            }
        }
    }

    // ---- 서스테인 정규화 (M0 미해결 항목의 해결) -----------------------------
    //
    // 루프 안 필터들이 기본음에서 만드는 감쇠를 나눠서 없앤다. 그러면 루프 이득만이
    // T60 을 정하므로 `sustain_sec` 이 말한 값 그대로 동작한다.
    let lp_mag = OneZero::magnitude(lp_coef, w).max(1e-6);
    let dc_mag = DcBlock::magnitude(DC_BLOCK_POLE, w).max(1e-6);

    // T60 은 **전체 주기**로 계산한다. 루프를 한 바퀴 도는 데 걸리는 시간은
    // `fs/f0` 이지 딜레이 라인 길이가 아니다. line_delay 를 쓰면 필터가 먹은 만큼
    // 감쇠가 덜 걸려 고음이 지정값보다 오래 남는다 (C7 에서 -60dB 대신 -50dB).
    //
    // `sustain_sec` 에 줄 길이 보정을 걸지 않는다. 악기 정의가 이미 악기별로
    // 값을 갖고 있어서(우쿨렐레 1.6s, 기타 4s) 이중 계산이 된다. 이 파라미터는
    // "말한 값이 그대로 T60" 이어야 한다.
    let t60 = params.sustain_sec.max(0.05);
    let g_t60 = 10f64.powf(-3.0 * target_delay / (t60 * sample_rate));
    let mut loop_gain = g_t60 / (lp_mag * dc_mag);

    // 정규화 때문에 다른 하모닉에서 루프 이득이 1을 넘으면 발산한다.
    // 루프 공진은 기본음의 정수배에만 생기므로 거기만 확인하면 된다.
    let nyquist = sample_rate / 2.0;
    let mut worst: f64 = 0.0;
    let mut k = 1.0;
    while k * freq_hz < nyquist {
        let wk = 2.0 * core::f64::consts::PI * k * freq_hz / sample_rate;
        let mag =
            loop_gain * OneZero::magnitude(lp_coef, wk) * DcBlock::magnitude(DC_BLOCK_POLE, wk);
        if mag > worst {
            worst = mag;
        }
        k += 1.0;
    }
    if worst > MAX_LOOP_GAIN {
        loop_gain *= MAX_LOOP_GAIN / worst;
    }
    loop_gain = loop_gain.min(MAX_LOOP_GAIN);

    LoopSetup {
        delay_int,
        ap_coef: ap_coef.unwrap_or(0.0),
        disp_coef: -disp_mag,
        disp_stages: stages,
        lp_coef,
        loop_gain,
        line_delay,
    }
}

/// 결정론적 여진용 LCG. 오디오 스레드에서 OS 난수를 부를 수 없고,
/// 테스트가 같은 결과를 재현할 수 있어야 한다
pub struct Lcg(pub u32);

impl Lcg {
    /// 0~1 균등. 위상 초기화처럼 **결정적이면서 어긋난 값**이 필요할 때 쓴다
    pub fn next_unit(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0 as f64 / 4294967296.0
    }

    pub fn next_bipolar(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.0 as f64 / 4294967296.0) * 2.0 - 1.0
    }
}

pub struct StringVoice {
    sample_rate: f64,
    buffer: Vec<f32>,
    /// 여진 작업용. **생성 시 한 번만 할당한다** — 발음마다 할당하면 오디오 경로에
    /// 할당자가 들어오고, wasm 메모리가 자라면 JS 쪽 타입 배열 뷰가 detach 된다
    burst: Vec<f64>,
    burst_src: Vec<f64>,
    write: usize,

    setup: LoopSetup,
    ap_state: f64,
    lp_state: f64,
    disp_state: [f64; MAX_DISPERSION_STAGES],
    dc_x1: f64,
    dc_y1: f64,

    rng: Lcg,
    active: bool,
    /// 지금 울리고 있는 주파수. 발음 중 파라미터를 바꿀 때 루프를 다시 계산하려면 필요하다
    freq_hz: f64,

    // --- 음정 곡선 (곡선이 없으면 전부 쓰이지 않는다) ---
    curve: PitchCurve,
    /// 노트 시작 후 지난 샘플 수
    elapsed: usize,
    /// 라그랑주 보간 계수 (최신 탭 기준)
    interp: [f64; 4],
    /// 보간 읽기의 정수 오프셋
    interp_offset: usize,
    /// 다음 변조 갱신까지 남은 샘플 수
    mod_countdown: usize,
    /// 곡선이 있을 때의 루프 이득 (보간기 진폭까지 보정한 값)
    curve_loop_gain: f64,

    // --- 파라미터 스무딩 (`sound.md` 6-4) ---
    // 발음 중 파라미터를 바꿀 때 계수를 즉시 갈아 끼우면 파형이 점프하고 그게 클릭이다.
    // 음정 관련은 가장 짧게 스무딩한다 — 느리면 그 사이 음정이 미끄러진다.
    smooth_lp: Smoothed,
    smooth_disp: Smoothed,
    smooth_gain: Smoothed,
}

impl StringVoice {
    pub fn new(sample_rate: f64, seed: u32) -> Self {
        let size = (sample_rate / MIN_FREQ_HZ).ceil() as usize + 8;
        Self {
            sample_rate,
            buffer: vec![0.0; size],
            burst: vec![0.0; size],
            burst_src: vec![0.0; size],
            write: 0,
            setup: LoopSetup::default(),
            ap_state: 0.0,
            lp_state: 0.0,
            disp_state: [0.0; MAX_DISPERSION_STAGES],
            dc_x1: 0.0,
            dc_y1: 0.0,
            rng: Lcg(seed | 1),
            active: false,
            freq_hz: 0.0,
            curve: PitchCurve::default(),
            elapsed: 0,
            interp: [0.0, 0.0, 1.0, 0.0],
            interp_offset: 2,
            mod_countdown: 0,
            curve_loop_gain: 0.0,
            smooth_lp: Smoothed::new(0.0, times::FILTER_MS, sample_rate),
            smooth_disp: Smoothed::new(0.0, times::PITCH_MS, sample_rate),
            smooth_gain: Smoothed::new(0.0, times::GAIN_MS, sample_rate),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn setup(&self) -> LoopSetup {
        self.setup
    }

    /// 지금 울리고 있는 주파수. 앰프의 픽업 콤 필터가 줄 주기를 알아야 한다
    pub fn freq_hz(&self) -> f64 {
        self.freq_hz
    }

    pub fn note_on(&mut self, freq_hz: f64, velocity: f64, params: &StringParams) {
        self.note_on_curved(freq_hz, velocity, params, &PitchCurve::default());
    }

    /// **여진 잡음의 씨앗을 음마다 고정한다.**
    ///
    /// 이게 없으면 여진 RNG 가 보이스마다 계속 흘러서, 같은 음이라도 **앞에 몇 음을
    /// 쳤느냐에 따라 다른 소리가 난다.** 처음부터 렌더하면 같은 순서라 결과가 같지만,
    /// **중간부터 미리듣기하면 내보내기와 달라진다** — `note_on` 주석이 막으려던 바로
    /// 그 상황인데 변주(이득·밝기·감쇠)만 씨앗을 쓰고 여진은 빠져 있었다.
    ///
    /// 실측: 하프 같은 음을 사이에 다른 음을 두고 두 번 렌더하면 RMS 가 0.5dB,
    /// 7.3kHz 성분이 35dB 어긋났다. 들리는 차이다.
    pub fn seed_excitation(&mut self, seed: u32) {
        // 0 은 LCG 에서 고정점이라 피한다. 씨앗을 섞어 이웃한 값이 비슷해지지 않게
        self.rng = Lcg((seed ^ 0x9e37_79b9).wrapping_mul(2_654_435_761) | 1);
    }

    /// 음정 곡선이 있는 발음. 곡선이 비어 있으면 검증된 올패스 경로를 그대로 쓴다.
    pub fn note_on_curved(
        &mut self,
        freq_hz: f64,
        velocity: f64,
        params: &StringParams,
        curve: &PitchCurve,
    ) {
        self.freq_hz = freq_hz;
        self.curve = *curve;
        self.elapsed = 0;
        self.mod_countdown = 0;
        self.setup = compute_loop(freq_hz, params, self.sample_rate);
        self.reset_states();
        self.fill_excitation(params, velocity);

        // 새 음은 스무딩을 건너뛰고 즉시 맞춘다 — 이전 음의 계수에서 천천히
        // 옮겨오면 첫 순간의 음정과 음색이 틀린다
        self.smooth_lp.reset(self.setup.lp_coef);
        self.smooth_disp.reset(self.setup.disp_coef);
        self.smooth_gain.reset(self.setup.loop_gain);

        if !self.curve.is_flat() {
            // 보간기는 올패스가 아니라 진폭이 1이 아니다. 그만큼 루프 이득을 되돌리지
            // 않으면 서스테인이 지정값보다 짧아진다
            let w = 2.0 * core::f64::consts::PI * freq_hz / self.sample_rate;
            self.update_modulation();
            let (mag, _) = lagrange4_response(0.5, w);
            self.curve_loop_gain = (self.setup.loop_gain / mag.max(1e-6)).min(MAX_LOOP_GAIN);
        }

        self.active = true;
    }

    /// 지금 시각의 음정 오프셋에 맞춰 읽기 위치와 보간 계수를 다시 정한다.
    fn update_modulation(&mut self) {
        let t = self.elapsed as f64 / self.sample_rate;
        let cents = self.curve.cents_at(t);
        let freq = self.freq_hz * cents_to_ratio(cents);
        let w = 2.0 * core::f64::consts::PI * freq / self.sample_rate;

        // 필터 계수는 기본음 기준으로 고정하고, 그것들이 만드는 지연만 현재
        // 주파수에서 다시 잰다. 계수까지 바꾸면 음색이 비브라토와 함께 흔들린다
        let in_loop = OneZero::phase_delay(self.setup.lp_coef, w)
            + self.setup.disp_stages as f64 * Allpass::phase_delay(self.setup.disp_coef, w)
            + DcBlock::phase_delay(DC_BLOCK_POLE, w);
        let line_delay = (self.sample_rate / freq - in_loop).max(4.0);

        // 보간기의 위상 지연은 대략 2-d 이므로 정수 오프셋을 그 앞으로 잡는다
        let mut offset = (line_delay - 1.5).floor().max(1.0) as usize;
        let mut fraction = solve_lagrange_fraction(line_delay - offset as f64, w);
        for step in 1..=3usize {
            if fraction.is_some() {
                break;
            }
            for candidate in [offset + step, offset.saturating_sub(step).max(1)] {
                if let Some(d) = solve_lagrange_fraction(line_delay - candidate as f64, w) {
                    offset = candidate;
                    fraction = Some(d);
                    break;
                }
            }
        }

        if let Some(d) = fraction {
            self.interp = lagrange4(d);
            self.interp_offset = offset;
        }
    }

    /// **발음 중** 파라미터 변경 (`sound.md` 9-6 — 튜닝 도구의 "실시간 반영").
    ///
    /// 루프를 지금 울리고 있는 주파수로 다시 계산한다. 딜레이 길이가 같이 바뀌므로
    /// 음정은 유지되지만, 큰 폭으로 움직이면 **클릭이 난다**. 파라미터 스무딩
    /// (`sound.md` 6-4)은 아직 없다 — 튜닝 도구에서 귀로 비교하는 용도라 감수한다.
    /// 스무딩이 붙기 전까지 재생 경로에서는 쓰지 않는다.
    pub fn set_params_live(&mut self, params: &StringParams) {
        if !self.active || self.freq_hz <= 0.0 {
            return;
        }
        let next = compute_loop(self.freq_hz, params, self.sample_rate);

        // 딜레이 길이는 바로 반영한다 (음정이므로 미끄러지면 안 된다).
        // 필터·게인 계수는 목표만 바꿔 스무딩으로 따라가게 한다 — 즉시 갈아 끼우면
        // 파형이 점프하고 그게 클릭이다 (`sound.md` 6-4)
        self.smooth_lp.set_target(next.lp_coef);
        self.smooth_disp.set_target(next.disp_coef);
        self.smooth_gain.set_target(next.loop_gain);

        self.setup = LoopSetup {
            // 스무딩되는 값은 setup 에도 목표로 남겨 둔다 (표시·검증용)
            ..next
        };
    }

    pub fn note_off(&mut self) {
        if !self.active {
            return;
        }
        self.setup.loop_gain *= 0.9;
        self.setup.lp_coef = 0.4;
    }

    fn reset_states(&mut self) {
        self.ap_state = 0.0;
        self.lp_state = 0.0;
        self.disp_state = [0.0; MAX_DISPERSION_STAGES];
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
        for v in self.buffer.iter_mut() {
            *v = 0.0;
        }
    }

    /// 여진 길이는 딜레이 라인 길이와 **정확히** 같아야 하고 DC 가 0이어야 한다.
    /// 미리 잡아 둔 버퍼만 쓴다 — 여기서 할당하지 않는다.
    fn fill_excitation(&mut self, params: &StringParams, velocity: f64) {
        let n = self.setup.delay_int.max(1).min(self.burst.len());

        // 뜯는 세기 → 노이즈 저역통과
        let lp_a = ((1.0 - params.pluck_hardness) * 0.95).min(0.98);
        let mut z = 0.0;
        for i in 0..n {
            z = (1.0 - lp_a) * self.rng.next_bipolar() + lp_a * z;
            self.burst[i] = z;
        }

        // 뜯는 위치 → 콤 필터. 위치 β 에서 1/β 배수 하모닉에 노치가 생긴다
        let beta = params.pluck_position.clamp(0.01, 0.5);
        let comb_delay = beta * n as f64;
        if comb_delay >= 1.0 {
            let d0 = comb_delay.floor() as usize;
            let frac = comb_delay - d0 as f64;
            self.burst_src[..n].copy_from_slice(&self.burst[..n]);
            for i in 0..n {
                let a = if i >= d0 { self.burst_src[i - d0] } else { 0.0 };
                let b = if i > d0 {
                    self.burst_src[i - d0 - 1]
                } else {
                    0.0
                };
                self.burst[i] = self.burst_src[i] - ((1.0 - frac) * a + frac * b);
            }
        }

        // DC 제거 후 정규화
        let mean = self.burst[..n].iter().sum::<f64>() / n as f64;
        let mut peak = 0.0f64;
        for v in self.burst[..n].iter_mut() {
            *v -= mean;
            peak = peak.max(v.abs());
        }
        // **0.5 였던 것을 0.42 로 내렸다 (-1.5dB).**
        //
        // 근거: 전 악기 × 전 음역 × 씨앗 6개로 트루 피크를 쟀더니 뜯는 줄의
        // **최고음**에서 넘쳤다 — 만돌린 +0.28 dBTP, 우쿨렐레 0.00, 기타 -0.48.
        // 고음일수록 딜레이 라인이 짧아 루프가 더 세게 공진한다.
        //
        // 샘플 피크는 1.0 아래였지만 트루 피크가 0 을 넘으면 **mp3·AAC 로 바꿀 때
        // 실제로 깎인다** — 우리 파일은 멀쩡한데 사용자가 올린 곳에서 찌그러진다.
        // 스트리밍 권장선(-1 dBTP)을 지키려고 1.5dB 를 양보했다.
        let scale = if peak > 1e-12 {
            0.42 * velocity / peak
        } else {
            0.0
        };
        for i in 0..n {
            self.buffer[i] = (self.burst[i] * scale) as f32;
        }

        self.write = n % self.buffer.len();
    }

    /// `out` 에 **게인을 곱해 더한다** — 두 번째 편광을 섞을 때 쓴다.
    ///
    /// 스크래치 버퍼를 따로 두지 않으려고 렌더한 뒤 그 구간만 다시 훑는다.
    /// 오디오 경로에서 할당하지 않기 위해서다 (`lib.rs` 머리말).
    pub fn process_scaled(&mut self, out: &mut [f32], gain: f64) {
        if !self.active {
            return;
        }
        let before_last = out.len();
        // 자기 출력만 따로 받아야 게인을 곱할 수 있다. `process` 는 += 라
        // 앞의 편광이 이미 써 넣은 값에 섞이면 그것까지 배로 커진다
        let mut mine = [0.0f32; MAX_SCALED_BLOCK];
        let n = before_last.min(MAX_SCALED_BLOCK);
        self.process(&mut mine[..n]);
        let g = gain as f32;
        for (dst, src) in out[..n].iter_mut().zip(mine[..n].iter()) {
            *dst += *src * g;
        }
    }

    /// `out` 에 **더한다**. 믹싱은 호출자 책임
    pub fn process(&mut self, out: &mut [f32]) {
        if !self.active {
            return;
        }
        if !self.curve.is_flat() {
            self.process_curved(out);
            return;
        }

        let size = self.buffer.len();
        let dc_pole = DC_BLOCK_POLE;
        let c = self.setup.ap_coef;

        // 스무딩이 끝났으면 계수를 상수로 고정해 샘플 루프를 가볍게 유지한다
        let settled = self.smooth_lp.is_settled()
            && self.smooth_disp.is_settled()
            && self.smooth_gain.is_settled();

        let mut quiet = true;

        for sample in out.iter_mut() {
            let (s, a, g) = if settled {
                (
                    self.smooth_lp.value(),
                    self.smooth_disp.value(),
                    self.smooth_gain.value(),
                )
            } else {
                (
                    self.smooth_lp.advance(),
                    self.smooth_disp.advance(),
                    self.smooth_gain.advance(),
                )
            };

            let read = (self.write + size - self.setup.delay_int) % size;
            let mut v = self.buffer[read] as f64;

            // 분산 올패스 캐스케이드
            for k in 0..self.setup.disp_stages {
                let y = a * v + self.disp_state[k];
                self.disp_state[k] = v - a * y;
                v = y;
            }

            // DC 차단기 — 정규화된 루프 이득이 DC 를 키우지 못하게 막는다
            let dc_out = v - self.dc_x1 + dc_pole * self.dc_y1;
            self.dc_x1 = v;
            self.dc_y1 = dc_out;
            v = dc_out;

            // 원제로 저역통과 + 루프 이득
            let lp = (1.0 - s) * v + s * self.lp_state;
            self.lp_state = v;
            v = lp * g;

            // 분수 딜레이 올패스
            let y = c * v + self.ap_state;
            self.ap_state = v - c * y;

            self.buffer[self.write] = y as f32;
            *sample += y as f32;
            if y.abs() > 1e-5 {
                quiet = false;
            }

            self.write += 1;
            if self.write == size {
                self.write = 0;
            }
        }

        self.elapsed += out.len();

        // 비정규수 방지 (`sound.md` 6-3). 되먹임 상태가 0으로 수렴할 때
        // 비정규 구간에 들어가면 CPU 가 수십 배로 튄다. wasm 에는 FTZ 플래그가
        // 없으므로 직접 눌러야 한다. 블록마다 한 번이면 충분하다
        self.ap_state = flush(self.ap_state);
        self.lp_state = flush(self.lp_state);
        self.dc_x1 = flush(self.dc_x1);
        self.dc_y1 = flush(self.dc_y1);
        for state in self.disp_state.iter_mut() {
            *state = flush(*state);
        }
        if quiet {
            flush_slice(&mut self.buffer);
        }

        // 수치 안정성 (`sound.md` 6-5) — NaN 하나가 이후 전체를 무음으로 만든다
        if !self.ap_state.is_finite() || !self.lp_state.is_finite() || !self.dc_y1.is_finite() {
            self.reset();
            return;
        }
        if quiet {
            self.active = false;
        }
    }

    /// 음정 곡선이 있을 때의 처리.
    ///
    /// 올패스 대신 **상태 없는 라그랑주 보간**으로 읽는다. 올패스는 필터라서 계수를
    /// 계속 바꾸면 그 상태가 과도 응답을 만든다 — 비브라토는 초당 수천 번 딜레이를
    /// 바꾸므로 그 경로로는 지글거린다.
    fn process_curved(&mut self, out: &mut [f32]) {
        let size = self.buffer.len();
        let dc_pole = DC_BLOCK_POLE;
        let g = self.curve_loop_gain;

        let mut quiet = true;

        for sample in out.iter_mut() {
            let s = self.smooth_lp.advance();
            let a = self.smooth_disp.advance();

            if self.mod_countdown == 0 {
                self.update_modulation();
                self.mod_countdown = MOD_BLOCK;
            }
            self.mod_countdown -= 1;

            // 4점 보간 읽기. `interp[0]` 이 가장 최근 탭이고 그 지연이 `interp_offset`.
            // usize 언더플로를 피하려고 size 를 두 번 더한 뒤 나머지를 취한다
            let base = self.write + 2 * size - self.interp_offset;
            let mut v = 0.0;
            for (m, coef) in self.interp.iter().enumerate() {
                v += coef * self.buffer[(base - m) % size] as f64;
            }

            for k in 0..self.setup.disp_stages {
                let y = a * v + self.disp_state[k];
                self.disp_state[k] = v - a * y;
                v = y;
            }

            let dc_out = v - self.dc_x1 + dc_pole * self.dc_y1;
            self.dc_x1 = v;
            self.dc_y1 = dc_out;
            v = dc_out;

            let lp = (1.0 - s) * v + s * self.lp_state;
            self.lp_state = v;
            v = lp * g;

            self.buffer[self.write] = v as f32;
            *sample += v as f32;
            if v.abs() > 1e-5 {
                quiet = false;
            }

            self.write += 1;
            if self.write == size {
                self.write = 0;
            }
            self.elapsed += 1;
        }

        // 비정규수 방지 (`sound.md` 6-3)
        self.lp_state = flush(self.lp_state);
        self.dc_x1 = flush(self.dc_x1);
        self.dc_y1 = flush(self.dc_y1);
        for state in self.disp_state.iter_mut() {
            *state = flush(*state);
        }
        if quiet {
            flush_slice(&mut self.buffer);
        }

        if !self.lp_state.is_finite() || !self.dc_y1.is_finite() {
            self.reset();
            return;
        }
        if quiet {
            self.active = false;
        }
    }

    pub fn reset(&mut self) {
        self.reset_states();
        self.active = false;
    }
}

#[cfg(test)]
mod excitation_seed_tests {
    use super::*;

    const FS: f64 = 48000.0;

    fn render(seed: u32, warm_up: bool) -> Vec<f32> {
        let mut v = StringVoice::new(FS, 0x1234);
        let params = StringParams::default();
        if warm_up {
            // 앞에 다른 음을 친다 — 이게 뒤 음을 바꾸면 안 된다
            v.note_on(330.0, 0.5, &params);
            let mut scratch = vec![0.0f32; 4096];
            v.process(&mut scratch);
        }
        v.seed_excitation(seed);
        v.note_on(220.0, 1.0, &params);
        let mut out = vec![0.0f32; 8192];
        v.process(&mut out);
        out
    }

    /// **미리듣기 = 내보내기.**
    ///
    /// 여진 RNG 가 보이스마다 흐르면 같은 음이라도 앞에 몇 음을 쳤느냐에 따라
    /// 달라진다. 처음부터 렌더하면 순서가 같아 결과가 같지만, **중간부터
    /// 미리듣기하면 내보내기와 다른 소리가 난다.** 실측으로 RMS 0.5dB,
    /// 7.3kHz 성분 35dB 차이였다 — 들리는 차이다.
    #[test]
    fn same_seed_gives_the_same_sound_regardless_of_history() {
        let fresh = render(42, false);
        let after_another_note = render(42, true);
        for (i, (a, b)) in fresh.iter().zip(after_another_note.iter()).enumerate() {
            assert!(
                (a - b).abs() < 1e-9,
                "{i}번째 샘플이 다르다: {a} vs {b} — 앞 음이 뒤 음을 바꿨다"
            );
        }
    }

    /// 반대쪽도 지켜야 한다 — **씨앗이 다르면 달라야 한다.**
    /// 안 그러면 같은 음을 반복할 때 머신건처럼 들린다
    #[test]
    fn different_seeds_give_different_sound() {
        let a = render(1, false);
        let b = render(2, false);
        let diff: f32 = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| (x - y).abs())
            .fold(0.0, f32::max);
        assert!(
            diff > 1e-3,
            "씨앗이 달라도 같은 소리가 난다 (최대차 {diff})"
        );
    }
}

//! 이펙트 목록. **순서가 ABI 다** — TS 의 `rustKind` 가 이 자리 번호를 쓴다.
//! 새 이펙트는 끝에 붙인다(가운데 끼우면 저장된 곡의 번호가 밀린다 — 사실 TS 는 이름으로
//! 찾지만, 테스트가 이름 목록 전체를 비교하므로 어디에 붙여도 어긋나면 깨진다).

pub mod delays;
pub mod distortion;
pub mod dynamics;
pub mod eq;
pub mod filters;
pub mod gate;
pub mod modulation;
pub mod multipressor;
pub mod spacedesigner;

pub const MAX_PARAMS: usize = 24;
pub const MAX_METERS: usize = 16;

pub type Params = [f32; MAX_PARAMS];
pub type Meters = [f32; MAX_METERS];

pub trait Effect {
    /// 블록마다 처리 전에 부른다. 값은 TS 가 선언 범위로 이미 잘라서 준다
    fn set_params(&mut self, p: &Params);
    /// 스테레오 제자리 처리
    fn process(&mut self, l: &mut [f32], r: &mut [f32]);
    /// 처리 지연(샘플). **만든 뒤 바뀌지 않는다** — 지연 보정이 이 값을 믿는다
    fn latency(&self) -> usize {
        0
    }
    /// 화면에 보여 줄 값 (게인 감소 dB 등). 이펙트마다 뜻이 다르다 — TS 선언에 적는다
    fn meters(&self, _out: &mut Meters) {}
}

/// (이름, 만드는 함수). 만들 때 파라미터 첫 값을 받는다 — 구조가 파라미터에 달린 이펙트
/// (컨볼루션 IR 길이 등)가 첫 블록부터 맞는 모양이어야 한다
type Factory = fn(f32, &Params) -> Box<dyn Effect>;

pub const KINDS: &[(&str, Factory)] = &[
    ("gate", |sr, p| Box::new(gate::Gate::new(sr, p))),
    ("multipressor", |sr, p| {
        Box::new(multipressor::Multipressor::new(sr, p))
    }),
    ("spacedesigner", |sr, p| {
        Box::new(spacedesigner::SpaceDesigner::new(sr, p))
    }),
    // 1단계 — 다이내믹스·EQ·필터
    ("expander", |sr, p| Box::new(dynamics::Expander::new(sr, p))),
    ("deesser", |sr, p| Box::new(dynamics::DeEsser::new(sr, p))),
    ("enveloper", |sr, p| {
        Box::new(dynamics::Enveloper::new(sr, p))
    }),
    ("compmodel", |sr, p| {
        Box::new(dynamics::CompModel::new(sr, p))
    }),
    ("adaptivelimiter", |sr, p| {
        Box::new(dynamics::AdaptiveLimiter::new(sr, p))
    }),
    ("channeleq", |sr, p| Box::new(eq::ChannelEq::new(sr, p))),
    ("linearphaseeq", |sr, p| {
        Box::new(eq::LinearPhaseEq::new(sr, p))
    }),
    ("vintageeq", |sr, p| Box::new(eq::VintageEq::new(sr, p))),
    ("multifilter", |sr, p| {
        Box::new(filters::MultiFilter::new(sr, p))
    }),
    ("envfilter", |sr, p| {
        Box::new(filters::EnvFilter::new(sr, p))
    }),
    ("tilteq", |sr, p| Box::new(eq::TiltEq::new(sr, p))),
    // 2단계 — 딜레이·모듈레이션
    ("tapedelay", |sr, p| Box::new(delays::TapeDelay::new(sr, p))),
    ("stereodelay", |sr, p| {
        Box::new(delays::StereoDelay::new(sr, p))
    }),
    ("delaydesigner", |sr, p| {
        Box::new(delays::DelayDesigner::new(sr, p))
    }),
    ("ensemble", |sr, p| {
        Box::new(modulation::Ensemble::new(sr, p))
    }),
    ("moddelay", |sr, p| {
        Box::new(modulation::ModDelay::new(sr, p))
    }),
    ("rotor", |sr, p| Box::new(modulation::RotorCab::new(sr, p))),
    ("autopan", |sr, p| Box::new(modulation::AutoPan::new(sr, p))),
    ("ringmod", |sr, p| Box::new(modulation::RingMod::new(sr, p))),
    ("freqshifter", |sr, p| {
        Box::new(modulation::FreqShifter::new(sr, p))
    }),
    ("vibrato", |sr, p| Box::new(modulation::Vibrato::new(sr, p))),
    ("phaser12", |sr, p| {
        Box::new(modulation::Phaser12::new(sr, p))
    }),
    // 3단계 — 디스토션·앰프
    ("overdrive", |sr, p| {
        Box::new(distortion::Overdrive::new(sr, p))
    }),
    ("fuzz", |sr, p| Box::new(distortion::Fuzz::new(sr, p))),
    ("fuzzwah", |sr, p| Box::new(distortion::FuzzWah::new(sr, p))),
    ("bitcrusher", |sr, p| {
        Box::new(distortion::Bitcrusher::new(sr, p))
    }),
    ("clipdist", |sr, p| {
        Box::new(distortion::ClipDist::new(sr, p))
    }),
    ("chromaglow", |sr, p| {
        Box::new(distortion::ChromaGlow::new(sr, p))
    }),
    ("ampdesigner", |sr, p| {
        Box::new(distortion::AmpDesigner::new(sr, p))
    }),
    ("bassamp", |sr, p| Box::new(distortion::BassAmp::new(sr, p))),
    ("cabinet", |sr, p| Box::new(distortion::Cabinet::new(sr, p))),
    ("exciter", |sr, p| Box::new(distortion::Exciter::new(sr, p))),
    ("subbass", |sr, p| Box::new(distortion::SubBass::new(sr, p))),
];

pub fn create(kind: usize, sample_rate: f32, params: &Params) -> Option<Box<dyn Effect>> {
    KINDS.get(kind).map(|(_, make)| make(sample_rate, params))
}

#[cfg(test)]
pub mod testing {
    //! 이펙트 공통 시험 — 모든 이펙트가 통과해야 하는 것
    use super::*;

    pub fn sine(freq: f32, sr: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / sr).sin())
            .collect()
    }

    pub fn run(fx: &mut dyn Effect, p: &Params, l: &[f32], r: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let mut ol = l.to_vec();
        let mut or = r.to_vec();
        for (cl, cr) in ol.chunks_mut(128).zip(or.chunks_mut(128)) {
            fx.set_params(p);
            fx.process(cl, cr);
        }
        (ol, or)
    }

    pub fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    pub fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    /// 모든 이펙트: 기본값(0 이 아닌 그럴듯한 값)·극단 값에서 NaN·발산이 없다
    #[test]
    fn every_effect_is_finite_with_extreme_input() {
        let sr = 48000.0;
        let loud = sine(220.0, sr, 24000, 4.0);
        for (i, (name, _)) in KINDS.iter().enumerate() {
            for fill in [0.0f32, 0.5, 1.0] {
                // 파라미터 0/중간/큰 값 — 실제 범위는 TS 가 자르지만 Rust 도 버텨야 한다
                let p: Params = std::array::from_fn(|k| fill * (k as f32 + 1.0) * 10.0);
                let mut fx = create(i, sr, &p).unwrap();
                let (l, r) = run(fx.as_mut(), &p, &loud, &loud);
                assert!(
                    l.iter().chain(r.iter()).all(|v| v.is_finite()),
                    "{name} fill {fill} NaN/inf"
                );
                assert!(peak(&l) < 1e4, "{name} 발산");
            }
        }
    }
}

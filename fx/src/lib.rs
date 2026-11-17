//! 이펙트 코어 — WASM ABI (`EFFECTS_PLAN.md`).
//!
//! **인스턴스 하나 = 이펙트 하나.** 워크렛 노드마다 wasm 인스턴스를 하나 만든다
//! (모듈 컴파일은 컨텍스트당 한 번). 그래서 전역 상태 하나로 충분하고 핸들이 없다.
//!
//! 흐름: `fx_create(종류, 샘플레이트)` → 매 블록 `fx_params()` 에 값 쓰기 ·
//! `fx_in_l/r()` 에 입력 쓰기 → `fx_process(n)` → 같은 버퍼에서 출력 읽기 → `fx_meters()`.

// DSP 는 여러 배열을 같은 번호로 함께 도는 일이 많다 — 반복자로 바꾸면 오히려 읽기 어렵다
#![allow(clippy::needless_range_loop)]

pub mod blocks;
pub mod effects;

use effects::{Effect, Meters, Params, KINDS, MAX_METERS, MAX_PARAMS};

pub const MAX_BLOCK: usize = 2048;

struct State {
    fx: Option<Box<dyn Effect>>,
    params: Params,
    meters: Meters,
    l: Vec<f32>,
    r: Vec<f32>,
}

static mut STATE: Option<State> = None;

fn state() -> &'static mut State {
    // wasm 은 단일 스레드 — 인스턴스마다 자기 메모리를 갖는다
    unsafe {
        let ptr = &raw mut STATE;
        (*ptr).get_or_insert_with(|| State {
            fx: None,
            params: [0.0; MAX_PARAMS],
            meters: [0.0; MAX_METERS],
            l: vec![0.0; MAX_BLOCK],
            r: vec![0.0; MAX_BLOCK],
        })
    }
}

/// 파라미터 버퍼(f32 × 24). `fx_create` 전에 첫 값을 써 두면 첫 블록부터 맞는 모양으로 만든다
#[no_mangle]
pub extern "C" fn fx_params() -> *mut f32 {
    state().params.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn fx_in_l() -> *mut f32 {
    state().l.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn fx_in_r() -> *mut f32 {
    state().r.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn fx_meters() -> *const f32 {
    state().meters.as_ptr()
}

/// 이펙트를 만든다. 반환: 지연(샘플), 모르는 종류면 −1
#[no_mangle]
pub extern "C" fn fx_create(kind: u32, sample_rate: f32) -> i32 {
    let s = state();
    match effects::create(kind as usize, sample_rate, &s.params) {
        Some(fx) => {
            let latency = fx.latency() as i32;
            s.fx = Some(fx);
            latency
        }
        None => -1,
    }
}

/// `frames` 개를 제자리 처리. 이펙트가 없으면 통과
#[no_mangle]
pub extern "C" fn fx_process(frames: u32) {
    let s = state();
    let n = (frames as usize).min(MAX_BLOCK);
    if let Some(fx) = s.fx.as_mut() {
        fx.set_params(&s.params);
        fx.process(&mut s.l[..n], &mut s.r[..n]);
        fx.meters(&mut s.meters);
    }
}

#[no_mangle]
pub extern "C" fn fx_kind_count() -> u32 {
    KINDS.len() as u32
}

/// 종류 이름 (UTF-8) 주소 — 길이는 `fx_kind_name_len`
#[no_mangle]
pub extern "C" fn fx_kind_name(kind: u32) -> *const u8 {
    KINDS
        .get(kind as usize)
        .map_or(std::ptr::null(), |(n, _)| n.as_ptr())
}

#[no_mangle]
pub extern "C" fn fx_kind_name_len(kind: u32) -> u32 {
    KINDS.get(kind as usize).map_or(0, |(n, _)| n.len() as u32)
}

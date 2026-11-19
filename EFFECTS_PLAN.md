# 이펙트 확장 계획 — Rust 이펙트 코어 (`fx/`)

> `LOGIC_PARITY.md` 1-12 "내장 이펙트 약 100종"을 채우는 계획. 2026-11-17 시작.
> Logic 공개 사용 설명서에서 **기능 명세(무엇을 하는가·어떤 손잡이가 있나)만** 가져온다.
> 코드·IR·프리셋 데이터는 가져오지 않는다.

## 1. 왜 Rust 코어인가

지금 14종은 브라우저 내장 노드를 조립했다(`src/audio/effectGraph.ts`). 내장 노드로 만들 수 있는
것은 거의 다 만들었고, 남은 것(게이트·디에서·멀티밴드·리니어 페이즈 EQ·피치·앰프·보코더…)은
**샘플마다 직접 계산**해야 한다. 그래서 `fx/` 크레이트에 이펙트를 직접 구현한다.
`CLAUDE.md` "하지 않기로 한 것"의 EQ·컴프 직접 구현 금지는 2026-11-16 에 이미 풀렸다.

## 2. 구조

```
fx/ (Rust, cdylib → src/generated/fx.wasm)
  blocks/   부품 — smooth · biquad · svf · env(레벨 감지) · delay(분수 딜레이) · lfo
            · crossover(LR4) · fft · conv(블록 분할 컨볼루션) · stft · pitch(YIN)
            · oversample(4배) · shaper · rng · meter
  effects/  이펙트 — 부품을 조립. 이펙트 하나 = `Effect` 트레이트 하나
  lib.rs    ABI — 숫자와 선형 메모리만 (dsp/ 와 같은 원칙, 글루 없음)

public/fx-worklet.js   'rust-fx' 프로세서. 노드 하나에 이펙트 하나.
                       파라미터 p0…p23 은 AudioParam → 기존 오토메이션이 그대로 붙는다
src/audio/fxRuntime.ts 컨텍스트마다 fx.wasm 등록 · Rust 이펙트 노드 생성 · 지연(샘플) 보고
src/audio/fxWasm.ts    같은 ABI 를 Node 에서 돌리는 호스트 — 테스트·측정용
```

- **ABI**: `fx_create(kind, sampleRate) → 지연(샘플)`, `fx_params()`(f32×24), `fx_in_l/r()`·
  `fx_process(frames)`(제자리 처리), `fx_meters()`(f32×16, 게인 감소·튜너·라우드니스 등),
  `fx_kind_count()`/`fx_kind_name(k)` — TS 목록과 Rust 목록이 어긋나면 테스트가 깨진다.
- **wasm 모듈은 컨텍스트당 한 번 컴파일**(워크렛 전역 캐시), 노드마다 인스턴스 하나.
- **스무딩은 Rust 안에서** — 파라미터가 블록 단위(k-rate)로 와도 지퍼 소음이 없게.
- **지연 보정(PDC)**: 이펙트가 지연을 보고하면 체인 지연 = 합. `BusGraph` 가 트랙마다
  (트랙 체인 + 출력 버스 체인) 지연을 재고, 가장 긴 경로에 맞춰 나머지 트랙에 딜레이를 건다.
  센드 경로의 버스 지연 차이와 마스터 지연(재생 헤드 표시 어긋남)은 보정하지 않는다 — 한계로 적는다.
- **버퍼 렌더러**(워크렛이 없는 브라우저용 예비 경로)는 Rust 이펙트를 통과시킨다 — 한계.
- 기존 14종(Web Audio)은 소리가 바뀌지 않게 **그대로 둔다**. 같은 이름의 Rust 판(예: 컴프 모델)은 새 종류로 더한다.
- 템포 동기(딜레이 박자 등)는 `buildEffectChain` 에 bpm 을 넘겨 ms 로 바꾼다(`sync` 파라미터).

## 3. 단계와 목록 (새 70종 → 합계 84종)

| 단계 | 이펙트 (id) | 주로 쓰는 부품 |
|---|---|---|
| 0 틀 + 시범 | `gate` 노이즈 게이트 · `multipressor` 4밴드 컴프 · `spacedesigner` 컨볼루션 리버브 | env · crossover · fft/conv |
| 1 다이내믹스·필터 (11) | `expander` · `deesser` · `enveloper` · `compmodel`(Platinum/VCA/FET/Opto/Vintage) · `adaptivelimiter`(룩어헤드·트루피크) · `channeleq`(8밴드) · `linearphaseeq` · `vintageeq`(Tube/Console/Graphic) · `multifilter`(SVF 멀티모드) · `envfilter`(오토 와우) · `tilteq` | env · biquad · svf · fft |
| 2 딜레이·모듈레이션 (11) | `tapedelay` · `stereodelay` · `delaydesigner`(8탭) · `ensemble` · `moddelay` · `rotor`(레슬리) · `autopan` · `ringmod` · `freqshifter` · `vibrato` · `phaser12` | delay · lfo · 힐베르트 |
| 3 디스토션·앰프 (11) | `overdrive` · `fuzz` · `fuzzwah` · `bitcrusher` · `clipdist` · `chromaglow`(테이프/튜브/트랜지스터) · `ampdesigner` · `bassamp` · `cabinet` · `exciter` · `subbass` | oversample · shaper · biquad · conv |
| 4 리버브 (7) | `chromaverb`(FDN, 방 종류) · `platereverb` · `springreverb` · `roomreverb` · `gatedreverb` · `shimmer` · `enverb` | fdn · allpass · delay · pitch |
| 5 스펙트럼·피치 (10) | `pitchshifter` · `pitchcorrection` · `vocaltransformer` · `harmonizer` · `octaver` · `vocoder`(내장 캐리어) · `spectralgate` · `denoiser` · `matcheq`(목표 곡선) · `freeze` | stft · pitch(YIN) · 그래뉼러 |
| 6 미터·유틸 (9) | `tuner` · `loudness` · `levelmeter` · `correlation` · `analyzer` · `bpmcounter` · `utility`(게인·위상·모노·좌우 바꿈) · `directionmixer` · `stereospread` | meter · fft |
| 7 멀티·창작 (8) | `stepfx` · `remixfx` · `beatbreaker` · `phatfx` · `trancegate` · `tapestop` · `stutter` · `pedalboard`(페달 6개 직렬) | lfo · 위 전부 |

Logic 100종 중 나머지는 옛 판·같은 엔진의 다른 얼굴(예: Silver 계열)이라 **모델 파라미터나 프리셋**으로 채운다.

## 4. 이펙트마다 지키는 것

1. **Rust 단위 테스트** — 숫자로: 주파수 응답, 게인 감소 곡선, 지연 보고값 = 실제 지연, 무음 입력 → 무음(또는 꼬리), NaN 없음, 큰 입력에서 발산 없음.
2. **TS 테스트** — Rust 목록 = TS 목록, 기본값이 범위 안, 오토메이션 대상, Node 호스트로 실제 처리.
3. **CPU 예산** — `fx` 벤치: 이펙트 하나가 128샘플 블록을 실시간의 2% 안에(무거운 것은 표에 따로).
4. **화면** — 파라미터 창은 선언에서 자동. 종류가 많아 추가 메뉴를 **분류별로** 묶는다. 미터가 있는 이펙트(게이트·컴프 게인 감소, 튜너, 라우드니스)는 창에 미터 표시.
5. **시안** — `design/studio-app.figcraft` 에 "21 이펙트" 페이지(추가 메뉴·창·미터).

## 5. 진행 기록

| 단계 | 상태 | 메모 |
|---|---|---|
| 0 | 완료 | `fx/` 크레이트(부품 9 · 이펙트 3), 워크렛 'rust-fx', PDC(버스 그래프), 분류별 추가 메뉴·고르기·로그 슬라이더·미터, Node 호스트(`fxWasm.ts`)·워크렛 vm 시험 |
| 1 | 완료 | 11종 + 부품 SVF · 4배 오버샘플러(지연 정확히 16) · 빠른 dB 변환 |
| 2 | 완료 | 11종 + LFO · 회전자 · 힐베르트 |
| 3 | 완료 | 11종 (앰프는 비선형 3단+톤 스택을 한 번의 4배 구간에서) |
| 4 | 완료 | 7종 + FDN 8줄 · 슈뢰더 확산 · 피치 시프터 |
| 5 | 완료 | 10종 + STFT(지연 2048) · YIN |
| 6 | 완료 | 9종 (라우드니스는 BS.1770 M/S/I·트루 피크) |
| 7 | 완료 | 8종 + 곡 위치·템포 전달(`fx_transport`) |
| 정리 | 완료 | 체인을 고쳐 쓰기(`updateEffectChain` — 바뀐 칸만 새로, Rust 는 값만), EQ 곡선·스텝 칸 화면, 시안 21 페이지 |

### 합계와 시험 (2026-11-19)

- Web Audio 14 + Rust 70 = **84종**
- Rust 87 시험 (이펙트마다 숫자 판정 + 전 이펙트 극단값 NaN/발산 시험), TS: 목록·지연 일치·워크렛 vm·EQ 곡선, CPU: 이펙트마다 실시간 배수(가벼운 것 200배·오버샘플링 80배·무거운 것 40배 이상)
- 브라우저: 84종을 한 트랙에 걸고 재생(노드 70개), Rust 이펙트 넷으로 내보내기 WAV 측정

### 남은 것 (한계)

- 실측 IR 없음 — 스페이스 디자이너·캐비닛은 합성/필터 근사 (에셋이 생기면 `Convolver::new` 에 넘기면 된다)
- 사이드체인 입력 없음 — 덕킹, 보코더 외부 캐리어. 노드에 입력을 하나 더 두는 일
- 센드 버스 지연 차이·마스터 지연·메트로놈은 보정하지 않는다. 템포 변화는 시작 템포로 근사
- 버퍼 렌더러(워크렛 없는 브라우저)는 Rust 이펙트를 통과시킨다
- 소리 판정은 숫자까지 — 귀로 듣는 판정(Logic 과 A/B)은 사람이 해야 한다

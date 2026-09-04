/**
 * 악기 정의 (`sound.md` 9-1 ~ 9-5).
 *
 * **판정 기준: 새 악기를 추가하는데 엔진 코드를 열어야 한다면 설계가 틀렸다.**
 * 악기 추가 = 정의 하나 추가. 보이스 타입(합성 엔진)은 소수, 악기는 다수다.
 */

/** 합성 엔진의 종류. 이것만 코드다 — 늘어나는 일이 드물다 */
export type VoiceType =
  | 'waveguide-string' // 뜯는 줄·때리는 줄 (Tier 1·2)
  | 'modal'            // 벨·마림바 (Tier 2)
  | 'virtual-analog'   // 신스 (Tier 3)
  | 'sampler'          // 드럼·보컬·앙상블 (Tier 4)
  | 'percussion';      // 합성 드럼 (에셋 없이 리듬을 만들 수 있게)

/**
 * Rust 쪽 `VoiceKind::from_index` 와 **순서가 같아야 한다.**
 *
 * 예전에는 그걸 이 주석으로만 약속했다. 중간에 하나를 끼워 넣으면 뒤가 전부 밀려서
 * **모든 악기가 엉뚱한 엔진으로 울리는데 컴파일도 테스트도 통과했다.** 지금은
 * `voiceKindAbiHash()` 로 이름과 순서를 함께 해싱해, wasm 을 열 때 양쪽을 대조한다.
 *
 * `Record<VoiceType, number>` 이라 **키를 빠뜨리면 타입 검사에서 걸린다.**
 */
export const VOICE_KIND_INDEX: Record<VoiceType, number> = {
  'waveguide-string': 0,
  modal: 1,
  'virtual-analog': 2,
  sampler: 3,
  percussion: 4,
};

/** 인덱스 순서대로 나열한 이름 — 해시의 입력이자, 사람이 읽는 순서 */
export const VOICE_KIND_ORDER: readonly VoiceType[] = (
  Object.entries(VOICE_KIND_INDEX) as [VoiceType, number][]
)
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => name);

/**
 * 이름 **과 순서**의 FNV-1a. `dsp/src/voice.rs` 의 `abi_hash()` 와 같은 계산이다.
 *
 * 개수만 맞추면 중간에 끼워 넣은 것을 못 잡는데, 그때가 제일 위험하다 —
 * 개수는 그대로인 채 모든 악기가 밀린다.
 */
export function voiceKindAbiHash(): number {
  let hash = 0x811c9dc5;
  const mix = (byte: number) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const name of VOICE_KIND_ORDER) {
    for (const byte of new TextEncoder().encode(name)) mix(byte);
    mix(0x7c); // '|' — "ab","c" 와 "a","bc" 가 같은 값이 되지 않게
  }
  return hash >>> 0;
}

/** 모르는 보이스 타입을 **조용히 0번으로 떨어뜨리지 않는다.** */
export function voiceKindIndex(voice: VoiceType): number {
  const index = VOICE_KIND_INDEX[voice];
  if (index === undefined) {
    // 예전에는 `?? 0` 이라 줄 소리로 울렸다 — 새 보이스를 붙이고 표에 안 적으면
    // "왜 신스가 기타 소리지"를 한참 헤매게 된다
    throw new Error(`보이스 타입을 모른다: ${voice}. VOICE_KIND_INDEX 에 추가할 것`);
  }
  return index;
}

/**
 * 파라미터 선언. UI 를 자동 생성하기 위한 메타데이터 (`sound.md` 9-5).
 * 악기마다 편집 화면을 손으로 만들면 확장이 막힌다.
 */
export interface ParamSpec {
  type: 'float' | 'int' | 'enum';
  min?: number;
  max?: number;
  default: number | string;
  unit?: string;
  label: string;
  /** 슬라이더의 반응 곡선 */
  curve?: 'linear' | 'log';
  /** 편집 화면에서 묶일 그룹 */
  group?: string;
  /** type === 'enum' 일 때의 선택지 */
  options?: string[];
}

export type ParamValue = number | string;

/**
 * 악기 분류. **화면이 이걸 보고 목록을 묶는다** (`plan.md` 원칙: 확장은 데이터로).
 *
 * 보이스 타입(합성 기법)과 **다른 축**이다 — 일렉기타와 우쿨렐레는 둘 다
 * 웨이브가이드지만 사용자에게는 다른 분류다. 기법 차이는 감춘다는 원칙과도 맞다.
 */
export type InstrumentCategory =
  | '기타' | '베이스' | '피아노' | '줄' | '건반·신스' | '말렛·벨' | '드럼';

/** 목록에 나올 순서. 자주 쓰는 것부터 */
export const CATEGORY_ORDER: readonly InstrumentCategory[] = [
  '기타', '베이스', '피아노', '건반·신스', '말렛·벨', '줄', '드럼',
];

/**
 * 몸통 공진 하나 — `(헬름홀츠 대비 비율, 세기, Q)`.
 *
 * 개수가 악기마다 다르므로 파라미터 슬롯이 아니라 **버퍼**로 엔진에 간다
 * (곡선 점과 같은 이유). 없으면 엔진 기본 모드(드레드노트)를 쓴다.
 */
export interface BodyMode {
  ratio: number;
  gain: number;
  q: number;
}

export interface InstrumentDefinition {
  id: string;
  schemaVersion: number;
  name: string;
  /** 목록에서 묶이는 분류. 상속된다 — 파생 악기는 대개 부모와 같다 */
  category?: InstrumentCategory;
  /** 상속. 파생 악기의 한계비용을 0에 가깝게 만드는 장치 (`sound.md` 9-3) */
  extends?: string;
  voice?: VoiceType;
  params?: Record<string, ParamValue>;
  /** 몸통 공진 구성. 통이 다른 악기는 모드 구성 자체가 다르다 */
  bodyModes?: readonly BodyMode[];
  /** 공명현 조율 (기준음 대비 반음). 기타는 EADGBE, 피아노는 다르다 */
  sympatheticSemitones?: readonly number[];
  /** 이 악기가 새로 선언하는 파라미터의 메타데이터 */
  paramSpecs?: Record<string, ParamSpec>;
  range?: { low: number; high: number };
  /** 기본 제공 음색 프리셋 */
  tones?: Record<string, Record<string, ParamValue>>;
  /**
   * 기준 출력 레벨 (선형 배율, 기본 1). **다른 파라미터와 달리 음색이 아니라
   * 음량만 조정한다** — 순정 노트온 게인에 곱해질 뿐 다른 어떤 신호 경로에도
   * 안 걸린다.
   *
   * 같은 세기·같은 조건에서 악기별 출력이 최대 10.2dB(LUFS 로는 13.3dB) 벌어져
   * 있었다(`npm run levels`) — 베이스가 하이햇보다 35dB 크게 나올 정도라
   * 고역이 전부 묻혔다(`SONGCRAFT.md` 6번째 곡 A항). 트랙 게인(`gain`, 기본
   * 0.34)은 사용자가 만지는 페이더라 악기를 바꿀 때마다 다시 잡아야 했는데,
   * 이 값은 악기 정의에 박혀 있어 **악기를 바꿔도 자동으로 따라온다.**
   *
   * −24 LUFS(단음·세기 0.8) 기준으로 역산했고, 밀집 편곡에서 새로 클리핑을
   * 만들지 않도록 **부스트는 +3dB(1.41배)로 상한을 뒀다.** 베이스 계열은 그보다
   * 더 보수적으로 **부스트를 아예 안 준다(상한 1.0)** — 겹쳐 재생될 때 릴리즈가
   * 쌓여 실제 곡에서 트랙 하나가 단독으로 클리핑한 사고가 이미 한 번 났다
   * (`SONGCRAFT.md`: `synth-bass` 단음 −5.9dBFS인데 8분음표 밀도로는 +5.4dBFS).
   * 컷(1 미만)에는 상한이 없다 — 줄이는 쪽은 새 클리핑을 만들지 않는다.
   */
  baseLevel?: number;
}

/** 상속을 다 펼친 결과. 렌더러는 이것만 본다 */
export interface ResolvedInstrument {
  id: string;
  name: string;
  category: InstrumentCategory;
  voice: VoiceType;
  params: Record<string, ParamValue>;
  paramSpecs: Record<string, ParamSpec>;
  range: { low: number; high: number };
  tones: Record<string, Record<string, ParamValue>>;
  /** 몸통 공진 구성. 비어 있으면 엔진 기본 모드 */
  bodyModes: readonly BodyMode[];
  /** 공명현 조율. 비어 있으면 엔진 기본 조율 */
  sympatheticSemitones: readonly number[];
  /** 기준 출력 레벨 (선형 배율). 정의에 없으면 1(보정 없음) */
  baseLevel: number;
  /** 상속 체인 (자신 → 부모 순) — 디버깅·표시용 */
  lineage: string[];
}

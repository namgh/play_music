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

/** Rust 쪽 `VoiceKind::from_index` 와 순서가 같아야 한다 */
export const VOICE_KIND_INDEX: Record<VoiceType, number> = {
  'waveguide-string': 0,
  modal: 1,
  'virtual-analog': 2,
  sampler: 3,
  percussion: 4,
};

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
  /** 상속 체인 (자신 → 부모 순) — 디버깅·표시용 */
  lineage: string[];
}

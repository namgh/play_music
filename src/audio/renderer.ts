/**
 * 렌더러 경계 (`plan.md` 5-2).
 *
 * **렌더러는 교체 가능한 인터페이스 뒤에 갇혀 있어야 한다.**
 * Phase 1은 Web Audio 내장 노드 + JS 로 시작하고, M1에서 Rust→WASM AudioWorklet 이
 * 같은 인터페이스를 구현해 들어온다. 앱 코드는 그 교체를 알아채지 못해야 한다.
 *
 * 이 파일에도 Web Audio 타입이 나오지 않는다. `AudioContext` 를 아는 것은
 * 구현체뿐이다. 이 규칙이 깨지는 순간 교체 가능성이 사라진다.
 */

import type { Project, Track, TrackId, Note } from '../model/project.ts';
import type { Ticks } from '../model/time.ts';

export type TransportState = 'stopped' | 'playing';

export interface TransportPosition {
  tick: Ticks;
  state: TransportState;
}

/**
 * 악기가 실제로 무엇을 할 수 있는지. UI 가 이걸 보고 컨트롤을 노출한다.
 *
 * 포먼트 유지가 여기 있는 이유: 웨이브가이드 합성음은 음정을 딜레이 길이로 직접
 * 만들어 포먼트가 밀릴 일이 없다. 포먼트 보존이 의미 있는 건 샘플을 리샘플하는
 * 보이스(보컬)뿐이다 (`plan.md` 5-4). 음이 아니라 **보이스의 능력**이므로
 * 노트 데이터가 아니라 여기 있어야 한다.
 */
export interface InstrumentCapabilities {
  /** 샘플 재생 보이스만 true */
  preserveFormant: boolean;
  /** 물리 파라미터 노출 가능 여부 (줄 길이 등) */
  physicalParams: boolean;
  lowestMidi: number;
  highestMidi: number;
}

export interface ExportOptions {
  sampleRate: number;
  /** 트랙별로 따로 뽑을지 (스템 내보내기) */
  stems: boolean;
}

export interface ExportResult {
  sampleRate: number;
  /** 채널별 PCM. stems=true 면 트랙 순서대로 여러 개 */
  buffers: { trackId: TrackId | null; channels: Float32Array[] }[];
}

export interface AudioRenderer {
  /**
   * 프로젝트 전체를 넘긴다. 렌더러는 이것만으로 소리를 재현할 수 있어야 한다.
   * 부분 갱신은 아래 개별 메서드로.
   */
  setProject(project: Project): void;

  /** 트랙 하나만 바뀐 경우 — 전체 재구성을 피하기 위한 경로 */
  updateTrack(track: Track): void;

  play(fromTick: Ticks): void;
  stop(): void;
  seek(tick: Ticks): void;
  getPosition(): TransportPosition;

  /** 편집 중 즉시 들려주기 (피아노롤에서 음을 찍었을 때) */
  auditionNote(trackId: TrackId, note: Note): void;

  /**
   * 메트로놈. **프로젝트에 저장하지 않는다** — 곡의 일부가 아니라 듣는 사람의
   * 취향이고, 내보내기에는 절대 섞이면 안 된다 (`exportAudio` 는 이걸 보지 않는다).
   */
  setMetronome(on: boolean): void;

  capabilitiesOf(instrumentId: string): InstrumentCapabilities;

  /**
   * 내보내기. `OfflineAudioContext` 로 클라이언트에서 렌더한다 —
   * 미리듣기와 결과물이 100% 일치하고 서버 비용이 0이다 (`plan.md` 5-2).
   */
  exportAudio(options: ExportOptions): Promise<ExportResult>;

  dispose(): void;
}

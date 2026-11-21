/**
 * 플랫폼 경계 — **웹과 설치형이 갈리는 곳은 여기 하나다.**
 *
 * 화면과 엔진은 한 벌이고(`desktop/main.cjs` 가 같은 `dist/` 를 띄운다), 다른 것은
 * "이 환경이 무엇을 해 줄 수 있나" 뿐이다. 화면은 여기서 받은 값만 보고 켜거나 끈다 —
 * `if (electron)` 을 화면 여기저기에 흩지 않는다.
 */

export type PlatformKind = 'web' | 'desktop';

export interface PlatformInfo {
  kind: PlatformKind;
  /** 'darwin' | 'win32' | 'linux' — 웹이면 null */
  os: string | null;
}

/** 스피커 배치 — 출력 장치가 채널을 이만큼 열어 줘야 쓸 수 있다 */
export interface SpeakerLayout {
  id: 'stereo' | '5.1' | '7.1' | '7.1.4';
  label: string;
  channels: number;
}

export const SPEAKER_LAYOUTS: SpeakerLayout[] = [
  { id: 'stereo', label: '스테레오', channels: 2 },
  { id: '5.1', label: '5.1 서라운드', channels: 6 },
  { id: '7.1', label: '7.1 서라운드', channels: 8 },
  { id: '7.1.4', label: '7.1.4 (Atmos 베드)', channels: 12 },
];

export interface Capabilities {
  /** 스피커 서라운드 — 설치형이고 장치가 6채널 이상을 열 때 */
  surround: boolean;
  /** 왜 안 되는지 (되는 경우 null) — 화면이 이 문장을 그대로 보여 준다 */
  surroundReason: string | null;
  layouts: (SpeakerLayout & { available: boolean })[];
  /** 출력 장치 고르기 */
  pickOutput: boolean;
  /** Ableton Link·MTC 같은 바깥 동기 — 설치형에서만 (아직 구현 전) */
  externalSync: boolean;
}

/**
 * 환경과 장치 채널 수에서 무엇이 되는지 정한다. **순수 함수** — 화면도 시험도 이것만 본다.
 * `maxChannels` 는 `AudioContext.destination.maxChannelCount` (지금 고른 출력 장치가 받는 채널 수).
 */
export function capabilities(info: PlatformInfo, maxChannels: number, canPickOutput: boolean): Capabilities {
  const desktop = info.kind === 'desktop';
  const layouts = SPEAKER_LAYOUTS.map((l) => ({ ...l, available: l.channels <= 2 || (desktop && maxChannels >= l.channels) }));
  const surround = desktop && maxChannels >= 6;
  return {
    surround,
    surroundReason: surround ? null
      : !desktop ? '스피커 서라운드는 설치형 앱에서 됩니다 — 브라우저는 다채널 장치를 안정적으로 열어 주지 않습니다'
        : `지금 출력 장치는 ${maxChannels}채널입니다 — 5.1 이상 장치를 고르면 켜집니다`,
    layouts,
    pickOutput: canPickOutput,
    externalSync: desktop,
  };
}

interface ResonaBridge { kind?: string; os?: string }

/** 지금 환경. 설치형 껍데기는 `window.resona` 를 심어 둔다 (`desktop/preload.cjs`) */
export function platformInfo(): PlatformInfo {
  const bridge = (globalThis as { resona?: ResonaBridge }).resona;
  if (bridge?.kind === 'desktop') return { kind: 'desktop', os: bridge.os ?? null };
  return { kind: 'web', os: null };
}

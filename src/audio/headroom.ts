/**
 * 넘친 피크를 **얼마나 내리면 되는지** 계산한다.
 *
 * ## 왜 리미터가 아닌가
 *
 * 트랙을 쌓으면 합이 1.0 을 넘고, WAV 인코더는 거기서 **하드 클리핑**한다
 * (`wav.ts` 의 `Math.max(-1, Math.min(1, ...))`). 보통 DAW 는 마스터 리미터로
 * 막지만 우리는 Phase 1 에서 컴프·리미터를 만들지 않기로 했고(`CLAUDE.md`),
 * 무엇보다 **편집 중 소리를 임의로 깎지 않는다**는 원칙이 있다.
 *
 * 그래서 소리를 바꾸는 대신 **얼마나 내려야 하는지를 알려 준다.** 사용자가
 * 누르면 마스터 게인이라는 **프로젝트 값**이 바뀌므로, 미리듣기와 내보내기가
 * 자동으로 같아진다 — 내보내기 때만 몰래 정규화하면 그 둘이 어긋난다.
 *
 * ## 여유를 1.5dB 두는 이유
 *
 * 여기서 재는 것은 **표본 피크**인데, 실제로 스피커에서 복원되는 파형의 꼭짓점
 * (트루 피크)은 표본 사이에 숨어 있어 더 높을 수 있다. 표본 피크를 정확히
 * 0dBFS 에 맞추면 트루 피크는 그 위로 삐져나온다. `SOUND_QUALITY.md` 의 권장선이
 * -1dBTP 이므로, 표본 피크를 -1.5dBFS 로 두어 그 아래에 들어오게 한다.
 */

/** 표본 피크를 이 값까지 내린다. 트루 피크가 -1dBTP 아래에 들어오도록 잡은 여유 */
export const HEADROOM_DB = 1.5;

export function amplitudeToDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

/**
 * 지금 피크가 `peak` 일 때, 마스터 게인을 얼마로 바꾸면 여유 안에 들어오는가.
 *
 * `peak` 은 **이미 `currentGain` 이 곱해진 뒤의** 값이다 (렌더 결과에서 잰다).
 * 넘치지 않는다면 지금 값을 그대로 돌려준다 — 멀쩡한 곡의 음량을 건드리지 않는다.
 */
export function masterGainToFit(
  peak: number,
  currentGain: number,
  headroomDb: number = HEADROOM_DB,
): number {
  const ceiling = Math.pow(10, -headroomDb / 20);
  if (!Number.isFinite(peak) || peak <= ceiling) return currentGain;
  // 게인이 0 이면 소리가 안 나는 것이라 비율을 잡을 수 없다. 그대로 둔다
  if (!(currentGain > 0)) return currentGain;
  return (currentGain * ceiling) / peak;
}

export interface ClipReport {
  /** 렌더 결과의 표본 피크 (선형) */
  peak: number;
  peakDb: number;
  /** 눌렀을 때 적용할 마스터 게인 */
  suggestedGain: number;
  /** 마스터를 몇 dB 내리는 것인가 — 사용자에게 보여 줄 숫자 */
  reductionDb: number;
}

/** 넘쳤을 때만 보고한다. 안 넘쳤으면 `null` — 경고할 것이 없다 */
export function reportClipping(peak: number, currentGain: number): ClipReport | null {
  if (!Number.isFinite(peak) || peak <= 1) return null;
  const suggestedGain = masterGainToFit(peak, currentGain);
  return {
    peak,
    peakDb: amplitudeToDb(peak),
    suggestedGain,
    reductionDb: amplitudeToDb(currentGain) - amplitudeToDb(suggestedGain),
  };
}

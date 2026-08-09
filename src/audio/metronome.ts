/**
 * 메트로놈 클릭 소리.
 *
 * 렌더러 두 개(워크렛·미리렌더)가 같은 소리를 내야 하므로 여기 한 곳에 둔다.
 * 스케줄러는 "언제 울릴지"만 정하고(`scheduler.ts` 의 `collectBeatEvents`),
 * 이 파일이 "어떤 소리인지"를 정한다.
 *
 * **마스터 이펙트를 타지 않고 곧바로 출력으로 간다.** 메트로놈에 리버브·컴프가
 * 걸리면 박자가 흐려지고, 무엇보다 곡의 소리가 아니라 도구의 소리다.
 * 같은 이유로 내보내기(`exportAudio`)는 이걸 절대 부르지 않는다.
 */

import type { ScheduledClick } from './scheduler.ts';

/** 강세(마디 첫 박)와 약박의 음정·크기 */
const ACCENT = { hz: 1600, peak: 0.16 };
const WEAK = { hz: 1000, peak: 0.09 };
/** 클릭 길이. 짧아야 박자가 선명하다 */
const DECAY_SEC = 0.035;

/**
 * 클릭 하나를 예약한다. 만들어진 오실레이터를 돌려주므로 호출자가 정지할 때 끊을 수 있다
 * — 안 끊으면 정지 뒤에도 룩어헤드만큼 딸깍거린다.
 */
export function scheduleClick(
  ctx: BaseAudioContext,
  destination: AudioNode,
  click: ScheduledClick,
  atTime: number,
): OscillatorNode {
  // 이미 지난 시각이 오면 지금 낸다. 과거 시각을 그대로 주면 브라우저가 던진다
  const when = Math.max(ctx.currentTime, atTime);
  const shape = click.accent ? ACCENT : WEAK;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = shape.hz;
  osc.connect(gain).connect(destination);

  // 지수 감쇠로 딱 소리를 만든다. 선형이면 끝에서 각이 생겨 그게 또 클릭이다.
  // `exponentialRampToValueAtTime` 은 0 을 못 받으므로 아주 작은 값으로 내린다
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.linearRampToValueAtTime(shape.peak, when + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + DECAY_SEC);

  osc.start(when);
  osc.stop(when + DECAY_SEC + 0.015);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
  return osc;
}

/**
 * 보이스 인터페이스 (`sound.md` 7절).
 *
 * **모든 보이스 타입이 이 인터페이스를 구현한다.** 상위 레이어(스케줄러, 믹서, UI)는
 * 웨이브가이드인지 샘플인지 알 필요가 없다. 이게 지켜지면 새 합성 기법을 넣을 때
 * 상위 레이어를 손대지 않는다 (`sound.md` 9-4).
 */

import type { ParamValue } from '../../instruments/types.ts';

export interface Voice {
  /** 지금 소리를 내고 있는가. false 면 재사용 가능 */
  readonly active: boolean;

  /**
   * 발음 시작.
   * @param freqHz 목표 주파수. 센트 미세조정이 이미 반영된 값이 온다
   */
  noteOn(freqHz: number, velocity: number, params: Readonly<Record<string, ParamValue>>): void;

  /** 음 끊기 (손으로 줄을 짚는 것에 해당) */
  noteOff(): void;

  /** `out` 에 **더한다**. 믹싱은 호출자 책임 */
  process(out: Float32Array, frames: number): void;

  /** 상태 초기화. NaN 검출 시에도 쓰인다 (`sound.md` 6-5) */
  reset(): void;
}

/** 결정론적 테스트를 위해 난수원을 주입할 수 있게 한다 */
export type Rng = () => number;

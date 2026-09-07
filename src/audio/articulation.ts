/**
 * 주법(아티큘레이션) — 지금은 팜뮤트 하나 (`SONGCRAFT.md` 6번,
 * "지금은 음 길이로만 흉내. 톤이 그대로라 계속 같은 소리").
 *
 * **새 ABI 파라미터를 만들지 않는다.** 뮤트는 물리적으로 손이 줄에 닿아 감쇠를
 * 급격히 키우는 것이고, `damping`·`sustainSec` 가 이미 정확히 그 물리량이다 —
 * 뮤트 세기만큼 "뮤트됐을 때의 값" 쪽으로 밀어 주면 된다.
 *
 * **`waveguide-string` 계열에서만 뜻이 있다.** 같은 이름(`damping`)을 신스가
 * 필터 감쇠로 쓰는데 범위가 다르다(신스는 0~0.8, 줄은 0~0.25) — 다른 물리량에
 * 같은 이름이 붙은 것뿐이라, 신스에 이 함수를 걸면 팜뮤트가 아니라 엉뚱한
 * 필터 캐릭터가 된다. 호출하는 쪽이 `voice === 'waveguide-string'` 을 확인한다.
 */

/** `string-base.ts` paramSpec 의 범위 안 — 그 밖으로 나가면 다른 악기가 또 밟은
 * "화면 범위 vs 실효 범위" 불일치를 반복하게 된다 */
const MUTED_DAMPING = 0.22;
const MUTED_SUSTAIN_SEC = 0.35;

/**
 * `mute` 세기만큼 damping 은 올리고 sustainSec 은 줄인 값을 돌려준다.
 * **항상 더 뮤트되는 방향으로만 움직인다** — 악기 기본값이 이미 목표보다 어둡거나
 * 짧으면(예외적인 파생 악기) 되레 풀어 주지 않는다.
 */
export function muteParams(
  mute: number,
  baseDamping: number,
  baseSustainSec: number,
): { damping: number; sustainSec: number } {
  const m = Math.max(0, Math.min(1, mute));
  const targetDamping = Math.max(MUTED_DAMPING, baseDamping);
  const targetSustain = Math.min(MUTED_SUSTAIN_SEC, baseSustainSec);
  return {
    damping: baseDamping + (targetDamping - baseDamping) * m,
    sustainSec: baseSustainSec + (targetSustain - baseSustainSec) * m,
  };
}

/**
 * 렌더 경로 네 곳이 공통으로 부르는 지점 — `voice` 가드와 "안 걸면 빈 객체"를
 * 여기 한 곳에 모아서, 호출부는 스프레드 하나만 추가하면 된다.
 */
export function expressionParams(
  voice: string,
  expression: { mute?: number } | null | undefined,
  baseParams: Readonly<Record<string, number | string>>,
): Record<string, number> {
  const mute = expression?.mute;
  if (voice !== 'waveguide-string' || !mute) return {};
  const baseDamping = typeof baseParams.damping === 'number' ? baseParams.damping : 0.05;
  const baseSustainSec = typeof baseParams.sustainSec === 'number' ? baseParams.sustainSec : 3;
  return muteParams(mute, baseDamping, baseSustainSec);
}

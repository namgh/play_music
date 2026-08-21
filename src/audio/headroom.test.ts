/**
 * 넘친 피크를 맞추는 계산.
 *
 * 여기가 틀리면 증상이 조용하다 — 사용자는 버튼을 누르고 "고쳤다"고 믿는데
 * 파일은 여전히 잘려 나간다. 그래서 **누른 뒤에 정말 안 넘치는지**를 본다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HEADROOM_DB, masterGainToFit, reportClipping } from './headroom.ts';

const CEILING = Math.pow(10, -HEADROOM_DB / 20);

test('안 넘치면 게인을 건드리지 않는다', () => {
  // 멀쩡한 곡의 음량을 임의로 바꾸면 그게 더 나쁜 일이다
  assert.equal(masterGainToFit(0.5, 1), 1);
  assert.equal(masterGainToFit(CEILING, 0.8), 0.8);
});

test('넘치면 여유 안으로 들어오게 내린다', () => {
  for (const peak of [1.0001, 1.15, 2, 8, 40]) {
    for (const gain of [0.25, 1, 2]) {
      const next = masterGainToFit(peak, gain);
      // 새 게인으로 다시 렌더하면 피크는 비율만큼 줄어든다
      const after = (peak * next) / gain;
      assert.ok(
        after <= CEILING + 1e-9,
        `피크 ${peak}·게인 ${gain} → 적용 후 ${after.toFixed(4)} 가 천장 ${CEILING.toFixed(4)} 을 넘는다`,
      );
      assert.ok(next < gain, '넘쳤으면 반드시 내려가야 한다');
    }
  }
});

test('게인이 0 이거나 값이 이상하면 그대로 둔다', () => {
  // 0 으로 나누면 Infinity 가 프로젝트에 저장된다 — 그 파일은 다시 못 연다
  assert.equal(masterGainToFit(2, 0), 0);
  assert.equal(masterGainToFit(Number.NaN, 1), 1);
  assert.ok(Number.isFinite(masterGainToFit(2, 1)));
});

test('안 넘치면 보고하지 않는다', () => {
  assert.equal(reportClipping(0.9, 1), null);
  assert.equal(reportClipping(1, 1), null);
});

test('넘치면 얼마나 내리는지까지 알려 준다', () => {
  const r = reportClipping(2, 1);
  assert.ok(r);
  assert.ok(Math.abs(r.peakDb - 6.0206) < 0.001, `피크 dB 가 ${r.peakDb}`);
  // 2배(+6.02dB)를 -1.5dBFS 로 내리려면 7.52dB 를 깎아야 한다
  assert.ok(Math.abs(r.reductionDb - 7.5206) < 0.001, `줄이는 양이 ${r.reductionDb}`);
  assert.ok((2 * r.suggestedGain) / 1 <= Math.pow(10, -HEADROOM_DB / 20) + 1e-9);
});

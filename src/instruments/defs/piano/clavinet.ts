import type { InstrumentDefinition } from '../../types.ts';

export const definition: InstrumentDefinition = {
  id: 'clavinet',
  schemaVersion: 1,
  name: '클라비넷',
  category: '피아노',
  extends: 'amped-string',
  params: {
    // 클라비넷은 줄을 **때려서 누르는** 악기다 — 짧고 팽팽하고 아주 밝다
    scaleLengthMm: 320,
    stiffness: 0.011,
    damping: 0.02,
    sustainSec: 1.1,
    pluckHardness: 0.95,
    pluckPosition: 0.06,
    ampCharacter: 1, ampDrive: 0.3, ampToneHigh: 0.75,
    velocityBrightness: 0.45,
    playNoiseAmount: 0.3,
    variationAmount: 0.3,
    releaseMs: 45, // 건반을 떼면 댐퍼가 바로 문다
  },
  // 호너 클라비넷 D6 의 실제 음역 (F1~E6)
  range: { low: 29, high: 88 },
};

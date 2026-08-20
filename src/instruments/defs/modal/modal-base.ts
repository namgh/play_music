import type { InstrumentDefinition } from '../../types.ts';
import { COMMON_SPECS } from '../../specs.ts';

export const definition: InstrumentDefinition = {
  id: 'modal-base',
  schemaVersion: 1,
  name: '모달 (기준)',
  category: '말렛·벨',
  voice: 'modal',
  range: { low: 36, high: 100 },
  paramSpecs: {
    modalMaterial: {
      type: 'enum', min: 0, max: 3, default: 0,
      label: '재질', group: '진동체',
      options: ['마림바', '비브라폰', '벨', '글로켄슈필'],
    },
    modalDecaySec: {
      type: 'float', min: 0.05, max: 12, default: 1.2,
      unit: 's', label: '감쇠', curve: 'log', group: '진동체',
    },
    strikePosition: {
      type: 'float', min: 0.02, max: 0.5, default: 0.25,
      label: '때리는 위치', group: '연주',
    },
    // 때리는 세기는 wasm 에서 뜯는 세기 슬롯을 함께 쓴다
    pluckHardness: {
      type: 'float', min: 0, max: 1, default: 0.5,
      label: '때리는 세기', group: '연주',
    },
    ampEnabled: { type: 'int', min: 0, max: 1, default: 0, label: '앰프', group: '앰프' },
    ...COMMON_SPECS,
  },
  params: {
    modalMaterial: 0,
    modalDecaySec: 1.2,
    strikePosition: 0.25,
    pluckHardness: 0.5,
    ampEnabled: 0,
    // 때린 금속·나무는 손을 떼도 계속 울린다. 그게 이 악기들의 성질이다 —
    // 감쇠는 `modalDecaySec` 이 정한다
    letRing: 1,
    releaseMs: 150,
    // 말렛은 세게 때리면 확실히 밝아진다
    velocityBrightness: 0.3,
    variationAmount: 0.4,
    // 건반처럼 음판이 왼쪽(낮음)에서 오른쪽(높음)으로 늘어서 있다
    stereoWidth: 0.3,
  },
  tones: { default: {}, 부드럽게: { pluckHardness: 0.2 }, 세게: { pluckHardness: 0.95 } },
};

/**
 * 악기 정의의 상속을 펼친다 (`sound.md` 9-3).
 *
 * 줄 악기는 물리 구조가 같고 숫자만 다르다. 상속 체인으로 덮어쓰기만 하면
 * 파생 악기(우쿨렐레·만돌린·밴조…)가 20줄이면 끝난다.
 */

import type {
  InstrumentCategory, InstrumentDefinition, ParamSpec, ParamValue, ResolvedInstrument, VoiceType,
} from './types.ts';

export class InstrumentResolveError extends Error {}

/**
 * `id` 의 상속 체인을 따라가며 부모 → 자식 순으로 덮어쓴다.
 *
 * 순환 상속은 에러다 — 조용히 무한 루프에 빠지면 원인을 찾기 어렵다.
 */
export function resolveInstrument(
  id: string,
  registry: ReadonlyMap<string, InstrumentDefinition>,
): ResolvedInstrument {
  const chain: InstrumentDefinition[] = [];
  const seen = new Set<string>();

  let cursor: string | undefined = id;
  while (cursor !== undefined) {
    if (seen.has(cursor)) {
      throw new InstrumentResolveError(`악기 정의에 순환 상속: ${[...seen, cursor].join(' → ')}`);
    }
    seen.add(cursor);

    const def = registry.get(cursor);
    if (!def) {
      const from = chain.at(-1);
      throw new InstrumentResolveError(
        from ? `악기 정의 "${cursor}" 없음 (${from.id} 이 상속)` : `악기 정의 "${cursor}" 없음`,
      );
    }
    chain.push(def);
    cursor = def.extends;
  }

  // 부모부터 적용하고 자식이 덮어쓴다
  const ordered = [...chain].reverse();

  let voice: VoiceType | undefined;
  let category: InstrumentCategory | undefined;
  let range: { low: number; high: number } | undefined;
  const params: Record<string, ParamValue> = {};
  const paramSpecs: Record<string, ParamSpec> = {};
  const tones: Record<string, Record<string, ParamValue>> = {};

  for (const def of ordered) {
    if (def.voice !== undefined) voice = def.voice;
    if (def.category !== undefined) category = def.category;
    if (def.range !== undefined) range = def.range;
    Object.assign(params, def.params);
    Object.assign(paramSpecs, def.paramSpecs);
    for (const [toneId, toneParams] of Object.entries(def.tones ?? {})) {
      tones[toneId] = { ...tones[toneId], ...toneParams };
    }
  }

  const self = chain[0]!;
  if (voice === undefined) {
    throw new InstrumentResolveError(`악기 "${id}" 의 상속 체인에 voice 가 없다`);
  }
  // 조용히 기본값으로 떨어뜨리지 않는다 — 분류가 틀리면 목록에서 엉뚱한 곳에 나오는데
  // 그건 화면만 보고는 "원래 그런가 보다" 로 지나간다
  if (category === undefined) {
    throw new InstrumentResolveError(`악기 "${id}" 의 상속 체인에 category 가 없다`);
  }

  // 선언되지 않은 파라미터는 UI 를 만들 수 없다 — 조용히 무시하면 나중에 원인을 못 찾는다
  for (const key of Object.keys(params)) {
    if (!(key in paramSpecs)) {
      throw new InstrumentResolveError(`악기 "${id}" 의 파라미터 "${key}" 에 선언(paramSpec)이 없다`);
    }
  }

  return {
    id: self.id,
    name: self.name,
    category,
    voice,
    params,
    paramSpecs,
    range: range ?? { low: 0, high: 127 },
    tones,
    lineage: chain.map((d) => d.id),
  };
}

/** 음색 프리셋과 "내 음색" 오버라이드까지 적용한 최종 파라미터 */
export function instrumentParams(
  instrument: ResolvedInstrument,
  toneId: string | null,
  overrides: Record<string, ParamValue> | null,
): Record<string, ParamValue> {
  const tone = toneId === null ? undefined : instrument.tones[toneId];
  if (toneId !== null && toneId !== 'default' && tone === undefined) {
    throw new InstrumentResolveError(`악기 "${instrument.id}" 에 음색 "${toneId}" 없음`);
  }
  return { ...instrument.params, ...tone, ...overrides };
}

/** 파라미터를 선언된 범위로 클램프 (`sound.md` 6-5 — 극단값에서 필터가 발산한다) */
export function clampParams(
  instrument: ResolvedInstrument,
  values: Record<string, ParamValue>,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const spec = instrument.paramSpecs[key];
    if (spec === undefined || typeof value !== 'number') {
      out[key] = value;
      continue;
    }
    let v = value;
    if (spec.min !== undefined) v = Math.max(spec.min, v);
    if (spec.max !== undefined) v = Math.min(spec.max, v);
    out[key] = spec.type === 'int' ? Math.round(v) : v;
  }
  return out;
}

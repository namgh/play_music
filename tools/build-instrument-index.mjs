/**
 * 악기 폴더를 읽어 **세 가지**를 만든다.
 *
 *   catalog.generated.ts        목록에 필요한 것만 (id·이름·분류) — 항상 실려 있다
 *   defs/<계열>/_all.generated.ts  계열 배럴 — 지연 로딩의 단위
 *   families.generated.ts       계열 → 동적 import
 *
 * ## 왜 파일은 악기 단위인데 청크는 계열 단위인가
 *
 * 둘은 다른 문제다. **파일**은 편집의 단위라 악기 하나에 하나여야 한다 —
 * 그래야 하나를 고칠 때 남의 파일을 안 연다. **청크**는 내려받기의 단위라 악기마다
 * 나누면 1000개 요청이 된다. 계열 단위가 둘 사이의 답이다.
 *
 * ## 왜 목록을 따로 만드나
 *
 * 악기 고르는 화면은 이름과 분류만 있으면 된다. 파라미터는 그 악기로 **소리를 낼 때**
 * 필요하다. 실측하면 목록에 필요한 것은 전체의 5% 다 — 1000개에서 865KB 대 45KB.
 *
 * 이름·분류는 `extends` 로 상속되므로 **여기서 상속을 펼쳐** 박아 둔다. 화면이
 * 실행 시점에 상속을 풀려면 결국 전부 불러와야 하고, 그러면 지연 로딩이 무의미해진다.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src/instruments', import.meta.url));
const DEFS = join(ROOT, 'defs');

/** 기준 정의는 사용자에게 악기로 보이지 않는다 — 상속용 뼈대일 뿐이다 */
const ABSTRACT_IDS = new Set([
  'string-base', 'amped-string', 'synth-base', 'modal-base', 'drum-base',
]);

function scan() {
  const rows = [];
  for (const family of readdirSync(DEFS).sort()) {
    const dir = join(DEFS, family);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.ts') || file.startsWith('_')) continue;
      const path = join(dir, file);
      const id = /id:\s*'([^']+)'/.exec(readFileSync(path, 'utf8'))?.[1];
      if (!id) throw new Error(`${relative(ROOT, path)} 에 id 가 없다`);
      if (file !== `${id}.ts`) {
        // **파일 이름 = 악기 id.** 다르면 파일을 찾을 때 헤매고 지울 때 남는다
        throw new Error(`${relative(ROOT, path)}: 파일 이름이 id('${id}') 와 다르다`);
      }
      rows.push({ family, id });
    }
  }
  return rows;
}

async function load(rows) {
  const defs = new Map();
  const familyOf = new Map();
  for (const { family, id } of rows) {
    const mod = await import(`../src/instruments/defs/${family}/${id}.ts`);
    if (!mod.definition) throw new Error(`${family}/${id}.ts 가 definition 을 내보내지 않는다`);
    defs.set(id, mod.definition);
    familyOf.set(id, family);
  }
  return { defs, familyOf };
}

/** 이 악기를 쓰려면 어떤 계열들을 불러와야 하는가 — 상속을 따라간다 */
function chunksFor(id, defs, familyOf) {
  const need = new Set();
  for (let cur = id, guard = 0; cur && guard < 32; guard += 1) {
    const fam = familyOf.get(cur);
    if (fam) need.add(fam);
    cur = defs.get(cur)?.extends;
  }
  return [...need].sort();
}

const ident = (id) => id.replace(/[^a-zA-Z0-9]/g, '_');
const HEADER = (what) => `/**
 * **자동 생성 — 손으로 고치지 말 것.** (${what})
 *
 * \`npm run instruments:index\` 가 \`defs/\` 폴더를 읽어 만든다.
 * 악기를 추가하려면 \`defs/<계열>/<id>.ts\` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */
`;

async function render() {
  const rows = scan();
  const { defs, familyOf } = await load(rows);

  // 상속을 펼쳐 이름·분류를 얻는다. 화면이 실행 시점에 풀지 않아도 되게
  const { resolveInstrument } = await import('../src/instruments/resolve.ts');
  const registry = new Map(defs);

  const files = new Map();

  // ① 계열 배럴 — 지연 로딩의 단위
  const families = [...new Set(rows.map((r) => r.family))].sort();
  for (const family of families) {
    const ids = rows.filter((r) => r.family === family).map((r) => r.id);
    files.set(
      join(DEFS, family, '_all.generated.ts'),
      `${HEADER(`${family} 계열 ${ids.length}개`)}
import type { InstrumentDefinition } from '../../types.ts';
${ids.map((id) => `import { definition as ${ident(id)} } from './${id}.ts';`).join('\n')}

export const definitions: readonly InstrumentDefinition[] = [
${ids.map((id) => `  ${ident(id)},`).join('\n')}
];
`,
    );
  }

  // ② 경량 카탈로그 — 항상 실려 있다
  const catalog = rows.map(({ family, id }) => {
    const r = resolveInstrument(id, registry);
    return {
      id,
      name: r.name,
      category: r.category,
      family,
      abstract: ABSTRACT_IDS.has(id),
      chunks: chunksFor(id, defs, familyOf),
    };
  });
  files.set(
    join(ROOT, 'catalog.generated.ts'),
    `${HEADER(`악기 ${catalog.length}개`)}
import type { InstrumentCategory } from './types.ts';

export interface CatalogEntry {
  id: string;
  name: string;
  category: InstrumentCategory;
  family: string;
  /** 상속용 뼈대. 사용자에게 악기로 보이지 않는다 */
  abstract: boolean;
  /** 이 악기로 소리를 내려면 불러와야 하는 계열들 (상속을 따라 계산됨) */
  chunks: readonly string[];
}

export const INSTRUMENT_CATALOG: readonly CatalogEntry[] = [
${catalog
  .map(
    (e) =>
      `  { id: '${e.id}', name: '${e.name}', category: '${e.category}', family: '${e.family}',` +
      ` abstract: ${e.abstract}, chunks: [${e.chunks.map((c) => `'${c}'`).join(', ')}] },`,
  )
  .join('\n')}
];
`,
  );

  // ③ 계열 → 동적 import
  files.set(
    join(ROOT, 'families.generated.ts'),
    `${HEADER(`계열 ${families.length}개`)}
import type { InstrumentDefinition } from './types.ts';

type FamilyModule = { definitions: readonly InstrumentDefinition[] };

/** **정적 경로여야 한다** — 번들러가 청크를 나누려면 경로를 컴파일 시점에 알아야 한다 */
export const FAMILY_LOADERS: Record<string, () => Promise<FamilyModule>> = {
${families.map((f) => `  '${f}': () => import('./defs/${f}/_all.generated.ts'),`).join('\n')}
};
`,
  );

  return { files, count: rows.length, families: families.length };
}

const { files, count, families } = await render();
const check = process.argv.includes('--check');
let stale = [];

for (const [path, next] of files) {
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    /* 아직 없음 */
  }
  if (current === next) continue;
  if (check) stale.push(relative(ROOT, path));
  else writeFileSync(path, next);
}

if (check) {
  if (stale.length) {
    console.error(`악기 인덱스가 낡았다: ${stale.join(', ')}`);
    console.error('`npm run instruments:index` 를 돌리고 커밋할 것');
    process.exit(1);
  }
  console.log(`악기 인덱스 최신 — 악기 ${count}개 · 계열 ${families}개`);
} else {
  console.log(`악기 인덱스 생성 — 악기 ${count}개 · 계열 ${families}개`);
}

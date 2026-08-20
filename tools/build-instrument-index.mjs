/**
 * 악기 목록을 **폴더에서 읽어** 인덱스 파일을 만든다.
 *
 * 왜 손으로 안 적는가: 악기가 1000개가 되면 배열에 한 줄 적는 것을 잊는 일이
 * 반드시 생긴다. 그러면 파일은 있는데 목록에 안 나오고, 원인을 찾기가 어렵다.
 * **폴더에 파일을 떨구면 그게 곧 등록이다.**
 *
 * 왜 `import.meta.glob` 을 안 쓰는가: 그건 Vite 변환이라 브라우저 번들에서만
 * 동작한다. 테스트는 `node --test` 로 도는데 거기서는 없는 문법이라 터진다.
 * 생성된 파일을 커밋해 두면 양쪽이 같은 것을 본다.
 *
 * 왜 커밋하는가: 생성물을 빌드 때만 만들면 에디터가 정의를 못 찾고, CI 순서가
 * 하나 어긋나면 빌드가 깨진다. 커밋해 두고 **CI 가 최신인지 검사한다**.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src/instruments', import.meta.url));
const DEFS = join(ROOT, 'defs');
const OUT = join(ROOT, 'registry.generated.ts');

/** 계열 폴더 안의 악기 파일들. `_` 로 시작하는 파일은 건너뛴다 (내부용) */
function collect() {
  const rows = [];
  for (const family of readdirSync(DEFS).sort()) {
    const dir = join(DEFS, family);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.ts') || file.startsWith('_')) continue;
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      const id = /id:\s*'([^']+)'/.exec(text)?.[1];
      if (!id) throw new Error(`${relative(ROOT, path)} 에 id 가 없다`);
      const expected = `${id}.ts`;
      if (file !== expected) {
        // **파일 이름 = 악기 id.** 다르면 파일을 찾을 때 헤매고, 지울 때 남는다
        throw new Error(`${relative(ROOT, path)}: 파일 이름이 id('${id}') 와 다르다`);
      }
      rows.push({ family, id, file });
    }
  }
  return rows;
}

function render(rows) {
  const ident = (id) => id.replace(/[^a-zA-Z0-9]/g, '_');
  const imports = rows
    .map((r) => `import { definition as ${ident(r.id)} } from './defs/${r.family}/${r.id}.ts';`)
    .join('\n');
  const list = rows.map((r) => `  ${ident(r.id)},`).join('\n');

  return `/**
 * **자동 생성 파일 — 손으로 고치지 말 것.**
 *
 * \`npm run instruments:index\` 가 \`defs/\` 폴더를 읽어 만든다.
 * 악기를 추가하려면 \`defs/<계열>/<id>.ts\` 를 만들고 이 명령을 돌린다.
 * CI 가 이 파일이 최신인지 검사하므로, 잊으면 거기서 걸린다.
 *
 * 악기 ${rows.length}개.
 */

import type { InstrumentDefinition } from './types.ts';

${imports}

export const BUILT_IN_INSTRUMENTS: readonly InstrumentDefinition[] = [
${list}
];
`;
}

const rows = collect();
const next = render(rows);
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* 아직 없음 */
  }
  if (current !== next) {
    console.error(
      `악기 인덱스가 낡았다 (${rows.length}개). \`npm run instruments:index\` 를 돌리고 커밋할 것`,
    );
    process.exit(1);
  }
  console.log(`악기 인덱스 최신 — ${rows.length}개`);
} else {
  writeFileSync(OUT, next);
  console.log(`악기 인덱스 생성 — ${rows.length}개`);
}

// 화면 시안 캡처 — 실제 앱을 원하는 상태로 만든 뒤 **고칠 수 있는 SVG**(상자·글자·아이콘이
// 레이어로 살아 있는 것)와 PNG 로 떠서 `design/screens/` 에 둔다. FigCraft 는 이 SVG 를
// 가져와 화면별 페이지를 만든다 (`design/README.md`).
//
//   npm run dev                         (다른 터미널)
//   npm run design:capture [이름…]      이름을 주면 그 화면만
//
// 화면 상태는 아래 SCREENS 에 코드로 적는다 — 손으로 눌러 만든 상태는 다시 못 만든다.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { byLabel, byText, byTitle, launch, sleep } from './lib/chrome.mjs';

const R = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const { demoProject } = await import(R('./lib/demo-project.ts'));
const { serializeProject } = await import(R('../src/model/persistence.ts'));

const URL_APP = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const OUT = R('../design/screens/');
const DOM2SVG = readFileSync(R('./lib/dom2svg.js'), 'utf8');

/** 화면 목록. `area` 는 `LOGIC_PARITY.md` 3-1 의 영역 번호 */
export const SCREENS = [
  {
    name: 'a01-arrange-section', area: 1, title: '편곡 — 구간 고름 (복제·이동·삭제)',
    run: async (b) => { await b.clickEl(`document.querySelector('[data-global=sections] [data-item]:nth-of-type(3)')`); },
  },
  {
    name: 'a01-arrange-chord', area: 1, title: '편곡 — 코드 고름',
    run: async (b) => { await b.clickEl(`document.querySelectorAll('[data-global=chords] [data-item]')[5]`); },
  },
  {
    name: 'a01-global-bar', area: 1, title: '글로벌 트랙 — 마디 박자·조성 변화',
    run: async (b) => {
      await b.clickEl(`document.querySelector('[data-bar="13"]')`);
      await b.choose(byLabel('박자 변화'), '6/8');
      await sleep(200);
      await b.clickEl(`document.querySelector('[data-bar="13"]')`);
    },
  },
];

async function capture(b, screen) {
  // 매번 같은 곡으로 시작한다
  const seed = JSON.stringify(serializeProject(demoProject()));
  await b.goto('about:blank', 100);
  await b.goto(URL_APP, 1200);
  await b.ev(`localStorage.setItem('project-autosave-v1', ${seed}); 'ok'`);
  await b.goto(URL_APP, 2500);
  await screen.run(b);
  await sleep(500);
  const svg = await b.ev(DOM2SVG);
  writeFileSync(`${OUT}${screen.name}.svg`, svg);
  const shot = await b.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}${screen.name}.png`, Buffer.from(shot.data, 'base64'));
  return svg.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT, { recursive: true });
  const wanted = process.argv.slice(2);
  const list = wanted.length ? SCREENS.filter((s) => wanted.some((w) => s.name.startsWith(w))) : SCREENS;
  const b = await launch({ port: 9335 });
  let failed = 0;
  try {
    for (const screen of list) {
      try {
        const bytes = await capture(b, screen);
        console.log(`✓ ${screen.name}  ${(bytes / 1024).toFixed(0)}KB  ${screen.title}`);
      } catch (err) {
        failed++;
        console.log(`✗ ${screen.name}  ${err.message}`);
      }
    }
    if (b.errors.length) console.log('페이지 예외:\n  ' + b.errors.join('\n  '));
  } finally {
    b.close();
  }
  // 목록을 함께 남긴다 — FigCraft 로 가져올 때 이름·제목·영역을 여기서 읽는다
  writeFileSync(`${OUT}index.json`, JSON.stringify(SCREENS.map(({ name, area, title }) => ({ name, area, title })), null, 2));
  process.exit(failed ? 1 : 0);
}

export { byText, byTitle };

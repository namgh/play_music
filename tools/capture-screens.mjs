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
  {
    name: 'a02-track-stack', area: 2, title: '트랙 — 스택(드럼) · 보호(베이스) · 카운트인',
    run: async (b) => {
      await b.clickEl(byLabel('킥 선택'));
      await b.choose(byLabel('트랙 스택'), 'new');
      await sleep(200);
      await b.clickEl(byLabel('스네어 선택'));
      const stackId = await b.ev(`document.querySelector('[data-stack]').dataset.stack`);
      await b.choose(byLabel('트랙 스택'), stackId);
      await sleep(200);
      await b.clickEl(byLabel('베이스 선택'));
      await b.clickEl(byTitle('고른 트랙을 보호합니다'));
      await b.clickEl(byLabel('카운트인'));
    },
  },
  {
    name: 'a02-track-stack-collapsed', area: 2, title: '트랙 — 스택 접힘 · 숨긴 트랙 보기',
    run: async (b) => {
      await b.clickEl(byLabel('킥 선택'));
      await b.choose(byLabel('트랙 스택'), 'new');
      await sleep(200);
      await b.clickEl(byLabel('스네어 선택'));
      const stackId = await b.ev(`document.querySelector('[data-stack]').dataset.stack`);
      await b.choose(byLabel('트랙 스택'), stackId);
      await sleep(200);
      await b.clickEl(`document.querySelector('[aria-label$="접기"]')`);
      await b.clickEl(byLabel('패드 선택'));
      await b.clickEl(byTitle('고른 트랙을 목록에서 숨깁니다'));
    },
  },
  {
    name: 'a03-pianoroll-pitch-color', area: 3, title: '피아노 롤 — 음이름 색 · 기능 메뉴(스케일·레가토·성부 떼기)',
    run: async (b) => {
      await b.clickEl(byLabel('로즈 선택'));
      await b.choose(byLabel('음 색'), 'pitch');
      await sleep(200);
    },
  },
  {
    name: 'a03-pianoroll-velocity-color', area: 3, title: '피아노 롤 — 세기 색 · 음 고름',
    run: async (b) => {
      await b.clickEl(byLabel('어쿠스틱 기타 선택'));
      await b.choose(byLabel('음 색'), 'velocity');
      await sleep(200);
      await b.clickEl(`document.querySelectorAll('.cursor-crosshair [role=button]')[3]`);
    },
  },
  {
    name: 'a04-automation', area: 4, title: '오토메이션 — 트랙 아래 곡선 레인 · 대상(볼륨/팬/이펙트) · 모드',
    run: async (b) => {
      await b.clickEl(byLabel('베이스 오토메이션'));
      await sleep(200);
      const lane = `document.querySelector('[data-automation="베이스:volume"] > div:last-child')`;
      for (const [fx, fy] of [[0.02, 0.1], [0.25, 0.2], [0.5, 0.75], [0.62, 0.3], [0.9, 0.1]]) await b.clickIn(lane, fx, fy);
      await b.clickEl(byLabel('스네어 오토메이션'));
      await b.choose(byLabel('스네어 오토메이션 대상'), 'pan');
      await sleep(200);
      const pan = `document.querySelector('[data-automation="스네어:pan"] > div:last-child')`;
      for (const [fx, fy] of [[0.05, 0.5], [0.3, 0.1], [0.55, 0.9], [0.8, 0.5]]) await b.clickIn(pan, fx, fy);
      await b.clickEl(`document.querySelector('[aria-label="스네어 오토메이션 모드"] [role=radio]:nth-child(3)')`);
    },
  },
  {
    name: 'a05-mixer', area: 5, title: '믹서 — 채널 스트립 · 인서트 · 센드 · 버스(Aux) · VCA · 그룹',
    run: async (b) => {
      await b.clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][1]`);
      await sleep(400);
      await b.clickEl(byText('＋ 버스'));
      await b.clickEl(byText('＋ VCA'));
      await b.clickEl(byText('＋ 그룹'));
      await sleep(200);
      await b.choose(`document.querySelector('[data-strip="버스 1"] [aria-label="이펙트 추가"]')`, 'reverb');
      await sleep(200);
      for (const name of ['킥', '스네어']) {
        await b.choose(byLabel(`${name} 그룹`), await b.ev(`document.querySelector('[aria-label="${name} 그룹"] option:nth-child(2)').value`));
        await b.choose(byLabel(`${name} VCA`), await b.ev(`document.querySelector('[aria-label="${name} VCA"] option:nth-child(2)').value`));
      }
      await b.ev(`(() => { for (const n of ['어쿠스틱 기타', '로즈', '패드']) { const e = document.querySelector('[aria-label="' + n + ' → 버스 1 센드"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '0.4'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); } })()`);
      await sleep(300);
      await b.choose(`document.querySelector('[data-strip="베이스"] [aria-label="이펙트 추가"]')`, 'compressor');
      await sleep(300);
    },
  },
  {
    name: 'a06-effects', area: 6, title: '이펙트 — 13종(리미터·로우컷·오토 필터·디스토션·코러스·플랜저·페이저·트레몰로·스테레오 폭 추가)',
    run: async (b) => {
      await b.clickEl(`[...document.querySelectorAll('nav[aria-label="화면"] button')][1]`);
      await sleep(400);
      const add = (strip, type) => b.choose(`document.querySelector('[data-strip="${strip}"] [aria-label="이펙트 추가"]')`, type);
      for (const t of ['highpass', 'distortion', 'autofilter']) { await add('어쿠스틱 기타', t); await sleep(150); }
      for (const t of ['chorus', 'width']) { await add('로즈', t); await sleep(150); }
      for (const t of ['phaser', 'tremolo']) { await add('패드', t); await sleep(150); }
      await add('마스터', 'limiter');
      await sleep(150);
      await b.clickEl(`[...document.querySelectorAll('[data-strip="어쿠스틱 기타"] button')].find((x) => x.textContent.includes('디스토션'))`);
      await sleep(200);
    },
  },
  {
    name: 'a07-export', area: 7, title: '내보내기 — 범위(곡·반복·구간) · 24/16bit+디더 · 48/44.1k · 꼬리 · 노멀라이즈 · 스템 ZIP · 측정(LUFS·트루피크)',
    run: async (b) => {
      await b.clickEl(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '내보내기')`);
      await sleep(200);
      await b.ev(`(() => { const box = [...document.querySelectorAll('[role=dialog] input[type=checkbox]')][1]; box.click(); })()`);
      await b.clickEl(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '바운스')`);
      for (let i = 0; i < 60; i++) {
        if (await b.ev(`!!document.querySelector('[aria-label="내보낸 파일 측정"]')`)) break;
        await sleep(500);
      }
    },
  },
  {
    name: 'a08-browser', area: 8, title: '브라우저 — 검색·분류·미리 듣기·이 트랙에/새 트랙·내 음색(패치)',
    run: async (b) => {
      await b.clickEl(byLabel('어쿠스틱 기타 선택'));
      await b.clickEl(`[...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.includes('브라우저'))`);
      await b.clickEl(`[...document.querySelectorAll('[aria-label="분류"] button')].find((x) => x.textContent === '기타')`);
      await b.ev(`localStorage.setItem('user-patches-v1', JSON.stringify([{ id: 'pat_1', name: '따뜻한 로즈', instrumentId: 'electric-piano-rhodes', toneId: 'default', toneParams: null, savedAt: 1 }, { id: 'pat_2', name: '밝은 스트럼', instrumentId: 'acoustic-guitar', toneId: 'default', toneParams: null, savedAt: 0 }]))`);
      await b.clickEl(`[...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.includes('음 편집'))`);
      await b.clickEl(`[...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.includes('브라우저'))`);
      await sleep(200);
    },
  },
  {
    name: 'a09-play-surface', area: 9, title: '연주 — 화면 건반 · 자판 연주(A~\', Z/X 옥타브, C/V 세기) · 스텝 입력(Shift 화음, Tab 쉼표)',
    run: async (b) => {
      await b.clickEl(byLabel('패드 선택'));
      await b.clickEl(byLabel('건반'));
      await b.clickEl(`document.querySelector('[data-play-surface] button[aria-pressed]')`);
      await b.ev(`document.activeElement?.blur(); 'ok'`);
      for (const code of ['KeyA', 'KeyD', 'KeyG', 'KeyH']) {
        await b.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: code.slice(3).toLowerCase() });
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: code.slice(3).toLowerCase() });
        await sleep(150);
      }
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyJ', key: 'j' });
      await sleep(200);
    },
  },
  {
    name: 'a10-event-list', area: 10, title: '이벤트 목록 — 마디·박·틱·음·센트·길이·세기를 숫자로 · MIDI 변환 줄',
    run: async (b) => {
      await b.clickEl(byLabel('어쿠스틱 기타 선택'));
      await b.clickEl(`[...document.querySelectorAll('[aria-label="편집기 보기"] button')].find((x) => x.textContent === '이벤트 목록')`);
      await sleep(200);
      await b.clickEl(`document.querySelector('[data-note-row="2"] td')`);
      await sleep(200);
    },
  },
  {
    name: 'a11-step-sequencer', area: 11, title: '스텝 시퀀서 — 드럼 트랙들이 한 판(줄 = 트랙) · 강세·래칫·게이트',
    run: async (b) => {
      await b.clickEl(byLabel('킥 선택'));
      await b.clickEl(`[...document.querySelectorAll('[aria-label="편집기 보기"] button')].find((x) => x.textContent === '스텝')`);
      await sleep(200);
      for (const i of [6, 14]) await b.clickEl(`document.querySelector('[aria-label="스네어 ${i}칸"]')`);
      await b.clickEl(`[...document.querySelectorAll('[data-step-sequencer] button')].find((x) => x.getAttribute('aria-label') === '스네어 13칸 켜짐')`);
      await sleep(200);
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
        // 화면 하나가 멈추면 나머지를 못 뜬다 — 30초에 끊는다
        const once = () => Promise.race([
          capture(b, screen),
          sleep(30000).then(() => { throw new Error('30초 안에 끝나지 않음'); }),
        ]);
        // 헤드리스 Chrome 이 가끔 탐색에 답하지 않는다 — 한 번 더 해 본다
        const bytes = await once().catch((err) => { console.log(`  … ${screen.name} 다시 (${err.message})`); return once(); });
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

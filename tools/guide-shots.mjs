// 사용 가이드용 화면 — 실제 앱을 예제 곡으로 띄우고, **설명할 자리에 번호를 붙여** 찍는다.
//
//   npm run dev              (다른 터미널)
//   node tools/guide-shots.mjs [이름…] [--probe]
//
// 결과는 docs/guide/ 에 PNG 로 남는다. 번호의 뜻은 docs/GUIDE.md 가 적는다 (STEPS 의 pins 와 같은 순서).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { launch, sleep } from './lib/chrome.mjs';
import { DEMO_SONGS } from '../src/model/songs.ts';
import { serializeProject } from '../src/model/persistence.ts';

const R = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const URL_APP = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const OUT = R('../docs/guide/');
const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const wanted = args.filter((a) => !a.startsWith('--'));

const btn = (t) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(t)})`;
const btnHas = (t) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(t)}))`;
const title = (t) => `[...document.querySelectorAll('button,select,input,label,span,div')].find((b) => (b.title || '').includes(${JSON.stringify(t)}))`;
const aria = (t) => `document.querySelector(${JSON.stringify(`[aria-label="${t}"]`)})`;
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
/** 여러 요소를 한 상자로 */
const span = (...sels) => `(() => { const els = [${sels.join(',')}].filter(Boolean); if (!els.length) return null; const rs = els.map((e) => e.getBoundingClientRect()); const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top)); return { getBoundingClientRect: () => ({ left: x, top: y, right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) }) }; })()`;
const VIEW = (i) => `[...document.querySelectorAll('nav[aria-label="화면"] button')][${i}]`;

/** 번호표를 화면에 그린다 — 상자 테두리 + 왼쪽 위 번호. 못 찾은 것은 이름을 돌려준다 */
const drawPins = (pins) => `(() => {
  document.querySelectorAll('[data-guide-pin]').forEach((e) => e.remove());
  const missing = [];
  const make = (css) => { const d = document.createElement('div'); d.dataset.guidePin = '1'; d.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;' + css; document.body.appendChild(d); return d; };
  ${JSON.stringify(pins.map((p) => p.sel))}.forEach((sel, i) => {
    let e = null; try { e = (0, eval)(sel); } catch (err) { e = null; }
    if (!e) { missing.push(i + 1); return; }
    let r = e.getBoundingClientRect(); r = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    // 스크롤되는 칸 안의 것은 보이는 만큼만 두른다
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      const o = getComputedStyle(a); if (!/(auto|scroll|hidden)/.test(o.overflowX + o.overflowY)) continue;
      const c = a.getBoundingClientRect(); r = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
    }
    const pad = 4; const x = Math.max(2, r.left - pad), y = Math.max(2, r.top - pad);
    const w = Math.min(innerWidth - 2, r.right + pad) - x, h = Math.min(innerHeight - 2, r.bottom + pad) - y;
    make('left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;border:2.5px solid #ff2d75;border-radius:10px;box-shadow:0 0 0 2px rgba(255,255,255,.85)');
    const b = make('left:' + Math.max(2, x - 11) + 'px;top:' + Math.max(2, y - 11) + 'px;width:24px;height:24px;border-radius:12px;background:#ff2d75;color:#fff;font:700 13px/24px system-ui;text-align:center;box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.35)');
    b.textContent = String(i + 1);
  });
  return missing;
})()`;

const openSong = async (b, id = 'first-snow-night', { globals = true } = {}) => {
  const text = serializeProject(DEMO_SONGS.find((s) => s.id === id).build());
  await b.goto(URL_APP, 1200);
  await b.ev(`(() => { localStorage.clear(); localStorage.setItem('project-autosave-v1', ${JSON.stringify(text)}); localStorage.setItem('ui-globals', ${JSON.stringify(globals ? '1' : '0')}); return 1; })()`);
  await b.goto(URL_APP, 2500);
  // 알림은 닫는다
  await b.ev(`[...document.querySelectorAll('[data-toast] button')].forEach((x) => x.click())`);
};
const closeToast = (b) => b.ev(`[...document.querySelectorAll('[data-toast] button')].forEach((x) => x.click())`);
/** 타임라인에서 이름이 `name` 으로 시작하는 n번째 클립을 누른다 */
const clip = (name, n = 0) => `[...document.querySelectorAll('[role=button],button,div')].filter((e) => e.children.length < 6 && e.textContent.trim().startsWith(${JSON.stringify(name)}) && e.getBoundingClientRect().height > 20 && e.getBoundingClientRect().height < 60 && e.getBoundingClientRect().width > 60)[${n}]`;

export const STEPS = [];
const step = (name, run, pins) => STEPS.push({ name, run, pins });


const clipOf = (track, name) => `(() => { const row = document.querySelector(${JSON.stringify(`[aria-label="${track} 악기"]`)}); if (!row) return null; const y = row.getBoundingClientRect().top; return [...document.querySelectorAll('button')].find((b) => b.title === '끌어서 옮깁니다' && b.textContent.startsWith(${JSON.stringify(name)}) && Math.abs(b.getBoundingClientRect().top - y) < 30); })()`;
const MEL = '멜로디 (가사)';
const selectClip = async (b, track = MEL, name = '코러스') => { await b.clickEl(clipOf(track, name)); await sleep(300); };
const editorView = async (b, name) => { await b.clickEl(btn(name)); await sleep(400); };
const fileMenu = async (b, item) => { await b.clickEl(title('파일 — 저장')); await sleep(200); await b.clickEl(btnHas(item)); await sleep(500); };

step('01-overview', async (b) => { await openSong(b); await selectClip(b); await editorView(b, '피아노 롤'); }, [
  { sel: q('nav[aria-label="화면"]') },
  { sel: span(title('맨 앞으로'), title('반복 구간')) },
  { sel: span(aria('재생 위치'), aria('곡 설정')) },
  { sel: span(title('되돌리기'), aria('계정')) },
  { sel: btn('내보내기') },
  { sel: span(aria(`${MEL} 악기`), aria(`${MEL} 오토메이션`)) },
  { sel: clipOf(MEL, '코러스') },
  { sel: q('.cursor-crosshair') },
  { sel: span(btn('음 편집'), btn('브라우저')) },
]);

step('02-songs', async (b) => { await openSong(b); await fileMenu(b, '새 곡 · 최근 곡 · 버전'); }, [
  { sel: span(q('[data-template]'), `[...document.querySelectorAll('[data-template]')].pop()`) },
  { sel: span(q('[data-demo-song]'), `[...document.querySelectorAll('[data-demo-song]')].pop()`) },
]);

step('03-play', async (b) => { await openSong(b); await selectClip(b); }, [
  { sel: title('커서부터 재생') },
  { sel: span(title('1마디'), title('32마디')) },
  { sel: aria('재생 위치') },
  { sel: title('메트로놈') },
  { sel: title('반복 구간') },
  { sel: span(title('되돌리기'), title('다시 실행')) },
]);

step('04-tracks', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); }, [
  { sel: span(btn('＋ 트랙'), btn('＋ 오디오')) },
  { sel: aria(`${MEL} 악기`) },
  { sel: span(`(() => { const s = ${aria(`${MEL} 악기`)}; return s.parentElement.querySelectorAll('button')[1] ?? null; })()`, `(() => { const s = ${aria(`${MEL} 악기`)}; const y = s.getBoundingClientRect().top; return [...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === 'S' && Math.abs(x.getBoundingClientRect().top - y) < 20)[0]; })()`, `(() => { const s = ${aria(`${MEL} 악기`)}; const y = s.getBoundingClientRect().top; return [...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === 'M' && Math.abs(x.getBoundingClientRect().top - y) < 20)[0]; })()`) },
  { sel: aria(`${MEL} 레벨`) },
  { sel: aria(`${MEL} 오토메이션`) },
  { sel: clipOf(MEL, '코러스') },
  { sel: span(aria('클립 메뉴'), aria('트랙 메뉴')) },
]);

step('05-clip-menu', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await b.clickEl(aria('클립 메뉴')); await sleep(300); }, [
  { sel: q('[role=menu]') },
]);
step('06-track-menu', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await b.clickEl(aria('트랙 메뉴')); await sleep(300); }, [
  { sel: q('[role=menu]') },
]);

step('07-global', async (b) => { await openSong(b); await b.clickEl(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '코러스' && x.getBoundingClientRect().top < 165)`); await sleep(300); }, [
  { sel: btn('글로벌') },
  { sel: span(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '인트로' && x.getBoundingClientRect().top < 165)`, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '아웃트로' && x.getBoundingClientRect().top < 165)`) },
  { sel: span(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '인트로' && x.getBoundingClientRect().top > 165)`, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '아웃트로' && x.getBoundingClientRect().top > 165)`) },
  { sel: span(btn('Am'), `[...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === 'C' && x.getBoundingClientRect().top > 190 && x.getBoundingClientRect().top < 225).pop()`) },
  { sel: title('BPM — 위아래로 끌어 바꾸기') },
  { sel: btn('음에서 찾기') },
]);

step('08-pianoroll', async (b) => {
  await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await editorView(b, '피아노 롤');
  await b.clickEl(`document.querySelector('.cursor-crosshair [role=button]')`); await sleep(300);
}, [
  { sel: span(btn('피아노 롤'), btn('악보')) },
  { sel: span(aria('편집 메뉴'), aria('기능 메뉴')) },
  { sel: q('.cursor-crosshair [role=button]') },
  { sel: q('.cursor-crosshair') },
  { sel: btn('음 편집') },
]);

step('09-fn-menu', async (b) => {
  await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await editorView(b, '피아노 롤');
  await b.clickEl(aria('기능 메뉴')); await sleep(300);
}, [{ sel: q('[role=menu]') }]);

step('10-steps', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b, '킥', '코러스'); await editorView(b, '스텝'); }, [
  { sel: btn('스텝') },
  { sel: span(q('[data-step-row]'), `[...document.querySelectorAll('[data-step-row]')].pop()`) },
]);

step('11-events', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await editorView(b, '이벤트 목록'); }, [
  { sel: span(btn('+옥타브'), btn('음높이 뒤집기')) },
  { sel: q('[data-note-row="0"]') },
]);

step('12-score', async (b) => {
  await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await editorView(b, '악보');
  await b.clickEl(q('[data-note-head]')); await sleep(300);
}, [
  { sel: q('[data-staff]') },
  { sel: aria('가사') },
  { sel: span(btn('MusicXML 내보내기'), btn('인쇄')) },
]);

step('13-controls', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await b.clickEl(btn('컨트롤')); await sleep(400); }, [
  { sel: btn('컨트롤') },
  { sel: aria('MIDI 이펙트 추가') },
]);

step('14-browser', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await b.clickEl(btn('브라우저')); await sleep(500); }, [
  { sel: btn('브라우저') },
  { sel: q('[data-instrument]') },
]);

step('15-keys', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await selectClip(b); await b.clickEl(aria('건반')); await sleep(500); }, [
  { sel: aria('건반') },
  { sel: aria('연주 방식') },
  { sel: aria('화면 건반') },
  { sel: aria('녹음') },
  { sel: aria('바꿔 메뉴') },
]);

step('16-mixer', async (b) => { await openSong(b); await b.clickEl(VIEW(1)); await sleep(700); }, [
  { sel: VIEW(1) },
  { sel: q('[data-strip]') },
  { sel: `[...document.querySelectorAll('[data-strip]')].pop()` },
]);

step('17-automation', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await b.clickEl(aria(`${MEL} 오토메이션`)); await sleep(500); }, [
  { sel: aria(`${MEL} 오토메이션`) },
  { sel: q('[data-automation]') },
]);

step('18-assistant', async (b) => { await openSong(b); await b.clickEl(VIEW(3)); await sleep(600); }, [
  { sel: VIEW(3) },
  { sel: q('[data-player]') },
  { sel: btn('드럼 만들기') },
  { sel: aria('라우드니스 목표') },
]);

step('19-export', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await b.clickEl(btn('내보내기')); await sleep(400); }, [
  { sel: aria('내보낼 범위') },
  { sel: aria('파일 형식') },
  { sel: span(aria('비트 깊이'), aria('표본율')) },
  { sel: span(...[0, 1, 2].map((i) => `document.querySelectorAll('[role=dialog][aria-label="내보내기"] input[type=checkbox]')[${i}]?.parentElement`)) },
  { sel: `[...document.querySelectorAll('[role=dialog][aria-label="내보내기"] button')].find((x) => x.className.includes('bg-cta'))` },
]);

step('20-file-menu', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await b.clickEl(title('파일 — 저장')); await sleep(300); }, [
  { sel: btnHas('파일로 저장') },
  { sel: span(btn('MIDI 내보내기'), btnHas('영상 가져오기')) },
]);

step('21-palette', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await b.key('k', 'KeyK', 4); await sleep(400); await b.send('Input.insertText', { text: '반복' }); await sleep(300); }, [
  { sel: `document.activeElement` },
  { sel: `document.activeElement.parentElement.parentElement.querySelector('button')` },
]);

step('22-settings', async (b) => { await openSong(b, 'first-snow-night', { globals: false }); await b.clickEl(aria('설정')); await sleep(400); await b.clickEl(`[...document.querySelectorAll('[role=tab]')][2]`); await sleep(300); }, [
  { sel: `document.querySelector('[role=tab]').parentElement` },
  { sel: `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '바꾸기')` },
  { sel: btn('전부 기본값') },
]);

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT, { recursive: true });
  const list = STEPS.filter((s) => !wanted.length || wanted.some((w) => s.name.startsWith(w)));
  const b = await launch({ port: 9336, width: 1440, height: 900 });
  let failed = 0;
  try {
    for (const s of list) {
      try {
        await s.run(b);
        await sleep(400);
        if (PROBE) {
          const dump = await b.ev(`[...document.querySelectorAll('button,select,[role=tab],[role=dialog],nav,input')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.top < innerHeight; }).map((e) => { const r = e.getBoundingClientRect(); return e.tagName[0] + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' [' + (e.getAttribute('aria-label') || '') + '] {' + (e.title || '').slice(0, 30) + '} ' + (e.tagName === 'SELECT' ? '' : e.textContent.trim().slice(0, 24)); }).join('\\n')`);
          writeFileSync(`${OUT}${s.name}.probe.txt`, dump);
        }
        const over = await b.ev(`(() => { const w = document.documentElement.scrollWidth - innerWidth; scrollTo(0, 0); document.querySelectorAll('*').forEach((e) => { if (e.scrollLeft && e === document.scrollingElement) e.scrollLeft = 0; }); return w; })()`);
        if (over > 0) console.log(`  (화면이 ${over}px 넘침)`);
        const missing = await b.ev(drawPins(s.pins));
        await sleep(150);
        const shot = await b.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(`${OUT}${s.name}.png`, Buffer.from(shot.data, 'base64'));
        await b.ev(`document.querySelectorAll('[data-guide-pin]').forEach((e) => e.remove())`);
        console.log(`${missing.length ? '△' : '✓'} ${s.name}${missing.length ? '  못 찾은 번호: ' + missing.join(',') : ''}`);
        if (missing.length) failed++;
      } catch (err) { failed++; console.log(`✗ ${s.name}  ${String(err.message).slice(0, 200)}`); }
    }
    if (b.errors.length) console.log('페이지 예외:\n  ' + [...new Set(b.errors)].join('\n  ').slice(0, 600));
  } finally { b.close(); }
  process.exit(failed ? 1 : 0);
}

export { btn, btnHas, title, aria, q, span, VIEW, openSong, closeToast, clip };

// AI 도우미 시안 — 실제 앱 화면 위에 **아직 없는 칸을 그려 넣고** 찍는다 (src 는 건드리지 않는다).
// 세 가지 자리를 견준다: A 오른쪽 칸의 탭 · B 편집기 아래 명령 줄 · C 고른 음 옆의 말풍선.
//
//   npm run dev  →  node tools/mock-ai.mjs
//
// 결과: design/screens/a25-ai-*.png·svg, design/web/*.png
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launch, sleep } from './lib/chrome.mjs';
import { btn, openSong } from './guide-shots.mjs';

const R = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const OUT = R('../design/screens/');
const DOM2SVG = readFileSync(R('./lib/dom2svg.js'), 'utf8');

const CSS = `
.ai, .ai * { box-sizing: border-box; font-family: var(--font-sans); }
.ai { color: var(--color-ink); font-size: 13px; line-height: 1.5; }
.ai .ctx { display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:10px; background: var(--color-panel); font-size:12px; color: var(--color-ink-2); }
.ai .ctx b { color: var(--color-ink); font-weight:600; }
.ai .dot { width:8px; height:8px; border-radius:4px; background: var(--color-t5); flex:none; }
.ai .me { align-self:flex-end; max-width:86%; background: var(--color-ink); color: var(--color-body); padding:8px 12px; border-radius:14px 14px 4px 14px; }
.ai .bot { align-self:flex-start; max-width:94%; border:1px solid var(--color-rule); background: var(--color-body); padding:10px 12px; border-radius:14px 14px 14px 4px; display:flex; flex-direction:column; gap:8px; }
.ai .plan { background: var(--color-screen); color: var(--color-sink); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:6px; }
.ai .plan small { color: var(--color-sink-2); font-size:11px; }
.ai .plan .big { font-family: var(--font-num); font-size:22px; color: var(--color-acc); letter-spacing:.02em; }
.ai .row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.ai .btn { height:30px; padding:0 12px; border-radius:15px; border:1px solid var(--color-rule); background: var(--color-body); color: var(--color-ink); font-size:12px; display:inline-flex; align-items:center; gap:6px; }
.ai .btn.go { background: var(--color-cta); color: var(--color-cta-ink); border-color: transparent; font-weight:600; }
.ai .btn.dark { background: var(--color-screen-2); color: var(--color-sink); border-color: var(--color-grid-2); }
.ai .chip { height:26px; padding:0 10px; border-radius:13px; background: var(--color-panel); color: var(--color-ink-2); font-size:12px; display:inline-flex; align-items:center; }
.ai .done { color: var(--color-ink-3); font-size:11px; display:flex; gap:6px; align-items:center; }
.ai .ok { width:14px; height:14px; border-radius:7px; background: var(--color-ok); color:#06301f; font-size:10px; display:inline-grid; place-items:center; font-weight:700; }
.ai .inp { display:flex; align-items:center; gap:8px; border:1px solid var(--color-rule); border-radius:22px; padding:6px 6px 6px 14px; background: var(--color-body); }
.ai .inp span { flex:1; color: var(--color-ink-3); }
.ai .send { width:32px; height:32px; border-radius:16px; background: var(--color-ink); color: var(--color-body); display:grid; place-items:center; font-size:14px; }
.ai .foot { display:flex; justify-content:space-between; color: var(--color-ink-3); font-size:11px; }
.ghost { position:fixed; z-index:50; border:1.5px dashed var(--color-acc); background: color-mix(in srgb, var(--color-acc) 22%, transparent); border-radius:3px; pointer-events:none; }
`;

const CHIPS = ['높게', '낮게', '빠르게', '느리게', '세게', '여리게', '박자 맞추기', '사람처럼'];
const chips = (list = CHIPS) => `<div class="row">${list.map((c) => `<span class="chip">${c}</span>`).join('')}</div>`;
const INPUT = (text = '고른 부분을 어떻게 바꿀까요?') => `<div class="inp"><span>${text}</span><i class="send">↑</i></div>`;
const PLAN = `<div class="plan"><small>바꿀 것 · 아직 적용 전</small><div class="row" style="align-items:baseline;gap:10px"><span class="big">+2 반음</span><span>코러스 멜로디 36음</span></div><small>C장조 안에서 조에 맞게 올립니다 · 17–24마디</small></div>`;

/** 고른 음 위로 "바뀔 자리" 를 흐리게 그린다 (2반음 = 두 줄 위) */
const ghosts = `(() => { const notes = [...document.querySelectorAll('.cursor-crosshair [role=button]')].slice(0, 14); const grid = document.querySelector('.cursor-crosshair').parentElement.getBoundingClientRect(); for (const n of notes) { const r = n.getBoundingClientRect(); if (r.top - 30 < grid.top || r.right > grid.right) continue; const g = document.createElement('div'); g.className = 'ghost'; g.dataset.mock = '1'; g.style.cssText = 'left:' + r.left + 'px;top:' + (r.top - 30) + 'px;width:' + r.width + 'px;height:' + r.height + 'px'; document.body.appendChild(g); } })()`;

const VARIANTS = [
  { name: 'a25-ai-a-tab', title: 'AI 시안 A — 오른쪽 칸의 넷째 탭 (대화가 남는다)', inject: `(() => {
      const tabs = ${btn('음 편집')}.parentElement; const col = tabs.parentElement;
      [...tabs.children].forEach((t) => { t.style.background = 'transparent'; t.style.boxShadow = 'none'; t.style.fontWeight = '400'; t.style.color = 'var(--color-ink-3)'; });
      const t = tabs.children[0].cloneNode(true); t.textContent = '✦ AI'; t.style.cssText = 'background:var(--color-body);box-shadow:0 1px 2px rgba(0,0,0,.12);font-weight:600;color:var(--color-ink)'; tabs.appendChild(t);
      [...col.children].forEach((c) => { if (c !== tabs) c.style.display = 'none'; });
      const p = document.createElement('div'); p.className = 'ai'; p.dataset.mock = '1';
      p.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:12px;height:calc(100vh - 150px)';
      p.innerHTML = \`
        <div class="ctx"><i class="dot"></i><span>고른 것 <b>코러스 · 멜로디 · 36음</b> · 17–24마디</span></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:10px;overflow:hidden">
          <div class="me">이 부분 조금만 높게 해 줄래?</div>
          <div class="bot"><span>2반음 올리면 후렴이 더 밝게 들립니다. 먼저 들어 보세요.</span>${PLAN}
            <div class="row"><span class="btn">▶ 미리 듣기</span><span class="btn go">적용</span><span class="btn">취소</span></div>
            <div class="done">다른 방법 · 한 옥타브 위로 · 3도 위에 화음 쌓기</div></div>
          <div class="done"><i class="ok">✓</i>적용했습니다 — ⌘Z 로 되돌립니다</div>
          <div class="me">여기는 좀 더 빠르게</div>
          <div class="bot"><span>어느 쪽인가요?</span>
            <div class="row"><span class="btn">템포를 124 → 132 로</span><span class="btn">음을 더 잘게 쪼개기</span></div></div>
        </div>
        ${chips()}
        ${INPUT()}
        <div class="foot"><span>음표와 코드만 보냅니다 · 녹음한 소리는 보내지 않습니다</span><span>크레딧 42</span></div>\`;
      col.appendChild(p);
    })()` },
  { name: 'a25-ai-b-bar', title: 'AI 시안 B — 편집기 아래 명령 줄 (바뀔 자리를 음 위에 겹쳐 보여 준다)', inject: `(() => {
      ${ghosts};
      const grid = document.querySelector('.cursor-crosshair').parentElement.getBoundingClientRect();
      const bar = document.createElement('div'); bar.className = 'ai'; bar.dataset.mock = '1';
      bar.style.cssText = 'position:fixed;z-index:60;left:120px;width:880px;bottom:26px;background:var(--color-body);border:1px solid var(--color-rule);border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.28);padding:12px;display:flex;flex-direction:column;gap:10px';
      bar.innerHTML = \`
        <div class="row" style="justify-content:space-between">
          <div class="ctx" style="background:transparent;padding:0"><i class="dot"></i><span><b>코러스 · 멜로디 · 36음</b> 을 <b style="color:var(--color-ink)">2반음 올립니다</b> — 노란 점선이 바뀔 자리입니다</span></div>
          <div class="row"><span class="btn">▶ 미리 듣기</span><span class="btn go">적용 ⏎</span><span class="btn">취소 Esc</span></div>
        </div>
        <div class="row" style="flex-wrap:nowrap"><div class="inp" style="flex:1"><span style="color:var(--color-ink)">이 부분 조금만 높게</span><i class="send">↑</i></div></div>
        <div class="row" style="justify-content:space-between">${chips(CHIPS.slice(0, 6))}<span class="done">⌘J 로 열고 닫기 · 크레딧 42</span></div>\`;
      document.body.appendChild(bar);
    })()` },
  { name: 'a25-ai-c-bubble', title: 'AI 시안 C — 고른 음 옆의 말풍선 (손이 가는 자리에서 바로)', inject: `(() => {
      const notes = [...document.querySelectorAll('.cursor-crosshair [role=button]')]; const r = notes[6].getBoundingClientRect();
      const b = document.createElement('div'); b.className = 'ai'; b.dataset.mock = '1';
      b.style.cssText = 'position:fixed;z-index:60;left:' + (r.right + 14) + 'px;top:' + (r.top - 150) + 'px;width:340px;background:var(--color-screen);color:var(--color-sink);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.4);padding:12px;display:flex;flex-direction:column;gap:10px';
      b.innerHTML = \`
        <div class="row" style="justify-content:space-between"><span style="color:var(--color-sink-2);font-size:12px">✦ 고른 36음을…</span><span style="color:var(--color-sink-3);font-size:11px">크레딧 42</span></div>
        <div class="row">\${${JSON.stringify(CHIPS)}.map((c, i) => '<span class="btn dark" style="' + (i === 0 ? 'background:var(--color-acc);color:var(--color-acc-ink);border-color:transparent;font-weight:600' : '') + '">' + c + '</span>').join('')}</div>
        <div class="inp" style="background:var(--color-screen-2);border-color:var(--color-grid-2)"><span style="color:var(--color-sink-2)">또는 말로 — "끝 음만 길게"</span><i class="send" style="background:var(--color-sink);color:var(--color-screen)">↑</i></div>
        <div class="row" style="justify-content:space-between"><span style="font-size:12px"><b style="font-family:var(--font-num);font-size:18px;color:var(--color-acc)">+2 반음</span></b> &nbsp;미리 보는 중</span><span class="row"><span class="btn dark">▶</span><span class="btn go">적용</span></span></div>\`;
      document.body.appendChild(b);
      ${ghosts};
    })()` },
];

const b = await launch({ port: 9338 });
try {
  for (const v of VARIANTS) {
    await openSong(b, 'first-snow-night', { globals: false });
    await b.clickEl(`(() => { const row = document.querySelector('[aria-label="멜로디 (가사) 악기"]'); const y = row.getBoundingClientRect().top; return [...document.querySelectorAll('button')].find((x) => x.title === '끌어서 옮깁니다' && x.textContent.startsWith('코러스') && Math.abs(x.getBoundingClientRect().top - y) < 30); })()`);
    await sleep(300);
    await b.clickEl(btn('피아노 롤')); await sleep(300);
    await b.clickEl(`document.querySelector('.cursor-crosshair [role=button]')`); await sleep(150);
    await b.key('a', 'KeyA', 4); await sleep(300);
    await b.ev(`(() => { const s = document.createElement('style'); s.dataset.mock = '1'; s.textContent = ${JSON.stringify(CSS)}; document.head.appendChild(s); })()`);
    await b.ev(v.inject);
    await sleep(300);
    writeFileSync(`${OUT}${v.name}.svg`, await b.ev(DOM2SVG));
    const shot = await b.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}${v.name}.png`, Buffer.from(shot.data, 'base64'));
    console.log('✓', v.name);
  }
  for (const page of ['landing', 'account']) {
    await b.goto(pathToFileURL(R(`../design/web/${page}.html`)).href, 1200);
    const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(R(`../design/web/${page}.png`), Buffer.from(shot.data, 'base64'));
    console.log('✓ web', page);
  }
  if (b.errors.length) console.log([...new Set(b.errors)].join('\n').slice(0, 500));
} finally { b.close(); }

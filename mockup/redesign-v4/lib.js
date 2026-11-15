// 공통: 아이콘(직접 그린 1.6 선), 도우미, 예시 곡 데이터 — 시안용. 곡·수치는 예시
const $ = s => document.querySelector(s);
// 색 묶음. ?theme=<키> 로 고른다. 모든 화면은 이 토큰만 쓴다
const THEMES = {
  // 처음 안: 크림 + 오크
  oak: { keyw: '#FBFAF4', keyb: '#1D1B17', name: '크림 · 오크', body: '#F3F1E6', alu: '#E3E0D4', alu2: '#D6D2C4', rule: '#CBC6B6', ink: '#1D1B17', ink2: '#57534A', ink3: '#8A8577',
    inv2: '#B5B0A0', inv3: '#45423A', screen: '#18181A', screen2: '#202022', grid: '#2B2B2E', grid2: '#353539', sInk: '#E9E6DC', sInk2: '#9C988C', sInk3: '#66635B',
    acc: '#C8782E', acc2: '#E7B271', accInk: '#1D1B17', cta: '#DCEF7C', ctaInk: '#1D1B17', ok: '#8DB59A', rec: '#C2412D',
    t: ['#8DB59A', '#D9A066', '#86A9C8', '#C98A7A', '#AC9FCB', '#DCC979'] },
  // A 전기 노랑: 흰 몸체 + 순도 높은 노랑 하나
  volt: { keyw: '#FFFFFF', keyb: '#111111', name: 'A · 전기 노랑', body: '#FFFFFF', alu: '#F4F4F5', alu2: '#E4E4E7', rule: '#E4E4E7', ink: '#0A0A0B', ink2: '#3F3F46', ink3: '#71717A',
    inv2: '#A1A1AA', inv3: '#3F3F46', screen: '#111113', screen2: '#19191C', grid: '#25252A', grid2: '#303036', sInk: '#EEEEEA', sInk2: '#9B9B97', sInk3: '#5E5E64',
    acc: '#FFD400', acc2: '#FFDD33', accInk: '#111111', cta: '#FFD400', ctaInk: '#111111', ok: '#3DDC97', rec: '#FF4B3E',
    t: ['#3DDC97', '#FF6B4A', '#4C9DFF', '#A07BFF', '#FF6FB5', '#2ED3DB'] },
  // B 애시드 라임: 그래파이트 몸체(어두운 쪽)
  acid: { keyw: '#D9D9D3', keyb: '#0D0D0F', name: 'B · 애시드 라임', body: '#1B1B1E', alu: '#26262A', alu2: '#323237', rule: '#38383E', ink: '#F1F1EC', ink2: '#B4B4AD', ink3: '#7C7C78',
    inv2: '#5A5A55', inv3: '#C9C9C2', screen: '#0D0D0F', screen2: '#141417', grid: '#202024', grid2: '#2B2B30', sInk: '#EEEEE8', sInk2: '#96968F', sInk3: '#55555B',
    acc: '#D8FF3C', acc2: '#E3FF6B', accInk: '#111111', cta: '#D8FF3C', ctaInk: '#111111', ok: '#3DDC97', rec: '#FF4B3E',
    t: ['#3DDC97', '#FF8A3D', '#4C9DFF', '#B18CFF', '#FF6FB5', '#36D6E7'] },
  // C 코발트: 종이 흰색 + 코발트 파랑, 노랑은 내보내기에만
  cobalt: { keyw: '#FFFFFF', keyb: '#0E1020', name: 'C · 코발트 + 노랑', body: '#F4F4F1', alu: '#E8E8E4', alu2: '#DADAD5', rule: '#CFCFC9', ink: '#0E1020', ink2: '#4A4C5A', ink3: '#878996',
    inv2: '#A2A4B4', inv3: '#2E3146', screen: '#0F1120', screen2: '#161929', grid: '#22263A', grid2: '#2D3247', sInk: '#ECEDF3', sInk2: '#9598AB', sInk3: '#5C6078',
    acc: '#3358FF', acc2: '#7D95FF', accInk: '#FFFFFF', cta: '#FFE03D', ctaInk: '#0E1020', ok: '#2FD08F', rec: '#FF4B3E',
    t: ['#2FD08F', '#FF8A3D', '#46B8FF', '#A98BFF', '#FF6FA8', '#FFD23F'] },
  // D 신호 주황: 따뜻한 회색 + 주황 하나
  signal: { keyw: '#FAF9F6', keyb: '#151413', name: 'D · 신호 주황', body: '#EEEDEA', alu: '#E1E0DC', alu2: '#D2D1CC', rule: '#C7C6C0', ink: '#151413', ink2: '#4D4B48', ink3: '#88857F',
    inv2: '#A6A39C', inv3: '#3C3A37', screen: '#141312', screen2: '#1C1B1A', grid: '#292826', grid2: '#34322F', sInk: '#EFEDE8', sInk2: '#9D9A93', sInk3: '#63605A',
    acc: '#FF5A1F', acc2: '#FF8A5C', accInk: '#FFFFFF', cta: '#FF5A1F', ctaInk: '#FFFFFF', ok: '#3DCB8C', rec: '#E5332A',
    t: ['#3DCB8C', '#FFB23F', '#4C9DFF', '#A88BFF', '#FF6FA0', '#35CFD9'] },
};
const QS = new URLSearchParams(location.search);
// ?c=<JSON> 로 개별 색을 덮어쓴다 (색 편집기에서 씀). t 는 [t1..t6]
const THEME = (() => { const base = THEMES[QS.get('theme') || 'volt'] || THEMES.volt; let ov = {};
  try { ov = JSON.parse(QS.get('c') || '{}'); } catch (e) {}
  const t = base.t.slice(); for (let i = 0; i < 6; i++) if (ov['t' + (i + 1)]) t[i] = ov['t' + (i + 1)];
  return { ...base, ...ov, t }; })();
const C = THEME;
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
(() => { const r = document.documentElement.style, map = { body: 'body', alu: 'alu', alu2: 'alu-2', rule: 'rule', ink: 'ink', ink2: 'ink-2', ink3: 'ink-3',
  inv2: 'inv-2', inv3: 'inv-3', screen: 'screen', screen2: 'screen-2', grid: 'grid', grid2: 'grid-2', sInk: 's-ink', sInk2: 's-ink-2', sInk3: 's-ink-3',
  acc: 'oak', acc2: 'oak-2', accInk: 'acc-ink', keyw: 'keyw', keyb: 'keyb', cta: 'lime', ctaInk: 'cta-ink', ok: 'ok', rec: 'rec' };
  for (const k in map) r.setProperty('--' + map[k], C[k]);
  C.t.forEach((v, i) => r.setProperty('--t' + (i + 1), v)); })();
function el(tag, cls, html, parent) {
  const e = document.createElement(tag); if (cls) e.className = cls;
  if (html != null) e.innerHTML = html; if (parent) parent.appendChild(e); return e;
}
const sv = (d, s = 16, w = 1.6) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  play: s => `<svg width="${s||14}" height="${s||14}" viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>`,
  stop: s => `<svg width="${s||12}" height="${s||12}" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>`,
  rec: s => `<svg width="${s||12}" height="${s||12}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>`,
  loop: s => sv('<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>', s),
  library: s => sv('<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><path d="M16.5 5.2l3.6-1 4 15.4-3.6 1z" transform="translate(-2 0)"/>', s),
  inspector: s => sv('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', s),
  editor: s => sv('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/><path d="M7 9h4M13 17h4"/>', s),
  mixer: s => sv('<path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1" fill="currentColor"/><rect x="10" y="7" width="4" height="3" rx="1" fill="currentColor"/><rect x="16" y="11" width="4" height="3" rx="1" fill="currentColor"/>', s),
  export: s => sv('<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>', s),
  plus: s => sv('<path d="M12 5v14M5 12h14"/>', s),
  search: s => sv('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', s),
  chev: s => sv('<path d="M9 6l6 6-6 6"/>', s),
  down: s => sv('<path d="M6 9l6 6 6-6"/>', s),
  folder: s => sv('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', s),
  string: s => sv('<path d="M3 12c3-6 6 6 9 0s6 6 9 0"/>', s),
  drum: s => sv('<ellipse cx="12" cy="8" rx="8" ry="3"/><path d="M4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8"/>', s),
  wave: s => sv('<path d="M3 12h2l2-6 3 12 3-9 2 5 2-2h4"/>', s),
  sample: s => sv('<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 15v-4M11 15V9M14 15v-6M17 15v-3"/>', s),
  pencil: s => sv('<path d="M4 20l4-1 11-11-3-3L5 16z"/>', s),
  pointer: s => sv('<path d="M5 3l14 8-6 1.5L10 19z"/>', s),
  scissors: s => sv('<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5L20 16M8 15.5L20 8"/>', s),
  magnet: s => sv('<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h3M15 8h3"/>', s),
  lock: s => sv('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', s),
  clock: s => sv('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', s),
  undo: s => sv('<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-2"/>', s),
  redo: s => sv('<path d="M15 7l5 5-5 5"/><path d="M20 12H9a5 5 0 0 0 0 10h2"/>', s),
};
const KINDS = { string: ['줄', ICON.string], modal: ['모달', ICON.wave], synth: ['신스', ICON.wave], sampler: ['샘플', ICON.sample], drum: ['합성 드럼', ICON.drum] };
// 예시 곡: 16마디. 클립 [시작마디, 길이]
const SONG = { title: '비 오는 새벽', bpm: 92, key: 'A minor', sig: '4/4', bars: 16,
  sections: [[0, '인트로'], [4, '벌스'], [8, '코러스'], [12, '브리지']],
  chords: [[0, 'Am'], [2, 'F'], [4, 'C'], [6, 'G'], [8, 'Am'], [10, 'F'], [12, 'Dm'], [14, 'E7']],
  tracks: [
    { name: '킥 · 스네어', kind: 'drum', inst: '합성 드럼 키트', col: 't6', clips: [[0, 4], [4, 4], [8, 8]] },
    { name: '베이스', kind: 'string', inst: '일렉 베이스 · 864mm', col: 't2', clips: [[0, 8], [8, 8]], sel: 1 },
    { name: '어쿠스틱 기타', kind: 'string', inst: '스틸 줄 기타', col: 't1', clips: [[4, 4], [8, 4], [12, 4]] },
    { name: '로즈', kind: 'modal', inst: '모달 · 전기 피아노', col: 't3', clips: [[0, 16]] },
    { name: '패드', kind: 'synth', inst: '버추얼 아날로그', col: 't5', clips: [[8, 8]] },
    { name: '보컬 샘플', kind: 'sampler', inst: '샘플러', col: 't4', clips: [[12, 4]] },
  ] };
// 편집 화면 공통 상단 바. on: 켜진 영역 버튼 이름 목록
function topbar(root, on, pos, status) {
  el('div', 'a top', null, root);
  el('div', 'a brand', 'RESONA <small>이름 임시</small>', root);
  el('div', 'a song', `${SONG.title} · 저장됨`, root);
  const k = el('div', 'a keys', null, root); Object.assign(k.style, { left: '228px', top: '16px' });
  [['library', 'L'], ['inspector', 'I'], ['editor', 'E'], ['mixer', 'X']].forEach(([n]) =>
    el('span', 'key ico' + (on.includes(n) ? ' on' : ''), ICON[n](16), k));
  const t = el('div', 'a tp', null, root); Object.assign(t.style, { left: '430px', top: '14px' });
  el('span', 'tb ico', ICON.stop(), t); el('span', 'tb ico play', ICON.play(), t); el('span', 'tb ico rec', ICON.rec(), t); el('span', 'tb ico', ICON.loop(16), t);
  const l = el('div', 'a lcd', `<span class="pos">${pos}</span><span class="sep"></span>
    <span class="f"><b>${SONG.bpm}</b><span>템포</span></span><span class="f"><b>Am</b><span>조성</span></span>
    <span class="f"><b>${SONG.sig}</b><span>박자</span></span><span class="sep"></span>
    <span class="f"><b>440.00</b><span>기준 Hz</span></span><span class="f"><b>18%</b><span>CPU</span></span>`, root);
  Object.assign(l.style, { left: '606px', top: '10px' });
  if (status) { const st = el('div', 'a status ' + status[0], `<i></i>${status[1]}`, root); Object.assign(st.style, { left: '972px', top: '22px' }); }
  const r = el('div', 'a', null, root); Object.assign(r.style, { left: '1196px', top: '14px', display: 'flex', gap: '8px' });
  el('span', 'tb ico', ICON.undo(16), r); el('span', 'tb ico', ICON.redo(16), r);
  el('span', 'export', ICON.export(16) + '내보내기', r);
}
// 노브: v 0–1. dark=검은 화면 위
function knob(v, size, label, val, dark) {
  const r = size / 2 - 4, c = size / 2, a0 = Math.PI * .75, a1 = a0 + Math.PI * 1.5 * v, end = Math.PI * 2.25;
  const P = a => [c + Math.cos(a) * r, c + Math.sin(a) * r];
  const arc = (from, to) => { const [x1, y1] = P(from), [x2, y2] = P(to); return `M${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
  const [px, py] = P(a1), fg = dark ? C.acc2 : C.ink, bg = dark ? C.grid2 : C.alu2;
  return `<div class="kn" style="width:${size + 16}px"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">
    <path d="${arc(a0, end)}" stroke="${bg}" stroke-width="3" stroke-linecap="round"/>
    ${v > .005 ? `<path d="${arc(a0, a1)}" stroke="${fg}" stroke-width="3" stroke-linecap="round"/>` : ''}
    <circle cx="${c}" cy="${c}" r="${r - 7}" fill="${dark ? C.screen2 : C.alu}" stroke="${dark ? C.grid2 : C.rule}"/>
    <line x1="${c}" y1="${c}" x2="${(c + (px - c) * .55).toFixed(1)}" y2="${(c + (py - c) * .55).toFixed(1)}" stroke="${fg}" stroke-width="2" stroke-linecap="round"/></svg>
    <b>${val}</b><span>${label}</span></div>`;
}
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

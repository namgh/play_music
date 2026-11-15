// v5 공통 틀: 상단 바 · 왼쪽 레일 · 노브. ../redesign-v4/lib.js 의 $, el, ICON, SONG, rng, rgba 를 쓴다
const sv2 = (d, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const HEX = ['#6FCFD6', '#F2A97E', '#86D3A4', '#82B4F0', '#B9A2EE', '#F0A3BE']; // 트랙 순서대로 (킥·베이스·기타·로즈·패드·보컬)
const RAIL = [
  ['arrange', '편곡', '<path d="M3 6h18M3 12h18M3 18h12"/>'],
  ['loops', 'Live Loops', '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'],
  ['mixer', '믹서', '<path d="M6 4v16M12 4v16M18 4v16"/><path d="M4 15h4M10 8h4M16 12h4"/>'],
  ['library', '브라우저', '<path d="M4 5h5v14H4zM11 5h4v14h-4zM17 6l3 .8-3.5 13.5-3-.8z"/>'],
  ['instrument', '악기', '<path d="M3 12c3-6 6 6 9 0s6 6 9 0"/>'],
  ['score', '악보', '<path d="M4 7h16M4 11h16M4 15h16"/><circle cx="9" cy="17" r="2.2"/><path d="M11.2 17V6"/>'],
  ['ai', 'AI', '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'],
];
function shell(root, o = {}) {
  el('div', 'a top', null, root);
  el('div', 'a wm', 'RESONA <small>이름 임시</small>', root);
  el('div', 'a song', `<i></i>${o.song || SONG.title} <span>${o.saved || '저장됨'}</span>${sv2('<path d="M6 9l6 6 6-6"/>', 14)}`, root);
  if (o.bare) return;
  const tp = el('div', 'a tp', null, root);
  tp.innerHTML = `<b class="ic">${sv2('<path d="M6 5v14"/><path d="M19 5l-9 7 9 7z"/>', 16)}</b>
    <b class="ic play">${o.playing ? ICON.stop(10) : ICON.play(12)}</b>
    <b class="ic rec${o.recording ? ' on' : ''}">${ICON.rec(11)}</b><b class="ic${o.loop ? ' on' : ''}">${ICON.loop(16)}</b>
    <b class="ic${o.metro ? ' on' : ''}">${sv2('<path d="M9 3h6l4 18H5z"/><path d="M12 15l5-8"/>', 16)}</b>`;
  el('div', 'a lcd', `<span class="pos"${o.recording ? ' style="color:#FF8A8D"' : ''}>${o.pos || '9.1.000'}</span><span class="sep"></span>
    <span class="f">${SONG.bpm}<small>BPM</small></span><span class="f">A<small>minor</small></span><span class="f">${SONG.sig}</span><span class="sep"></span>
    <span class="f" style="color:var(--dt2)">440<small>Hz</small></span>`, root);
  if (o.phase) el('div', 'a phase ' + o.phase[0], `<i></i>${o.phase[1]}`, root);
  const rt = el('div', 'a rt', null, root);
  rt.innerHTML = `<b class="ic">${ICON.undo(17)}</b><b class="ic">${ICON.redo(17)}</b><span class="vs"></span>
    <b class="ic">${sv2('<circle cx="12" cy="12" r="8.5"/><circle cx="8.5" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="15.5" cy="10" r="1.2"/>', 17)}</b>
    <span class="ex" style="margin-left:6px">${ICON.export(15)}내보내기</span>`;
  if (o.rail !== false) {
    const R = el('div', 'a rail', null, root);
    RAIL.forEach(([k, n, d], i) => { const b = el('b', 'ic' + (o.rail === k ? ' on' : ''), sv2(d, 19), R); b.style.top = (14 + i * 44) + 'px'; b.title = n; });
    const s = el('b', 'ic' + (o.rail === 'settings' ? ' on' : ''), sv2('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>', 19), R);
    s.style.top = '794px';
  }
}
// 노브 (v 0–1). dark = 검은 작업 영역 위
function knob5(v, size, label, val, dark) {
  const r = size / 2 - 3, c = size / 2, a0 = Math.PI * .75, a1 = a0 + Math.PI * 1.5 * v, end = Math.PI * 2.25;
  const P = a => [c + Math.cos(a) * r, c + Math.sin(a) * r];
  const arc = (f, t) => { const [x1, y1] = P(f), [x2, y2] = P(t); return `M${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${t - f > Math.PI ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
  const [px, py] = P(a1), fg = dark ? '#EDEDF0' : '#0B0B0C', bg = dark ? '#2C2C33' : '#EDEDEF';
  return `<div class="kn" style="width:${size + 20}px"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">
    <path d="${arc(a0, end)}" stroke="${bg}" stroke-width="2.5" stroke-linecap="round"/>
    ${v > .005 ? `<path d="${arc(a0, a1)}" stroke="${fg}" stroke-width="2.5" stroke-linecap="round"/>` : ''}
    <line x1="${c}" y1="${c}" x2="${(c + (px - c) * .62).toFixed(1)}" y2="${(c + (py - c) * .62).toFixed(1)}" stroke="${fg}" stroke-width="2" stroke-linecap="round"/></svg>
    <b>${val}</b><span>${label}</span></div>`;
}
const at = (e, x, y, w, h) => { Object.assign(e.style, { left: x + 'px', top: y + 'px' }); if (w != null) e.style.width = w + 'px'; if (h != null) e.style.height = h + 'px'; return e; };

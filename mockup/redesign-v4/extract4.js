// Injected into a copy of the mockup: walks the rendered DOM and writes a flat
// list of boxes / texts / svgs (coordinates relative to [data-root]) into <pre id="__out">.
window.addEventListener('load', () => setTimeout(() => {
  const root = document.querySelector('[data-root]');
  const R = root.getBoundingClientRect();
  const out = [];
  const r1 = v => Math.round(v * 10) / 10;
  const rel = r => ({ x: r1(r.left - R.left), y: r1(r.top - R.top), w: r1(r.width), h: r1(r.height) });
  const hex = c => {
    if (c === 'transparent') return null;
    const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    const a = p.length > 3 ? p[3] : 1; if (a === 0) return null;
    const h = p.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    return '#' + h + (a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : '');
  };
  const hexT = c => hex(c) || '#00000000';
  const splitTop = s => { const parts = []; let d = 0, cur = '';
    for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch; }
    if (cur.trim()) parts.push(cur.trim()); return parts; };

  // background-image → paint layers, CSS order (first = top)
  function layers(bi, w, h) {
    if (!bi || bi === 'none') return [];
    const res = [];
    for (const layer of splitTop(bi)) {
      const m = layer.match(/^(repeating-)?(linear|radial)-gradient\((.*)\)$/s);
      if (!m || m[1]) continue;                      // skip repeating (brushed texture) and urls
      const args = splitTop(m[3]);
      let angle = 180, at = null;
      if (!/^(rgb|#|transparent)/.test(args[0])) {
        const a = args.shift();
        const dm = a.match(/(-?[\d.]+)deg/); if (dm) angle = +dm[1];
        if (/to right/.test(a)) angle = 90; if (/to left/.test(a)) angle = 270; if (/to top/.test(a)) angle = 0;
        const am = a.match(/at ([\d.]+)% ([\d.]+)%/); if (am) at = [am[1] / 100, am[2] / 100];
      }
      const stops = args.map(s => {
        const cm = s.match(/rgba?\([^)]+\)|transparent/); const col = cm ? hexT(cm[0]) : '#00000000';
        const rest = cm ? s.replace(cm[0], '') : s;
        const pm = rest.match(/(-?[\d.]+)(%|px)/);
        let pos = null; if (pm) pos = pm[2] === '%' ? pm[1] / 100 : pm[1] / (m[2] === 'linear' ? h : Math.max(w, h));
        return { color: col, position: pos };
      });
      stops.forEach((s, i) => { if (s.position == null) s.position = i === 0 ? 0 : i === stops.length - 1 ? 1 : null; });
      for (let i = 1; i < stops.length - 1; i++) if (stops[i].position == null) {
        let j = i; while (stops[j].position == null) j++;
        const a = stops[i - 1].position, b = stops[j].position; for (let k = i; k < j; k++) stops[k].position = a + (b - a) * (k - i + 1) / (j - i + 1);
      }
      stops.forEach(s => s.position = Math.max(0, Math.min(1, s.position)));
      if (stops.length < 2) continue;
      res.push({ type: m[2], angle, at, stops });
    }
    return res;
  }
  const visible = cs => cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01;
  const inter = (a, b) => { const x = Math.max(a.left, b.left), y = Math.max(a.top, b.top);
    const r = Math.min(a.right, b.right), btm = Math.min(a.bottom, b.bottom);
    return { left: x, top: y, right: r, bottom: btm, width: r - x, height: btm - y }; };

  function boxStyle(cs, r) {
    const bg = hex(cs.backgroundColor);
    const gr = layers(cs.backgroundImage, r.width, r.height);
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map(s => cs['border' + s + 'Style'] !== 'none' ? parseFloat(cs['border' + s + 'Width']) : 0);
    const bc = ['Top', 'Right', 'Bottom', 'Left'].map(s => hex(cs['border' + s + 'Color']));
    const rad = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(s => {
      const v = cs['border' + s + 'Radius']; const n = parseFloat(v) || 0;
      return Math.min(/%/.test(v) ? n / 100 * Math.min(r.width, r.height) * 2 : n, r.width / 2, r.height / 2); });
    const shadow = cs.boxShadow !== 'none' ? cs.boxShadow : null;
    const outerShadow = shadow && splitTop(shadow).some(s => !/inset/.test(s));
    if (!(bg || gr.length || bw.some((w, i) => w > 0 && bc[i]) || outerShadow)) return null;
    return { bg, gr, bw, bc, rad, shadow, op: +cs.opacity };
  }

  // an element whose content is only text + inline formatting → one rich text layer
  const INLINE_OK = new Set(['B', 'STRONG', 'I', 'EM', 'SPAN', 'SMALL']);
  function richCandidate(el) {
    let hasText = false, hasEl = false;
    for (const ch of el.childNodes) {
      if (ch.nodeType === 3 && ch.textContent.trim()) hasText = true;
      if (ch.nodeType === 1) {
        if (!INLINE_OK.has(ch.tagName) || getComputedStyle(ch).display !== 'inline' || ch.children.length) return false;
        hasEl = true;
      }
    }
    return hasText && hasEl;
  }
  function textStyle(cs) {
    return { fs: parseFloat(cs.fontSize), fw: +cs.fontWeight, c: hex(cs.color), ls: parseFloat(cs.letterSpacing) || 0,
             ff: cs.fontFamily, lh: cs.lineHeight, al: cs.textAlign, tt: cs.textTransform };
  }

  function walk(el, clip) {
    const cs = getComputedStyle(el);
    if (!visible(cs)) return;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute('class') || '').toString();
    const vis = inter(r, clip);
    if (tag === 'svg') {
      if (r.width < 1 || vis.width <= 0 || vis.height <= 0) return;
      const c = el.cloneNode(true);
      c.setAttribute('width', r.width); c.setAttribute('height', r.height);
      c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // inline computed transforms (e.g. rotated needles) so the import sees them
      const src = el.querySelectorAll('*'), dst = c.querySelectorAll('*');
      src.forEach((n, i) => { const t = getComputedStyle(n).transform;
        if (t && t !== 'none' && !n.getAttribute('transform')) {
          const o = getComputedStyle(n).transformOrigin.split(' ').map(parseFloat);
          dst[i].setAttribute('transform', `translate(${o[0]} ${o[1]}) ${t.replace(/matrix\(([^)]+)\)/, (m, a) => 'matrix(' + a.replace(/px/g, '') + ')')} translate(${-o[0]} ${-o[1]})`); } });
      out.push({ k: 'svg', ...rel(r), svg: c.outerHTML.replace(/currentColor/g, cs.color), op: +cs.opacity });
      return;
    }
    if (tag === 'canvas') {
      try { out.push({ k: 'img', ...rel(r), data: el.toDataURL('image/png') }); } catch (e) {}
      return;
    }
    if (vis.width > 0.4 && vis.height > 0.4) {
      const st = boxStyle(cs, r);
      if (st) {
        // clipped boxes get the visible part only
        const clipped = vis.width < r.width - 0.5 || vis.height < r.height - 0.5;
        out.push({ k: 'box', ...rel(clipped ? vis : r), ...st, cls, tag });
      }
      for (const p of ['::before', '::after']) {
        const ps = getComputedStyle(el, p);
        if (!ps.content || ps.content === 'none' || ps.content === 'normal' || !visible(ps)) continue;
        if (ps.position !== 'absolute') continue;
        const bl = parseFloat(cs.borderLeftWidth), bt = parseFloat(cs.borderTopWidth);
        let left = parseFloat(ps.left), top = parseFloat(ps.top), w = parseFloat(ps.width), h = parseFloat(ps.height);
        const cw = r.width - bl - parseFloat(cs.borderRightWidth), ch = r.height - bt - parseFloat(cs.borderBottomWidth);
        if (isNaN(w)) w = cw - left - parseFloat(ps.right); if (isNaN(h)) h = ch - top - parseFloat(ps.bottom);
        if (isNaN(left)) left = cw - w - parseFloat(ps.right); if (isNaN(top)) top = ch - h - parseFloat(ps.bottom);
        if (!(w > 0 && h > 0)) continue;
        const pr = { left: r.left + bl + left, top: r.top + bt + top, width: w, height: h };
        pr.right = pr.left + w; pr.bottom = pr.top + h;
        const pv = inter(pr, clip); if (pv.width <= 0 || pv.height <= 0) continue;
        const pst = boxStyle(ps, pr);
        if (pst && !/blur/.test(ps.filter)) out.push({ k: 'box', ...rel(pr), ...pst, cls: cls + p, tag, pseudo: p });
      }
      if (tag === 'input' && el.type === 'text') {
        out.push({ k: 'text', ...rel(r), t: el.value, ...textStyle(cs), pl: parseFloat(cs.paddingLeft), single: true,
                   al: cs.textAlign, pr: parseFloat(cs.paddingRight) });
      }
      if (tag === 'input' && el.type === 'range') out.push({ k: 'range', ...rel(r), v: (el.value - el.min) / (el.max - el.min) });
    }
    const nclip = cs.overflow !== 'visible' ? inter(r, clip) : clip;
    if (richCandidate(el)) {
      const rg = document.createRange(); rg.selectNodeContents(el);
      const u = rg.getBoundingClientRect();
      const segs = []; let t = '';
      for (const ch of el.childNodes) {
        const s = ch.nodeType === 3 ? ch.textContent : ch.textContent;
        const scs = ch.nodeType === 1 ? getComputedStyle(ch) : cs;
        const txt = s.replace(/\s+/g, ' ');
        segs.push({ start: t.length, end: t.length + txt.length, ...textStyle(scs) });
        t += txt;
      }
      const lead = t.length - t.trimStart().length; t = t.trim();
      segs.forEach(s => { s.start = Math.max(0, s.start - lead); s.end = Math.min(t.length, s.end - lead); });
      out.push({ k: 'text', ...rel(u), t, ...textStyle(cs), single: rg.getClientRects().length <= segs.length && u.height < parseFloat(cs.fontSize) * 2.2, segs });
      return;
    }
    for (const ch of el.childNodes) {
      if (ch.nodeType === 1) walk(ch, nclip);
      else if (ch.nodeType === 3 && ch.textContent.trim()) {
        const rg = document.createRange(); rg.selectNodeContents(ch);
        const rects = [...rg.getClientRects()].filter(q => q.width > 0);
        if (!rects.length) continue;
        const u = rg.getBoundingClientRect();
        const v = inter(u, nclip); if (v.width <= 0 || v.height <= 0) continue;
        let t = ch.textContent.replace(/\s+/g, ' ').trim();
        if (cs.textTransform === 'uppercase') t = t.toUpperCase();
        out.push({ k: 'text', ...rel(u), t, ...textStyle(cs), single: rects.length === 1, op: +cs.opacity });
      }
    }
  }
  const rr = root.getBoundingClientRect();
  walk(root, { left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom, width: rr.width, height: rr.height });
  const pre = document.createElement('pre'); pre.id = '__out';
  pre.textContent = JSON.stringify({ w: R.width, h: R.height, items: out });
  document.body.appendChild(pre);
}, 1500));

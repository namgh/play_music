(// 지금 보이는 화면(뷰포트)을 고칠 수 있는 SVG 로 — 상자는 rect, 글자는 줄마다 text, 아이콘은 svg 그대로.
() => {
  const W = innerWidth, H = innerHeight, out = [];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const n = (v) => Math.round(v * 100) / 100;
  // rgb() 는 바로 읽고, 그 밖(oklab·oklch·color-mix — Tailwind v4 의 투명도 색)은 1픽셀 캔버스에 칠해 읽는다
  const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
  const rgba = (c) => {
    if (!c || c === "transparent") return null;
    const m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = "rgba(0,0,0,0)"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: Math.round((d[3] / 255) * 100) / 100 };
  };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const paint = (c, attr) => (c.a >= 1 ? `${attr}="${hex(c)}"` : `${attr}="${hex(c)}" ${attr}-opacity="${n(c.a)}"`);
  const inter = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const hit = (r, c) => r.right > c.l + 0.5 && r.left < c.r - 0.5 && r.bottom > c.t + 0.5 && r.top < c.b - 0.5 && r.width > 0 && r.height > 0;
  function textOf(node, cs, clip) {
    const text = node.nodeValue; if (!text.trim()) return;
    const range = document.createRange(); const lines = []; let cur = null;
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i); range.setEnd(node, i + 1);
      const r = range.getClientRects()[0]; if (!r || !r.width && !/\s/.test(text[i])) continue;
      if (!hit({ left: r.left, right: Math.max(r.right, r.left + 1), top: r.top, bottom: r.bottom, width: 1, height: r.height }, clip)) continue;
      if (cur && Math.abs(cur.top - r.top) < 2 && r.left >= cur.right - 1) { cur.s += text[i]; cur.right = r.right; }
      else { cur = { top: r.top, left: r.left, right: r.right, h: r.height, s: text[i] }; lines.push(cur); }
    }
    const size = parseFloat(cs.fontSize), color = rgba(cs.color); if (!color || color.a === 0) return;
    for (const ln of lines) {
      const s = ln.s.replace(/\s+/g, " ").trim(); if (!s) continue;
      const lead = ln.s.length - ln.s.trimStart().length;   // 줄 앞 공백만큼은 무시(거의 0폭)
      const base = ln.top + ln.h / 2 + size * 0.35;
      out.push(`<text x="${n(ln.left)}" y="${n(base)}" font-family="${esc(cs.fontFamily.split(",")[0].replace(/[\x27"]/g, "").trim() || "Pretendard")}" font-size="${n(size)}" font-weight="${cs.fontWeight}" ${cs.fontStyle === "italic" ? 'font-style="italic" ' : ""}${paint(color, "fill")}${cs.textDecorationLine.includes("underline") ? ' text-decoration="underline"' : ""} xml:space="preserve">${esc(s)}</text>`);
    }
  }
  function box(el, cs, r) {
    const bg = rgba(cs.backgroundColor); const rad = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
    const sides = ["Top", "Right", "Bottom", "Left"].map((k) => ({ w: parseFloat(cs[`border${k}Width`]) || 0, c: rgba(cs[`border${k}Color`]), st: cs[`border${k}Style`] })).map((s) => (s.st === "none" || !s.c || s.c.a === 0 ? { ...s, w: 0 } : s));
    const same = sides.every((s) => s.w === sides[0].w && s.w > 0 && hex(s.c) === hex(sides[0].c));
    const hasBg = bg && bg.a > 0;
    if (hasBg || same) {
      const w = same ? sides[0].w : 0;
      out.push(`<rect x="${n(r.left + w / 2)}" y="${n(r.top + w / 2)}" width="${n(r.width - w)}" height="${n(r.height - w)}"${rad ? ` rx="${n(rad)}"` : ""} ${hasBg ? paint(bg, "fill") : 'fill="none"'}${same ? ` ${paint(sides[0].c, "stroke")} stroke-width="${w}"${sides[0].st === "dashed" ? ' stroke-dasharray="4 3"' : ""}` : ""}/>`);
    }
    if (!same) {
      const [t, ri, b, l] = sides;
      if (t.w) out.push(`<rect x="${n(r.left)}" y="${n(r.top)}" width="${n(r.width)}" height="${t.w}" ${paint(t.c, "fill")}/>`);
      if (b.w) out.push(`<rect x="${n(r.left)}" y="${n(r.bottom - b.w)}" width="${n(r.width)}" height="${b.w}" ${paint(b.c, "fill")}/>`);
      if (l.w) out.push(`<rect x="${n(r.left)}" y="${n(r.top)}" width="${l.w}" height="${n(r.height)}" ${paint(l.c, "fill")}/>`);
      if (ri.w) out.push(`<rect x="${n(r.right - ri.w)}" y="${n(r.top)}" width="${ri.w}" height="${n(r.height)}" ${paint(ri.c, "fill")}/>`);
    }
  }
  function svgOf(el, cs, r) {
    const clone = el.cloneNode(true); const color = hex(rgba(cs.color) || { r: 0, g: 0, b: 0 });
    for (const k of ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]) { const v = cs.getPropertyValue(k); if (v) clone.setAttribute(k, /^rgb/.test(v) ? hex(rgba(v)) : v); }
    clone.removeAttribute("class"); clone.removeAttribute("style"); clone.removeAttribute("aria-hidden");
    clone.setAttribute("x", n(r.left)); clone.setAttribute("y", n(r.top)); clone.setAttribute("width", n(r.width)); clone.setAttribute("height", n(r.height));
    out.push(new XMLSerializer().serializeToString(clone).replace(/currentColor/g, color).replace(/ xmlns="[^"]*"/g, ""));
  }
  function walk(el, clip, depth) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    if (tag === "svg") { if (hit(r, clip)) svgOf(el, cs, r); return; }
    if (tag === "script" || tag === "style" || tag === "noscript") return;
    const start = out.length;
    // 스크롤 영역 밖으로 나간 부분은 잘라서 그린다 (안 자르면 격자선이 화면 밖까지 뻗는다)
    if (hit(r, clip)) { const c = inter(clip, { l: r.left, t: r.top, r: r.right, b: r.bottom }); box(el, cs, { left: c.l, top: c.t, right: c.r, bottom: c.b, width: c.r - c.l, height: c.b - c.t }); }
    let inner = clip;
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") inner = inter(clip, { l: r.left, t: r.top, r: r.right, b: r.bottom });
    if ((tag === "input" || tag === "textarea") && hit(r, clip) && el.type !== "checkbox" && el.type !== "radio" && el.type !== "file" && el.type !== "hidden") {
      const v = el.value || el.placeholder || ""; const size = parseFloat(cs.fontSize);
      const color = el.value ? rgba(cs.color) : { r: 154, g: 161, b: 173, a: 1 };
      const first = v.split("\n")[0];
      if (first) out.push(`<text x="${n(r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth))}" y="${n(tag === "textarea" ? r.top + parseFloat(cs.paddingTop) + size : r.top + r.height / 2 + size * 0.35)}" font-family="${esc(cs.fontFamily.split(",")[0].replace(/[\x27"]/g, "").trim() || "Pretendard")}" font-size="${n(size)}" font-weight="${cs.fontWeight}" ${paint(color, "fill")} xml:space="preserve">${esc(first)}</text>`);
    }
    if (tag === "select" && hit(r, clip)) {
      const v = el.selectedOptions[0]?.textContent.trim() || ""; const size = parseFloat(cs.fontSize);
      if (v) out.push(`<text x="${n(r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth))}" y="${n(r.top + r.height / 2 + size * 0.35)}" font-family="${esc(cs.fontFamily.split(",")[0].replace(/[\x27"]/g, "").trim() || "Pretendard")}" font-size="${n(size)}" font-weight="${cs.fontWeight}" ${paint(rgba(cs.color), "fill")} xml:space="preserve">${esc(v)}</text>`);
      return;
    }
    for (const which of ["::before", "::after"]) {   // 밑줄·점처럼 가짜 요소로 그린 작은 상자
      const ps = getComputedStyle(el, which); const bg = rgba(ps.backgroundColor);
      if (ps.content === "none" || ps.position !== "absolute" || !bg || bg.a === 0 || !hit(r, clip)) continue;
      const w = parseFloat(ps.width), h = parseFloat(ps.height); if (!(w > 0 && h > 0) || w > r.width + 40) continue;
      const left = isNaN(parseFloat(ps.left)) ? r.width - (parseFloat(ps.right) || 0) - w : parseFloat(ps.left);
      const top = isNaN(parseFloat(ps.top)) ? r.height - (parseFloat(ps.bottom) || 0) - h : parseFloat(ps.top);
      const rad = Math.min(parseFloat(ps.borderTopLeftRadius) || 0, w / 2, h / 2);
      out.push(`<rect x="${n(r.left + left)}" y="${n(r.top + top)}" width="${n(w)}" height="${n(h)}"${rad ? ` rx="${n(rad)}"` : ""} ${paint(bg, "fill")}/>`);
    }
    for (const child of el.childNodes) {
      if (child.nodeType === 3) textOf(child, cs, inner);
      else if (child.nodeType === 1) walk(child, inner, depth + 1);
    }
    // 묶음 — 이름 붙은 덩어리만(레이어 목록에서 찾기 쉽게). 너무 잘게 묶지 않는다.
    const made = out.length - start;
    const name = (el.getAttribute("aria-label") || (typeof el.className === "string" && el.className.split(" ")[0]) || "").slice(0, 40);
    if (made > 1 && name && depth <= 7) { const body = out.splice(start, made); out.push(`<g id="${esc(name)}">${body.join("")}</g>`); }
  }
  walk(document.body, { l: 0, t: 0, r: W, b: H }, 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/>${out.join("")}</svg>`;
}
)()
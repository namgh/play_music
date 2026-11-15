// Shared content for all four concepts — taken verbatim from mockup/studio-v2.html.
const TRACKS = [
  { name: '드럼', tone: '로파이 킷', clips: [[0, 4], [4, 4], [8, 8]] },
  { name: '베이스', tone: '핑거 베이스', clips: [[0, 8], [8, 8]] },
  { name: '신스 리드', tone: '플럭', clips: [[4, 4, 1], [8, 4]] },
  { name: '보컬', tone: '리버브', clips: [[8, 8]] },
];
const PITCHES = ['C5', 'B4', 'A#4', 'A4', 'G#4', 'G4', 'F#4', 'F4', 'E4', 'D#4', 'D4', 'C#4', 'C4'];
const BLACK = new Set(['A#4', 'G#4', 'F#4', 'D#4', 'C#4']);
const NOTES = [
  { step: 0, len: 2, p: 3 }, { step: 2, len: 1, p: 0 }, { step: 3, len: 1, p: 1 },
  { step: 4, len: 2, p: 3 }, { step: 6, len: 2, p: 8 }, { step: 8, len: 2, p: 5 },
  { step: 10, len: 1, p: 7 }, { step: 11, len: 1, p: 8 }, { step: 12, len: 4, p: 10 },
];
const NOTICE = '이 수정은 기기 안에서 바로 처리됩니다. AI를 다시 부르지 않으니 나머지 소리는 그대로예요.';

const $ = s => document.querySelector(s);
function el(tag, cls, html, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}
// deterministic pseudo-random for waveforms
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

// waveform bars inside a clip element
function wave(parent, n, seed, cls) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const v = 0.18 + 0.82 * Math.pow(r(), 1.6) * (0.6 + 0.4 * Math.sin(i / 3));
    const b = el('i', cls, null, parent);
    b.style.height = Math.max(8, v * 100) + '%';
  }
}

// pitch curve for the selected note: glide in from below, then vibrato (SVG path in a w×h box)
function curvePath(w, h, glide = 0.32, vib = 0.18) {
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80, x = t * w;
    const g = t < 0.22 ? (1 - t / 0.22) * glide : 0;
    const v = t > 0.45 ? Math.sin((t - 0.45) * 38) * vib * Math.min(1, (t - 0.45) * 4) : 0;
    pts.push((i ? 'L' : 'M') + x.toFixed(1) + ' ' + (h / 2 + (g - v) * h / 2 * 0.9).toFixed(1));
  }
  return pts.join(' ');
}
const ICON = {
  play: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>',
  stop: '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>',
  loop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  rec: '<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.5" fill="currentColor"/></svg>',
  undo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  redo: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/></svg>',
  lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  cursor: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3l14 8-6.5 1.5L9 19z"/></svg>',
  pen: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  cut: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/></svg>',
  curve: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 17c3 0 4-10 9-10s6 10 9 10"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  export: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>',
};

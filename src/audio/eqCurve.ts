/**
 * EQ 응답 곡선 — 이펙트 창에 그리는 선 (순수 함수, Rust `fx/src/effects/eq.rs` 의 `eq_sections` 와 같은 밴드 구성).
 * RBJ 쿡북 공식으로 바이쿼드 크기 응답을 더한다.
 */

type Kind = 'lp' | 'hp' | 'peak' | 'lowshelf' | 'highshelf';

interface Section { kind: Kind; f: number; q: number; gain: number }

function coefs(s: Section, sr: number): [number, number, number, number, number] {
  const f = Math.min(Math.max(s.f, 1), sr * 0.49);
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(s.q, 0.01));
  const a = Math.pow(10, s.gain / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (s.kind) {
    case 'lp': [b0, b1, b2, a0, a1, a2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]; break;
    case 'hp': [b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]; break;
    case 'peak': [b0, b1, b2, a0, a1, a2] = [1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a]; break;
    case 'lowshelf': {
      const k = 2 * Math.sqrt(a) * alpha;
      [b0, b1, b2, a0, a1, a2] = [a * (a + 1 - (a - 1) * cos + k), 2 * a * (a - 1 - (a + 1) * cos), a * (a + 1 - (a - 1) * cos - k), a + 1 + (a - 1) * cos + k, -2 * (a - 1 + (a + 1) * cos), a + 1 + (a - 1) * cos - k];
      break;
    }
    default: {
      const k = 2 * Math.sqrt(a) * alpha;
      [b0, b1, b2, a0, a1, a2] = [a * (a + 1 + (a - 1) * cos + k), -2 * a * (a - 1 + (a + 1) * cos), a * (a + 1 + (a - 1) * cos - k), a + 1 - (a - 1) * cos + k, 2 * (a - 1 - (a + 1) * cos), a + 1 - (a - 1) * cos - k];
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function magnitudeDb(c: [number, number, number, number, number], freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  const [b0, b1, b2, a1, a2] = c;
  const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
  const ni = -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
  const dr = 1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w);
  const di = -(a1 * Math.sin(w) + a2 * Math.sin(2 * w));
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** 이 이펙트가 EQ 곡선을 그릴 수 있는가 */
export function hasEqCurve(type: string): boolean {
  return type === 'eq' || type === 'channeleq' || type === 'linearphaseeq' || type === 'tilteq';
}

function sections(type: string, p: Record<string, number>): Section[] {
  const n = (k: string, d = 0) => (typeof p[k] === 'number' ? p[k]! : d);
  const q = Math.SQRT1_2;
  if (type === 'eq') {
    return [
      { kind: 'lowshelf', f: 250, q, gain: n('lowGainDb') },
      { kind: 'peak', f: n('midHz', 1000), q: 0.9, gain: n('midGainDb') },
      { kind: 'highshelf', f: 4000, q, gain: n('highGainDb') },
    ];
  }
  if (type === 'tilteq') {
    const t = n('tiltDb');
    return [
      { kind: 'lowshelf', f: n('centerHz', 800), q: 0.5, gain: -t / 2 },
      { kind: 'highshelf', f: n('centerHz', 800), q: 0.5, gain: t / 2 },
    ];
  }
  const out: Section[] = [];
  if (n('lowCutHz', 10) > 10.5) for (let i = 0; i < (n('lowCutSlope', 1) >= 0.5 ? 2 : 1); i++) out.push({ kind: 'hp', f: n('lowCutHz'), q, gain: 0 });
  out.push({ kind: 'lowshelf', f: n('lowShelfHz', 100), q, gain: n('lowShelfDb') });
  for (let b = 1; b <= 4; b++) out.push({ kind: 'peak', f: n(`p${b}Hz`, 1000), q: n(`p${b}Q`, 1), gain: n(`p${b}Db`) });
  out.push({ kind: 'highshelf', f: n('highShelfHz', 8000), q, gain: n('highShelfDb') });
  if (n('highCutHz', 22000) < 21500) for (let i = 0; i < (n('highCutSlope', 1) >= 0.5 ? 2 : 1); i++) out.push({ kind: 'lp', f: n('highCutHz'), q, gain: 0 });
  return out;
}

/** 20Hz…20kHz 로그 간격 `points` 개 주파수에서의 dB */
export function eqCurveDb(type: string, params: Record<string, number>, points = 200, sr = 48000): { hz: number[]; db: number[] } {
  const cs = sections(type, params).map((s) => coefs(s, sr));
  const hz: number[] = [];
  const db: number[] = [];
  for (let i = 0; i < points; i++) {
    const f = 20 * Math.pow(1000, i / (points - 1));
    hz.push(f);
    db.push(cs.reduce((sum, c) => sum + magnitudeDb(c, f, sr), 0) + (params.outputDb ?? 0));
  }
  return { hz, db };
}

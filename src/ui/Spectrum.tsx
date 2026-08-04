import { useEffect, useRef } from 'react';

/**
 * 실시간 스펙트럼 + 스펙트로그램 (`sound.md` 9-6 요구 5).
 *
 * 둘 다 필요하다:
 *  - **스펙트럼**은 지금 어느 하모닉이 살아 있는지 보여준다. 강성을 올리면 상위
 *    하모닉이 정수배 위치(점선)에서 오른쪽으로 벗어난다 = 인하모니시티가 눈에 보인다
 *  - **스펙트로그램**은 시간축을 보여준다. "고음이 먼저 죽는다" 같은 감쇠 문제는
 *    스펙트럼 한 장으로는 안 보이고 여기서 보인다
 */

const F_MIN = 40;
const F_MAX = 16000;
const DB_FLOOR = -100;
const SPECTROGRAM_HEIGHT = 120;

export interface SpectrumProps {
  analyser: AnalyserNode | null;
  /** 정수배 위치에 점선을 그린다 — 인하모니시티를 눈으로 보려면 기준선이 필요하다 */
  fundamentalHz: number;
}

export function Spectrum({ analyser, fundamentalHz }: SpectrumProps) {
  const spectrumRef = useRef<HTMLCanvasElement | null>(null);
  const gramRef = useRef<HTMLCanvasElement | null>(null);
  const fundamentalRef = useRef(fundamentalHz);
  fundamentalRef.current = fundamentalHz;

  useEffect(() => {
    if (!analyser) return;
    const data = new Float32Array(analyser.frequencyBinCount);
    let raf = 0;

    const xOf = (hz: number, width: number) =>
      (Math.log(hz / F_MIN) / Math.log(F_MAX / F_MIN)) * width;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = spectrumRef.current;
      const gram = gramRef.current;
      if (!canvas || !gram) return;

      const dpr = devicePixelRatio || 1;
      const width = Math.floor(canvas.clientWidth * dpr);
      const height = Math.floor(canvas.clientHeight * dpr);
      if (width === 0) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      if (gram.width !== width || gram.height !== SPECTROGRAM_HEIGHT * dpr) {
        gram.width = width;
        gram.height = SPECTROGRAM_HEIGHT * dpr;
      }

      analyser.getFloatFrequencyData(data);
      const nyquist = analyser.context.sampleRate / 2;

      // --- 스펙트럼 -------------------------------------------------------
      const g = canvas.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, width, height);

      // 주파수 눈금
      g.strokeStyle = '#1f242c';
      g.fillStyle = '#4a515c';
      g.lineWidth = dpr;
      g.font = `${9 * dpr}px ui-monospace, monospace`;
      for (const hz of [100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = xOf(hz, width);
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, height);
        g.stroke();
        g.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x + 3 * dpr, height - 3 * dpr);
      }

      // 정수배 하모닉 기준선
      const f0 = fundamentalRef.current;
      g.strokeStyle = '#3b4a52';
      g.setLineDash([2 * dpr, 3 * dpr]);
      for (let n = 1; n * f0 < F_MAX; n++) {
        const x = xOf(n * f0, width);
        if (x < 0) continue;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, height);
        g.stroke();
      }
      g.setLineDash([]);

      g.beginPath();
      g.strokeStyle = '#6fd3c7';
      g.lineWidth = 1.4 * dpr;
      let started = false;
      for (let i = 1; i < data.length; i++) {
        const hz = (i * nyquist) / data.length;
        if (hz < F_MIN || hz > F_MAX) continue;
        const db = Math.max(DB_FLOOR, Math.min(0, data[i]!));
        const y = height - ((db - DB_FLOOR) / -DB_FLOOR) * height;
        const x = xOf(hz, width);
        if (started) g.lineTo(x, y);
        else { g.moveTo(x, y); started = true; }
      }
      g.stroke();

      // --- 스펙트로그램 (왼쪽으로 밀면서 오른쪽에 한 줄 추가) ---------------
      const gg = gram.getContext('2d');
      if (!gg) return;
      const column = Math.max(1, Math.round(2 * dpr));
      gg.drawImage(gram, -column, 0);
      gg.clearRect(gram.width - column, 0, column, gram.height);

      for (let y = 0; y < gram.height; y++) {
        // 위가 고음. 로그 축을 스펙트럼과 맞춘다
        const t = 1 - y / gram.height;
        const hz = F_MIN * Math.pow(F_MAX / F_MIN, t);
        const bin = Math.round((hz / nyquist) * data.length);
        const db = Math.max(DB_FLOOR, Math.min(0, data[Math.min(data.length - 1, bin)] ?? DB_FLOOR));
        const level = (db - DB_FLOOR) / -DB_FLOOR;
        if (level <= 0.02) continue;
        // 어두운 청록 → 밝은 청록. 값이 클수록 밝다
        const light = Math.round(18 + level * 70);
        gg.fillStyle = `hsl(172 55% ${light}%)`;
        gg.fillRect(gram.width - column, y, column, 1);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return (
    <section className="rounded-lg border border-neutral-800 p-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">스펙트럼</h2>
        <span className="text-xs text-neutral-500">
          점선 = 정수배 하모닉. 강성을 올리면 상위 하모닉이 점선에서 벗어난다 (인하모니시티)
        </span>
      </div>
      <canvas ref={spectrumRef} className="mt-2 block h-40 w-full rounded bg-neutral-950" />
      <div className="mt-3 flex items-baseline gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          스펙트로그램
        </h2>
        <span className="text-xs text-neutral-500">시간축 — 어느 하모닉이 먼저 죽는지 보인다</span>
      </div>
      <canvas
        ref={gramRef}
        style={{ height: SPECTROGRAM_HEIGHT }}
        className="mt-2 block w-full rounded bg-neutral-950"
      />
      {!analyser && (
        <p className="mt-2 text-xs text-neutral-500">뜯기를 누르면 표시됩니다.</p>
      )}
    </section>
  );
}

import type { AudioRegion, Clip, Project } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { resizeClip } from '../editor/edits.ts';
import { secondsToTicks, ticksToSeconds } from '../model/time.ts';
import { usePeaks } from './audioUi.ts';

/**
 * 오디오 클립 편집기 (Logic 오디오 트랙 편집기, `LOGIC_PARITY.md` 1-5) — 파형 위에 지금 쓰는
 * 구간(시작 다듬기·길이)과 페이드를 보여 주고, 게인·페이드·거꾸로·노멀라이즈를 고친다.
 * 음정·타이밍 편집(Flex)은 Phase 4 — 확정 결정 2번.
 */

export interface AudioEditorProps {
  editor: ProjectEditor;
  clip: Clip & { audio: AudioRegion };
}

const ROW = 'grid grid-cols-[6rem_1fr_4.5rem] items-center gap-3';
const LABEL = 'text-[11px] text-sink-2';
const VAL = 'text-right font-num text-[14px] text-sink';

export function AudioEditor({ editor, clip }: AudioEditorProps) {
  const { project } = editor;
  const a = clip.audio;
  const peaks = usePeaks(a.assetId, 600);
  const startSec = ticksToSeconds(clip.startTick, project.tempo);
  const regionSec = Math.min(ticksToSeconds(clip.startTick + clip.lengthTick, project.tempo) - startSec, a.assetSec - a.offsetSec);

  const patch = (p: Partial<AudioRegion>, commit: boolean) => {
    const next: Project = {
      ...project,
      tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? { ...c, audio: { ...a, ...p } } : c)) })),
    };
    if (commit) editor.commit(next); else editor.preview(next);
  };
  /** 길이(초) → 클립 길이(틱) */
  const setLengthSec = (sec: number, commit: boolean) => {
    const end = secondsToTicks(startSec + Math.max(0.05, Math.min(sec, a.assetSec - a.offsetSec)), project.tempo);
    const next = resizeClip(project, clip.id, Math.max(1, end - clip.startTick));
    if (commit) editor.commit(next); else editor.preview(next);
  };
  const normalize = () => {
    if (!peaks) return;
    const from = Math.floor((a.offsetSec / a.assetSec) * peaks.length);
    const to = Math.ceil(((a.offsetSec + regionSec) / a.assetSec) * peaks.length);
    let max = 0;
    for (let i = from; i < to; i++) max = Math.max(max, peaks[a.reverse ? peaks.length - 1 - i : i] ?? 0);
    if (max > 0) patch({ gainDb: Math.round((-1 - 20 * Math.log10(max)) * 10) / 10 }, true);
  };

  // 파형 — 에셋 전체를 흐리게, 쓰는 구간을 진하게
  const W = 1000;
  const H = 140;
  const bars = peaks ? [...(a.reverse ? [...peaks].reverse() : peaks)] : [];
  const x0 = (a.offsetSec / a.assetSec) * W;
  const x1 = ((a.offsetSec + regionSec) / a.assetSec) * W;
  const fi = (a.fadeInSec / a.assetSec) * W;
  const fo = (a.fadeOutSec / a.assetSec) * W;
  const g = Math.pow(10, a.gainDb / 20);

  return (
    <div className="flex min-h-[11rem] flex-1 flex-col gap-3 overflow-y-auto rounded-xl bg-screen p-4" data-audio-editor>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-sink">{a.name}</span>
        <span className="font-num text-[13px] text-sink-3">에셋 {a.assetSec.toFixed(2)}초 · 쓰는 구간 {a.offsetSec.toFixed(2)}–{(a.offsetSec + regionSec).toFixed(2)}초</span>
        <span className="flex-1" />
        <span className="text-[10px] text-sink-3">음정·타이밍(Flex)은 Phase 4</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-36 w-full rounded-md bg-screen-2" role="img" aria-label="파형">
        {bars.map((p, i) => {
          const x = (i / bars.length) * W;
          const inside = x >= x0 && x <= x1;
          let fade = 1;
          if (inside && fi > 0 && x < x0 + fi) fade = (x - x0) / fi;
          if (inside && fo > 0 && x > x1 - fo) fade = Math.min(fade, (x1 - x) / fo);
          const h = Math.min(1, p * (inside ? g * fade : 1)) * (H / 2 - 4);
          return <rect key={i} x={x} y={H / 2 - h} width={Math.max(1, W / bars.length - 0.5)} height={h * 2} fill={inside ? 'var(--color-acc)' : 'var(--color-grid-2)'} />;
        })}
        {!peaks && <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--color-sink-3)" fontSize="14">파형을 읽는 중…</text>}
        <line x1={x0} x2={x0} y1={0} y2={H} stroke="var(--color-sink)" strokeWidth={2} />
        <line x1={x1} x2={x1} y1={0} y2={H} stroke="var(--color-sink)" strokeWidth={2} />
        {fi > 0 && <path d={`M ${x0} ${H} L ${x0 + fi} 4`} stroke="var(--color-sink)" fill="none" strokeDasharray="4 3" />}
        {fo > 0 && <path d={`M ${x1 - fo} 4 L ${x1} ${H}`} stroke="var(--color-sink)" fill="none" strokeDasharray="4 3" />}
      </svg>

      <div className="grid gap-2 lg:grid-cols-2 lg:gap-x-8">
        <label className={ROW}><span className={LABEL}>시작 다듬기</span>
          <input type="range" aria-label="시작 다듬기" min={0} max={Math.max(0, a.assetSec - 0.05)} step={0.01} value={a.offsetSec}
            onChange={(e) => patch({ offsetSec: Number(e.target.value) }, false)} onPointerUp={() => editor.commitCurrent()} className="accent-acc" />
          <span className={VAL}>{a.offsetSec.toFixed(2)}s</span></label>
        <label className={ROW}><span className={LABEL}>길이</span>
          <input type="range" aria-label="길이" min={0.05} max={a.assetSec - a.offsetSec} step={0.01} value={regionSec}
            onChange={(e) => setLengthSec(Number(e.target.value), false)} onPointerUp={() => editor.commitCurrent()} className="accent-acc" />
          <span className={VAL}>{regionSec.toFixed(2)}s</span></label>
        <label className={ROW}><span className={LABEL}>게인</span>
          <input type="range" aria-label="게인" min={-24} max={24} step={0.1} value={a.gainDb}
            onChange={(e) => patch({ gainDb: Number(e.target.value) }, false)} onPointerUp={() => editor.commitCurrent()} className="accent-acc" />
          <span className={VAL}>{a.gainDb > 0 ? '+' : ''}{a.gainDb.toFixed(1)}dB</span></label>
        <label className={ROW}><span className={LABEL}>페이드 인</span>
          <input type="range" aria-label="페이드 인" min={0} max={Math.max(0.01, regionSec / 2)} step={0.01} value={Math.min(a.fadeInSec, regionSec / 2)}
            onChange={(e) => patch({ fadeInSec: Number(e.target.value) }, false)} onPointerUp={() => editor.commitCurrent()} className="accent-acc" />
          <span className={VAL}>{a.fadeInSec.toFixed(2)}s</span></label>
        <label className={ROW}><span className={LABEL}>페이드 아웃</span>
          <input type="range" aria-label="페이드 아웃" min={0} max={Math.max(0.01, regionSec / 2)} step={0.01} value={Math.min(a.fadeOutSec, regionSec / 2)}
            onChange={(e) => patch({ fadeOutSec: Number(e.target.value) }, false)} onPointerUp={() => editor.commitCurrent()} className="accent-acc" />
          <span className={VAL}>{a.fadeOutSec.toFixed(2)}s</span></label>
        <div className="flex items-center gap-2">
          <button type="button" aria-pressed={a.reverse} onClick={() => patch({ reverse: !a.reverse }, true)}
            className={`h-7 rounded-md border px-2.5 text-xs ${a.reverse ? 'border-acc bg-acc text-acc-ink' : 'border-grid-2 bg-screen-2 text-sink'}`}>거꾸로</button>
          <button type="button" onClick={normalize} disabled={!peaks} title="쓰는 구간의 가장 큰 소리를 −1 dBFS 로 (게인으로)"
            className="h-7 rounded-md border border-grid-2 bg-screen-2 px-2.5 text-xs text-sink disabled:opacity-40">노멀라이즈</button>
          <button type="button" onClick={() => patch({ gainDb: 0, fadeInSec: 0, fadeOutSec: 0, reverse: false }, true)}
            className="h-7 rounded-md border border-grid-2 bg-screen-2 px-2.5 text-xs text-sink-2">처음대로</button>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';

import type { Project, Track, TrackId } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { INSTRUMENT_CATALOG } from '../instruments/definitions.ts';
import { projectLengthTicks } from '../model/factory.ts';
import {
  BASS_STYLES, DRUM_STYLES, generateBass, generateDrums, generateKeys, KEYS_STYLES,
} from '../editor/sessionPlayers.ts';
import type { BassStyle, DrumStyle, KeysStyle } from '../editor/sessionPlayers.ts';
import { analyzeMix, MASTER_TARGETS, suggestMaster } from '../audio/mastering.ts';
import type { MasterSuggestion, MasterTarget, MixAnalysis } from '../audio/mastering.ts';

/**
 * 도우미 화면 — 세션 연주자(드럼·베이스·건반) · 마스터링 도우미 · 대화형 도우미 자리
 * (Logic Session Players · Mastering Assistant · Intelligent assistant, `LOGIC_PARITY.md` 1-6·1-12·1-16).
 *
 * 앞의 둘은 **규칙 기반이라 오프라인에서 돈다.** 대화형 도우미(생성 AI)는 `AI_GENERATION.md`
 * 착수 조건 전이라 자리만 있다 — 서버와 모델이 붙으면 여기로 들어온다.
 */

export interface AssistantProps {
  editor: ProjectEditor;
  exporting: boolean;
  renderMix: () => Promise<Float32Array[] | null>;
  onNotice: (message: string) => void;
}

const CARD = 'flex flex-col gap-2.5 rounded-xl border border-rule bg-body p-4';
const FIELD = 'h-8 w-full rounded-md border border-rule bg-body px-2 text-xs text-ink';
const LABEL = 'text-[11px] font-semibold text-ink-3';
const RUN = 'h-8 rounded-full bg-ink px-4 text-xs font-semibold text-body disabled:opacity-40';
const catOf = (t: Track) => INSTRUMENT_CATALOG.find((e) => e.id === t.instrumentId)?.category;

export function Assistant({ editor, exporting, renderMix, onNotice }: AssistantProps) {
  const { project } = editor;
  const drums = project.tracks.filter((t) => catOf(t) === '드럼');
  const pick = (re: RegExp) => drums.find((t) => re.test(t.instrumentId))?.id;
  const [kick, setKick] = useState<TrackId | ''>(pick(/kick/) ?? '');
  const [snare, setSnare] = useState<TrackId | ''>(pick(/snare|clap/) ?? '');
  const [hat, setHat] = useState<TrackId | ''>(pick(/hihat|shaker|tambourine/) ?? '');
  const [drumStyle, setDrumStyle] = useState<DrumStyle>('pop');
  const [complexity, setComplexity] = useState(0.4);
  const [intensity, setIntensity] = useState(0.6);
  const [fills, setFills] = useState(true);
  const [bassTrack, setBassTrack] = useState<TrackId | ''>(project.tracks.find((t) => catOf(t) === '베이스')?.id ?? '');
  const [bassStyle, setBassStyle] = useState<BassStyle>('rootFifth');
  const [bassRhythm, setBassRhythm] = useState<'quarters' | 'eighths' | 'syncopated'>('eighths');
  const [keysTrack, setKeysTrack] = useState<TrackId | ''>(project.tracks.find((t) => catOf(t) === '피아노' || catOf(t) === '건반·신스')?.id ?? '');
  const [keysStyle, setKeysStyle] = useState<KeysStyle>('comp');
  const [seed, setSeed] = useState(1);
  const [range, setRange] = useState<string>('song');
  const [target, setTarget] = useState<MasterTarget>('streaming');
  const [mix, setMix] = useState<{ analysis: MixAnalysis; suggestion: MasterSuggestion } | null>(null);

  const ranges = [
    { id: 'song', label: '곡 전체', from: 0, to: projectLengthTicks(project) },
    ...(project.sections ?? []).map((s) => ({ id: s.id, label: `구간 · ${s.name}`, from: s.startTick, to: s.startTick + s.lengthTick })),
  ];
  const r = ranges.find((x) => x.id === range) ?? ranges[0]!;
  const run = (label: string, f: () => Project) => {
    try {
      editor.commit(f());
      onNotice(`${label} 파트를 만들었습니다 — 마음에 안 들면 "다시"(씨앗 바꾸기) 또는 ⌘Z`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    }
  };
  const trackSelect = (value: string, set: (v: TrackId | '') => void, label: string, filter?: (t: Track) => boolean) => (
    <select aria-label={label} value={value} onChange={(e) => set(e.target.value as TrackId | '')} className={FIELD}>
      <option value="">— 없음 —</option>
      {project.tracks.filter(filter ?? (() => true)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );

  return (
    <section className="flex flex-col gap-4" data-assistant>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-disp text-lg leading-none text-ink">도우미</h2>
        <span className="text-[11px] text-ink-3">세션 연주자·마스터링은 규칙으로 — 인터넷 없이 돕니다</span>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-xs text-ink-2">범위
          <select aria-label="연주 범위" value={range} onChange={(e) => setRange(e.target.value)} className="h-8 rounded-md border border-rule bg-body px-2 text-xs">
            {ranges.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <span className="text-[11px] text-ink-3">코드 {(project.chords ?? []).length}개를 따라갑니다</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className={CARD} data-player="drums">
          <div className="flex items-baseline gap-2"><h3 className="text-sm font-semibold text-ink">드러머</h3><span className="text-[11px] text-ink-3">킥·스네어·하이햇 트랙에 나눠 칩니다</span></div>
          <div className="grid grid-cols-3 gap-1.5">
            <label className="space-y-1"><span className={LABEL}>킥</span>{trackSelect(kick, setKick, '킥 트랙', (t) => catOf(t) === '드럼')}</label>
            <label className="space-y-1"><span className={LABEL}>스네어</span>{trackSelect(snare, setSnare, '스네어 트랙', (t) => catOf(t) === '드럼')}</label>
            <label className="space-y-1"><span className={LABEL}>하이햇</span>{trackSelect(hat, setHat, '하이햇 트랙', (t) => catOf(t) === '드럼')}</label>
          </div>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="드럼 스타일">
            {(Object.keys(DRUM_STYLES) as DrumStyle[]).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={drumStyle === s} onClick={() => setDrumStyle(s)}
                className={`h-7 rounded-full border px-2.5 text-xs ${drumStyle === s ? 'border-ink bg-ink text-body' : 'border-rule bg-panel'}`}>{DRUM_STYLES[s].label}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-2"><span className="w-14">복잡도</span><input type="range" min={0} max={1} step={0.05} value={complexity} onChange={(e) => setComplexity(Number(e.target.value))} className="flex-1 accent-ink" aria-label="복잡도" /></label>
          <label className="flex items-center gap-2 text-xs text-ink-2"><span className="w-14">세기</span><input type="range" min={0} max={1} step={0.05} value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} className="flex-1 accent-ink" aria-label="세기" /></label>
          <label className="flex items-center gap-2 text-xs text-ink"><input type="checkbox" checked={fills} onChange={(e) => setFills(e.target.checked)} className="accent-ink" />구간 끝 필인</label>
          <button type="button" disabled={!kick && !snare && !hat} className={RUN}
            onClick={() => run('드럼', () => generateDrums(project, { kick: kick || undefined, snare: snare || undefined, hat: hat || undefined }, { fromTick: r.from, toTick: r.to }, { style: drumStyle, complexity, intensity, fills, seed }))}>드럼 만들기</button>
        </div>

        <div className={CARD} data-player="bass">
          <div className="flex items-baseline gap-2"><h3 className="text-sm font-semibold text-ink">베이시스트</h3><span className="text-[11px] text-ink-3">코드 근음을 따라갑니다</span></div>
          <label className="space-y-1"><span className={LABEL}>트랙</span>{trackSelect(bassTrack, setBassTrack, '베이스 트랙')}</label>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="베이스 스타일">
            {(Object.keys(BASS_STYLES) as BassStyle[]).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={bassStyle === s} onClick={() => setBassStyle(s)}
                className={`h-7 rounded-full border px-2.5 text-xs ${bassStyle === s ? 'border-ink bg-ink text-body' : 'border-rule bg-panel'}`}>{BASS_STYLES[s]}</button>
            ))}
          </div>
          <select aria-label="베이스 리듬" value={bassRhythm} onChange={(e) => setBassRhythm(e.target.value as typeof bassRhythm)} className={FIELD}>
            <option value="quarters">4분음표</option><option value="eighths">8분음표</option><option value="syncopated">당김음</option>
          </select>
          <span className="flex-1" />
          <button type="button" disabled={!bassTrack} className={RUN}
            onClick={() => run('베이스', () => generateBass(project, bassTrack as TrackId, { fromTick: r.from, toTick: r.to }, { style: bassStyle, rhythm: bassRhythm, seed }))}>베이스 만들기</button>
        </div>

        <div className={CARD} data-player="keys">
          <div className="flex items-baseline gap-2"><h3 className="text-sm font-semibold text-ink">건반 연주자</h3><span className="text-[11px] text-ink-3">가까운 자리바꿈으로 잇습니다</span></div>
          <label className="space-y-1"><span className={LABEL}>트랙</span>{trackSelect(keysTrack, setKeysTrack, '건반 트랙')}</label>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="건반 스타일">
            {(Object.keys(KEYS_STYLES) as KeysStyle[]).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={keysStyle === s} onClick={() => setKeysStyle(s)}
                className={`h-7 rounded-full border px-2.5 text-xs ${keysStyle === s ? 'border-ink bg-ink text-body' : 'border-rule bg-panel'}`}>{KEYS_STYLES[s]}</button>
            ))}
          </div>
          <span className="flex-1" />
          <div className="flex gap-1.5">
            <button type="button" disabled={!keysTrack} className={`${RUN} flex-1`}
              onClick={() => run('건반', () => generateKeys(project, keysTrack as TrackId, { fromTick: r.from, toTick: r.to }, { style: keysStyle, seed }))}>건반 만들기</button>
            <button type="button" onClick={() => setSeed((x) => x + 1)} title="다음 만들기를 다른 변주로 (씨앗 바꾸기)"
              className="h-8 rounded-full border border-rule px-3 text-xs text-ink-2">다시 · {seed}</button>
          </div>
        </div>
      </div>

      <div className={CARD} data-mastering>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">마스터링 도우미</h3>
          <span className="text-[11px] text-ink-3">곡을 한 번 그려 재고, 마스터에 EQ·컴프·리미터를 제안합니다</span>
          <span className="flex-1" />
          <select aria-label="라우드니스 목표" value={target} onChange={(e) => { setTarget(e.target.value as MasterTarget); if (mix) setMix({ ...mix, suggestion: suggestMaster(mix.analysis, e.target.value as MasterTarget) }); }}
            className="h-8 rounded-md border border-rule bg-body px-2 text-xs">
            {(Object.keys(MASTER_TARGETS) as MasterTarget[]).map((t) => <option key={t} value={t}>{MASTER_TARGETS[t].label}</option>)}
          </select>
          <button type="button" disabled={exporting} className={RUN}
            onClick={async () => {
              const ch = await renderMix();
              if (!ch) return;
              const analysis = analyzeMix(ch, 48000);
              setMix({ analysis, suggestion: suggestMaster(analysis, target) });
            }}>{exporting ? '재는 중…' : '믹스 재기'}</button>
        </div>
        {mix && (
          <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-screen p-3 text-sink">
              <dt className="text-[10px] text-sink-3">통합 라우드니스</dt><dd className="text-right font-num text-[16px] text-acc-2">{mix.analysis.lufs.toFixed(1)} LUFS</dd>
              <dt className="text-[10px] text-sink-3">트루 피크</dt><dd className="text-right font-num text-[15px]">{mix.analysis.truePeakDb.toFixed(1)} dBTP</dd>
              <dt className="text-[10px] text-sink-3">저역 − 중역</dt><dd className="text-right font-num text-[15px]">{mix.analysis.lowVsMid.toFixed(1)} dB</dd>
              <dt className="text-[10px] text-sink-3">고역 − 중역</dt><dd className="text-right font-num text-[15px]">{mix.analysis.highVsMid.toFixed(1)} dB</dd>
            </dl>
            <div className="space-y-2">
              <ul className="space-y-1 text-xs text-ink">{mix.suggestion.reasons.map((x) => <li key={x}>· {x}</li>)}</ul>
              <button type="button" className={RUN}
                onClick={() => { editor.commit({ ...project, master: { ...project.master, effects: mix.suggestion.effects } }); onNotice('마스터에 EQ·컴프·리미터를 걸었습니다 — 믹서의 마스터 인서트에서 고칠 수 있습니다'); }}>
                마스터에 적용 (예상 {mix.suggestion.expectedLufs.toFixed(1)} LUFS)</button>
            </div>
          </div>
        )}
      </div>

      <div className={`${CARD} bg-panel`} data-chat-assistant>
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-ink">대화형 도우미</h3>
          <span className="rounded-full bg-panel-2 px-2 text-[10px] text-ink-2">준비 중 · 온라인 전용</span>
        </div>
        <p className="text-xs text-ink-2">
          "코러스 베이스를 더 펑키하게", "브리지 코드 진행 바꿔 줘" 같은 말로 곡을 고치는 자리입니다. 생성 AI 는 서버의 모델을 부르므로
          인터넷이 있어야 하고, 고친 결과는 위의 편집 함수로 들어와 ⌘Z 로 되돌릴 수 있게 됩니다. 착수 조건(<code>AI_GENERATION.md</code> 4절)이 풀리면 붙입니다.
        </p>
        <input disabled aria-label="도우미에게 말하기" placeholder="지금은 쓸 수 없습니다 — 서버 연결 뒤에 열립니다" className="h-9 rounded-md border border-rule bg-body px-3 text-xs" />
      </div>
    </section>
  );
}

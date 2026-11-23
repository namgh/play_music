import { useState } from 'react';

import type { Project } from '../model/project.ts';
import { projectLengthTicks } from '../model/factory.ts';
import type { BounceReport } from '../audio/bounce.ts';
import type { BounceOptions } from '../audio/useAudioEngine.ts';
import { positionAt } from '../model/meter.ts';
import { AUDIO_FORMATS, BITRATES, formatInfo } from '../audio/encode.ts';
import type { AudioFormat } from '../audio/encode.ts';

/**
 * 내보내기 창 — 범위 · 형식(WAV·FLAC·MP3·M4A·OGG) · 노멀라이즈 · 스템 (Logic Bounce 창, `LOGIC_PARITY.md` 1-13).
 * 끝나면 그 파일을 잰 값(피크·트루피크·LUFS)을 바로 보여 준다 — 스트리밍에
 * 올리기 전에 라우드니스를 따로 재러 가지 않게.
 */

export interface ExportPanelProps {
  project: Project;
  exporting: boolean;
  onBounce: (options: BounceOptions) => Promise<BounceReport | null>;
  onClose: () => void;
}

const LABEL = 'text-[11px] font-semibold text-ink-3';
const FIELD = 'h-8 w-full rounded-md border border-rule bg-body px-2 text-xs text-ink';
const CHOICE = 'h-8 flex-1 rounded-md border text-xs';

type RangeKey = 'song' | 'loop' | `sec:${string}`;

export function ExportPanel({ project, exporting, onBounce, onClose }: ExportPanelProps) {
  const [range, setRange] = useState<RangeKey>('song');
  const [format, setFormat] = useState<AudioFormat>('wav');
  const [bitDepth, setBitDepth] = useState<16 | 24 | 32>(24);
  const [kbps, setKbps] = useState<number>(256);
  const [sampleRate, setSampleRate] = useState<44100 | 48000>(48000);
  const [normalize, setNormalize] = useState(false);
  const [stems, setStems] = useState(false);
  const [tail, setTail] = useState(true);
  const [report, setReport] = useState<BounceReport | null>(null);

  const songEnd = projectLengthTicks(project);
  const resolve = (): { startTick: number; endTick: number } => {
    if (range === 'loop' && project.loop) return { startTick: project.loop.startTick, endTick: project.loop.endTick };
    if (range.startsWith('sec:')) {
      const s = project.sections?.find((x) => x.id === range.slice(4));
      if (s) return { startTick: s.startTick, endTick: s.startTick + s.lengthTick };
    }
    return { startTick: 0, endTick: songEnd };
  };
  const bar = (tick: number) => positionAt(project, tick).bar + 1;
  const { startTick, endTick } = resolve();

  const run = async () => {
    setReport(null);
    const r = await onBounce({
      startTick, endTick, tailSec: tail ? 2 : 0, sampleRate, format, bitDepth, kbps, normalizeDb: normalize ? -1 : null, stems,
    });
    setReport(r);
  };

  const info = formatInfo(format);
  /** Opus 는 48kHz 로만 담는다 */
  const rate = format === 'ogg' ? 48000 : sampleRate;

  const toggle = (on: boolean) => (on ? 'border-ink bg-ink text-body' : 'border-rule bg-body text-ink-2 hover:border-ink-3');

  return (
    <div role="dialog" aria-label="내보내기" className="absolute right-5 top-[60px] z-50 w-[22rem] rounded-xl border border-rule bg-body p-4 shadow-xl">
      <div className="mb-3 flex items-center">
        <h2 className="flex-1 font-disp text-base text-ink">내보내기</h2>
        <button type="button" onClick={onClose} className="h-7 rounded-md border border-rule px-2 text-xs text-ink-2">닫기</button>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className={LABEL}>범위</span>
          <select aria-label="내보낼 범위" value={range} onChange={(e) => setRange(e.target.value as RangeKey)} className={FIELD}>
            <option value="song">곡 전체 (1–{bar(songEnd - 1)}마디)</option>
            {project.loop && <option value="loop">반복 구간 ({bar(project.loop.startTick)}–{bar(project.loop.endTick - 1)}마디)</option>}
            {(project.sections ?? []).map((s) => (
              <option key={s.id} value={`sec:${s.id}`}>구간 · {s.name} ({bar(s.startTick)}–{bar(s.startTick + s.lengthTick - 1)}마디)</option>
            ))}
          </select>
        </label>

        <div className="space-y-1">
          <span className={LABEL}>형식 — {info.label} <span className="font-normal">· {info.hint}</span></span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="파일 형식">
            {AUDIO_FORMATS.map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={format === f.id} data-format={f.id} title={f.hint}
                onClick={() => { setFormat(f.id); if (!f.lossy && !f.bitDepths.includes(bitDepth)) setBitDepth(f.bitDepths[0]!); }}
                className={`${CHOICE} ${toggle(format === f.id)}`}>{f.label}</button>
            ))}
          </div>
          {info.lossy ? (
            <div className="flex gap-1.5" role="radiogroup" aria-label="비트레이트">
              {BITRATES.map((b) => (
                <button key={b} type="button" role="radio" aria-checked={kbps === b} onClick={() => setKbps(b)} className={`${CHOICE} ${toggle(kbps === b)}`}>{b}k</button>
              ))}
            </div>
          ) : (
            <div className="flex gap-1.5" role="radiogroup" aria-label="비트 깊이">
              {info.bitDepths.map((d) => (
                <button key={d} type="button" role="radio" aria-checked={bitDepth === d} onClick={() => setBitDepth(d)} className={`${CHOICE} ${toggle(bitDepth === d)}`}
                  title={d === 16 ? 'CD 형식. 디더를 자동으로 겁니다' : d === 32 ? '소수점 형식 — 1 을 넘는 소리도 잘리지 않습니다. 다른 DAW 로 넘겨 더 만질 때' : '기본'}>
                  {d === 16 ? '16bit + 디더' : d === 32 ? '32bit float' : '24bit'}</button>
              ))}
            </div>
          )}
          <div className="flex gap-1.5" role="radiogroup" aria-label="표본율">
            <button type="button" role="radio" aria-checked={rate === 48000} onClick={() => setSampleRate(48000)} className={`${CHOICE} ${toggle(rate === 48000)}`}>48 kHz</button>
            <button type="button" role="radio" aria-checked={rate === 44100} disabled={format === 'ogg'} onClick={() => setSampleRate(44100)} className={`${CHOICE} ${toggle(rate === 44100)} disabled:opacity-40`}>44.1 kHz</button>
          </div>
        </div>

        <div className="space-y-1.5">
          <span className={LABEL}>처리</span>
          <label className="flex items-center gap-2 text-xs text-ink">
            <input type="checkbox" checked={tail} onChange={(e) => setTail(e.target.checked)} className="accent-ink" />
            끝 뒤 2초 꼬리 담기 <span className="text-ink-3">(리버브·딜레이가 끝까지 울리게)</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink">
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} className="accent-ink" />
            노멀라이즈 <span className="text-ink-3">(가장 큰 소리를 −1 dBFS 에)</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink">
            <input type="checkbox" checked={stems} onChange={(e) => setStems(e.target.checked)} className="accent-ink" />
            트랙별 스템 <span className="text-ink-3">(트랙마다 파일, ZIP 하나로)</span>
          </label>
        </div>

        <button
          type="button"
          disabled={exporting}
          onClick={() => void run()}
          className="h-9 w-full rounded-full bg-cta text-[13px] font-semibold text-cta-ink disabled:opacity-50"
        >{exporting ? '내보내는 중…' : stems ? `스템 ${project.tracks.length}개 내보내기` : '바운스'}</button>

        {report && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-screen px-3 py-2.5 text-sink" aria-label="내보낸 파일 측정">
            <dt className="text-[10px] text-sink-3">통합 라우드니스</dt>
            <dd className="text-right font-num text-[17px] text-acc-2">{report.lufs === null ? '48k 에서만' : `${report.lufs.toFixed(1)} LUFS`}</dd>
            <dt className="text-[10px] text-sink-3">트루 피크</dt>
            <dd className={`text-right font-num text-[15px] ${report.truePeakDb > -1 ? 'text-rec' : ''}`}>{report.truePeakDb.toFixed(1)} dBTP</dd>
            <dt className="text-[10px] text-sink-3">샘플 피크</dt>
            <dd className="text-right font-num text-[15px]">{report.peakDb.toFixed(1)} dBFS</dd>
            <dt className="text-[10px] text-sink-3">길이</dt>
            <dd className="text-right font-num text-[15px]">{report.seconds.toFixed(1)}초</dd>
            {report.truePeakDb > -1 && (
              <dd className="col-span-2 pt-1 text-[11px] text-sink-2">트루 피크가 −1 dBTP 를 넘습니다 — 스트리밍 변환에서 찌그러질 수 있어요. 마스터에 리미터(천장 −1)를 거세요.</dd>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}

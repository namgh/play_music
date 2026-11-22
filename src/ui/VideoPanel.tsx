import { useEffect, useRef, useState } from 'react';

import type { Project } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { addMarker } from '../editor/arrangement.ts';
import { getAsset } from '../audio/assets.ts';
import { secondsToTicks, ticksToSeconds } from '../model/time.ts';
import { importAudioBytes, placeAudio } from './audioUi.ts';
import { DEFAULT_TIMECODE, fitTempoToHit, formatTimecode } from '../model/timecode.ts';
import { exportVideoWithMix } from '../audio/videoExport.ts';

/**
 * 영상 창 (Logic 무비 창, `LOGIC_PARITY.md` 1-15) — 재생 헤드를 따라 영상이 움직인다.
 * 영상 소리는 오디오 트랙으로 꺼낼 수 있고, 지금 자리에 장면 마커를 놓는다.
 * 영상은 에셋 저장소에 있어 프로젝트 파일은 가볍다.
 */

export interface VideoPanelProps {
  editor: ProjectEditor;
  /** 곡 기준 지금 자리 (재생 중이면 재생 헤드) */
  songTick: number;
  playing: boolean;
  onNotice: (message: string) => void;
  /** 곡 전체 믹스 (48kHz) — 영상과 함께 내보낼 때 */
  renderMix: () => Promise<Float32Array[] | null>;
  busy: boolean;
}

export function VideoPanel({ editor, songTick, playing, onNotice, renderMix, busy }: VideoPanelProps) {
  const [exporting, setExporting] = useState<number | null>(null);
  const { project } = editor;
  const video = project.video!;
  const ref = useRef<HTMLVideoElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [small, setSmall] = useState(false);

  useEffect(() => {
    let made: string | null = null;
    void getAsset(video.assetId).then((bytes) => {
      if (!bytes) { onNotice('영상 파일을 이 브라우저에서 찾지 못했습니다 — 다시 가져오세요'); return; }
      made = URL.createObjectURL(new Blob([bytes]));
      setUrl(made);
    });
    return () => { if (made) URL.revokeObjectURL(made); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.assetId]);

  const sec = ticksToSeconds(songTick, project.tempo) - video.offsetSec;
  // 멈춰 있으면 자리를 맞추고, 재생 중이면 크게 어긋날 때만 맞춘다 (매 프레임 맞추면 끊긴다)
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    const target = Math.max(0, Math.min(video.durationSec, sec));
    if (playing) {
      if (sec < 0 || sec > video.durationSec) { v.pause(); return; }
      if (Math.abs(v.currentTime - target) > 0.15) v.currentTime = target;
      if (v.paused) void v.play().catch(() => { /* 자동 재생 막힘 — 무음이라 보통은 된다 */ });
    } else {
      v.pause();
      if (Math.abs(v.currentTime - target) > 0.02) v.currentTime = target;
    }
  }, [sec, playing, url, video.durationSec]);

  const setVideo = (patch: Partial<NonNullable<Project['video']>>) => editor.commit({ ...project, video: { ...video, ...patch } });

  return (
    <div className={`fixed bottom-4 left-4 z-30 overflow-hidden rounded-xl border border-rule bg-screen shadow-2xl ${small ? 'w-56' : 'w-96'}`} data-video-panel>
      <div className="flex items-center gap-1.5 bg-screen-2 px-2 py-1.5 text-[11px] text-sink-2">
        <span className="min-w-0 flex-1 truncate">🎬 {video.name}</span>
        <span className="font-num text-[13px] text-sink" data-video-tc title="영상의 타임코드 (프레임 수는 곡 ▾)">{formatTimecode(Math.max(0, sec), { fps: (project.timecode ?? DEFAULT_TIMECODE).fps, startSec: 0 })}</span>
        <button type="button" onClick={() => setSmall((x) => !x)} className="rounded px-1 hover:text-sink" aria-label="영상 창 크기">{small ? '⤢' : '⤡'}</button>
        <button type="button" onClick={() => { const next = { ...project }; delete next.video; editor.commit(next); }} className="rounded px-1 hover:text-rec" aria-label="영상 빼기">✕</button>
      </div>
      {/* 소리는 곡과 겹치지 않게 끈다 — 필요하면 오디오 트랙으로 꺼낸다 */}
      {url ? <video ref={ref} src={url} muted playsInline className="block aspect-video w-full bg-black" /> : <div className="aspect-video w-full bg-black" />}
      {!small && (
        <div className="flex flex-wrap items-center gap-1.5 px-2 py-2 text-[11px] text-sink-2">
          <label className="flex items-center gap-1">곡과 어긋남
            <input aria-label="영상 시작 어긋남" type="number" step={0.1} value={video.offsetSec}
              onChange={(e) => setVideo({ offsetSec: Number(e.target.value) })}
              className="h-6 w-16 rounded border border-grid-2 bg-screen-2 px-1 text-right font-num text-[13px] text-sink" />초</label>
          <span className="flex-1" />
          <button type="button" className="h-6 rounded border border-grid-2 bg-screen-2 px-1.5 text-sink"
            title="지금 자리에 마커 — 장면이 바뀌는 곳에 음악을 맞출 때"
            onClick={() => editor.commit(addMarker(project, songTick, `장면 ${(project.markers ?? []).filter((m) => m.name.startsWith('장면')).length + 1}`).project)}>장면 마커</button>
          <button type="button" className="h-6 rounded border border-grid-2 bg-screen-2 px-1.5 text-sink"
            title="히트 포인트 — 지금 자리(장면이 바뀌는 곳)가 박에 딱 떨어지게 템포를 조금 바꿉니다"
            onClick={() => {
              if ((project.tempo.changes?.length ?? 0) > 0) { onNotice('템포 변화가 있는 곡은 자동으로 맞추지 않습니다 — 템포 줄(G)에서 그 구간을 직접 고치세요'); return; }
              const hitSec = ticksToSeconds(songTick, project.tempo);
              const fit = fitTempoToHit(project.tempo.bpm, hitSec);
              if (!fit) { onNotice(hitSec <= 0 ? '곡 처음은 이미 박 위입니다 — 장면이 바뀌는 자리로 옮긴 뒤 누르세요' : '템포를 8% 넘게 바꿔야 해서 하지 않았습니다 — 장면을 다른 박(반 박·마디)에 두는 편이 낫습니다'); return; }
              if (Math.abs(fit.bpm - project.tempo.bpm) < 0.0005) { onNotice(`이미 ${fit.beat + 1}번째 박 위에 있습니다`); return; }
              // 템포가 바뀌면 같은 틱의 시각이 바뀐다 — 장면은 "그 시각" 이므로 커서·마커가 아니라 템포만 바꾼다
              editor.commit({ ...project, tempo: { ...project.tempo, bpm: fit.bpm } });
              onNotice(`템포 ${project.tempo.bpm} → ${fit.bpm} — ${hitSec.toFixed(2)}초의 장면이 ${fit.beat + 1}번째 박에 떨어집니다 (박이 ${Math.abs(fit.wasOffSec * 1000).toFixed(0)}ms ${fit.wasOffSec < 0 ? '일렀습니다' : '늦었습니다'})`);
            }}>박에 맞추기</button>
          <button type="button" disabled={busy || exporting !== null} data-video-export
            className="h-6 rounded border border-grid-2 bg-screen-2 px-1.5 text-sink disabled:opacity-40"
            title="영상의 그림과 곡의 믹스를 한 파일(WebM)로 — 영상을 한 번 틀면서 녹화하므로 영상 길이만큼 걸립니다"
            onClick={async () => {
              try {
                setExporting(0);
                const bytes = await getAsset(video.assetId);
                if (!bytes) throw new Error('영상 파일이 없습니다');
                onNotice('곡을 그리는 중…');
                const channels = await renderMix();
                if (!channels) throw new Error('곡을 그리지 못했습니다');
                onNotice(`영상과 함께 녹화하는 중 — ${video.durationSec.toFixed(0)}초쯤 걸립니다`);
                const blob = await exportVideoWithMix({ videoBytes: bytes, channels, sampleRate: 48000, offsetSec: video.offsetSec, onProgress: setExporting });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${project.name || '곡'} - 영상.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                onNotice(`영상과 함께 내보냈습니다 (${(blob.size / 1024 / 1024).toFixed(1)}MB)`);
              } catch (err) {
                onNotice(`영상과 함께 내보내지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
              } finally { setExporting(null); }
            }}>{exporting === null ? '영상과 내보내기' : `녹화 ${Math.round(exporting * 100)}%`}</button>
          <button type="button" className="h-6 rounded border border-grid-2 bg-screen-2 px-1.5 text-sink"
            onClick={async () => {
              try {
                const bytes = await getAsset(video.assetId);
                if (!bytes) throw new Error('영상 파일이 없다');
                const { assetId, seconds } = await importAudioBytes(bytes);
                const at = Math.max(0, secondsToTicks(Math.max(0, video.offsetSec), project.tempo));
                editor.commit(placeAudio(project, { assetId, seconds, name: `${video.name} 소리`, atTick: at, trackId: null }).project);
                onNotice('영상 소리를 오디오 트랙으로 꺼냈습니다');
              } catch (err) {
                onNotice(`영상 소리를 꺼내지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
              }
            }}>소리 꺼내기</button>
        </div>
      )}
    </div>
  );
}

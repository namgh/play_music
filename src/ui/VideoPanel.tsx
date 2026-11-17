import { useEffect, useRef, useState } from 'react';

import type { Project } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { addMarker } from '../editor/arrangement.ts';
import { getAsset } from '../audio/assets.ts';
import { secondsToTicks, ticksToSeconds } from '../model/time.ts';
import { importAudioBytes, placeAudio } from './audioUi.ts';

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
}

export function VideoPanel({ editor, songTick, playing, onNotice }: VideoPanelProps) {
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
        <span className="font-num text-[13px] text-sink">{Math.max(0, sec).toFixed(1)}s</span>
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

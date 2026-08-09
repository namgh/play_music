/**
 * 내보내기 렌더 — `OfflineAudioContext` + **재생과 같은 워크렛**.
 *
 * `plan.md` 5-2 가 정한 방식이다: 내보내기는 클라이언트에서 `OfflineAudioContext`
 * 로 렌더한다. 미리듣기와 같은 코드가 같은 그래프를 만들어야 결과가 일치한다.
 *
 * 워크렛을 쓰는 것이 중요한 이유: 재생이 워크렛인데 내보내기가 다른 경로면
 * "들은 것과 파일이 다르다"가 되고, 그건 편집 도구의 신뢰를 무너뜨린다.
 *
 * **주의: 이 파일은 브라우저 전용이라 자동 검증되지 않는다.**
 * `OfflineAudioContext` 와 `AudioWorklet` 이 Node 에 없다. 공유하는 것은 보이스
 * DSP(같은 wasm), 이벤트 수집(`collectNoteEvents`), 이펙트 배선(`buildEffectChain`)
 * 이고 그 세 개는 각각 테스트된다. 남는 위험은 이 파일의 배선 자체다.
 */

import type { Project, Track } from '../model/project.ts';
import { ticksToSeconds } from '../model/time.ts';
import { projectLengthTicks } from '../model/factory.ts';
import { pitchToHz } from '../model/pitch.ts';
import { collectNoteEvents } from './scheduler.ts';
import type { InstrumentDefinition } from '../instruments/types.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import {
  curveToParams, noteOffFields, toFreeCurve, variationSeed, WASM_PARAM_ORDER,
} from './voice/wasmEngine.ts';
import { VOICE_KIND_INDEX } from '../instruments/types.ts';
import { buildEffectChain } from './effectGraph.ts';

const WORKLET_URL = '/ks-worklet.js';

export interface OfflineExportRequest {
  project: Project;
  /** 렌더할 트랙 (음소거·솔로가 이미 반영된 목록) */
  tracks: Track[];
  registry: ReadonlyMap<string, InstrumentDefinition>;
  wasmBytes: ArrayBuffer;
  sampleRate: number;
  lengthSec: number;
}

export async function renderOfflineWithWorklet(
  request: OfflineExportRequest,
): Promise<Float32Array[]> {
  const { project, tracks, registry, wasmBytes, sampleRate, lengthSec } = request;

  const offline = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.max(1, Math.ceil(lengthSec * sampleRate)),
    sampleRate,
  });
  await offline.audioWorklet.addModule(WORKLET_URL);

  const master = buildEffectChain(offline, project.master.effects);
  const masterGain = offline.createGain();
  masterGain.gain.value = project.master.gain;
  master.output.connect(masterGain).connect(offline.destination);

  const subset: Project = { ...project, tracks };
  const events = collectNoteEvents(subset, 0, projectLengthTicks(project));

  const ready: Promise<void>[] = [];

  for (const track of tracks) {
    const instrument = resolveInstrument(track.instrumentId, registry);
    const params = instrumentParams(instrument, track.toneId, track.toneParams);

    const node = new AudioWorkletNode(offline, 'ks-string', { outputChannelCount: [2] });
    const gain = offline.createGain();
    gain.gain.value = track.gain;
    const pan = offline.createStereoPanner();
    pan.pan.value = track.pan;
    const effects = buildEffectChain(offline, track.effects);
    node.connect(gain).connect(pan).connect(effects.input);
    effects.output.connect(master.input);

    // 워크렛이 wasm 을 준비했다고 알려 줄 때까지 기다린다. 준비 전에 예약하면
    // 그 메시지들이 무시돼 **음이 빠진 파일**이 나온다
    ready.push(new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('내보내기 워크렛이 응답하지 않는다')), 10000);
      node.port.onmessage = ({ data }) => {
        if (data?.type === 'ready') { clearTimeout(timer); resolve(); }
      };
      node.port.postMessage({ type: 'load', bytes: wasmBytes.slice(0) });
    }));

    // 이 트랙의 음을 프레임 시각으로 예약한다
    for (const event of events) {
      if (event.trackId !== track.id) continue;
      const merged: Record<string, number | string> = {
        ...params,
        ...curveToParams(event.pitchCurve),
        voiceKind: VOICE_KIND_INDEX[instrument.voice] ?? 0,
      };
      node.port.postMessage({
        type: 'noteOn',
        frame: Math.round(ticksToSeconds(event.startTick, project.tempo) * sampleRate),
        freq: pitchToHz(event.note.pitch, project.tuning),
        velocity: event.note.velocity,
        params: WASM_PARAM_ORDER.map((key) => {
          const value = merged[key];
          return typeof value === 'number' && Number.isFinite(value) ? value : 0;
        }),
        gain: 1,
        // 재생과 같은 형태로 자유곡선을 실어 준다
        curve: toFreeCurve(
          event.pitchCurve,
          ticksToSeconds(event.lengthTick, project.tempo),
        ),
        // 재생과 **같은 씨앗**이어야 한다. 다르면 들은 것과 파일이 달라진다
        seed: variationSeed(event.noteId),
        // 재생과 **같은 함수**로 계산한다. 갈라지면 "들은 것과 파일이 다르다"가 된다
        ...noteOffFields(
          params,
          ticksToSeconds(event.lengthTick, project.tempo),
          sampleRate,
        ),
      });
    }
  }

  await Promise.all(ready);
  const rendered = await offline.startRendering();
  return Array.from({ length: rendered.numberOfChannels }, (_, ch) => rendered.getChannelData(ch));
}

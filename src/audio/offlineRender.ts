/**
 * 오프라인 렌더 — 프로젝트 데이터를 PCM 으로 만든다.
 *
 * **용도는 검증 하나다.** 브라우저 없이 노드에서 "프로젝트 → 소리"를 돌려 음정을
 * 측정할 수 있다. 이게 없으면 데이터·스케줄러·DSP 를 이어붙인 뒤 귀 말고는 확인할
 * 방법이 없다.
 *
 * 실제 내보내기는 `bufferRenderer.exportAudio` 의 `OfflineAudioContext` 경로다
 * (`plan.md` 5-2). **이펙트·팬·마스터는 여기에 없다** — 그건 Web Audio 노드이고
 * 노드에서 만들 수 없다. 두 경로가 공유하는 것은 보이스 DSP(같은 wasm)와
 * 이벤트 수집(`collectNoteEvents`)이다. 남은 차이는 그래프 배선이며,
 * **그 부분은 자동 검증되지 않는다** (브라우저 없이 확인할 방법이 없다).
 *
 * 샘플 단위로 정확하다 — 이벤트 시각 사이를 잘라 렌더하므로 발음이 블록 경계로
 * 반올림되지 않는다. 128샘플 블록으로 뭉개면 최대 2.7ms 씩 밀린다.
 */

import type { Project } from '../model/project.ts';
import { ticksToSeconds } from '../model/time.ts';
import { pitchToHz } from '../model/pitch.ts';
import { collectNoteEvents } from './scheduler.ts';
import type { InstrumentDefinition } from '../instruments/types.ts';
import { VOICE_KIND_INDEX } from '../instruments/types.ts';
import { instrumentParams, resolveInstrument } from '../instruments/resolve.ts';
import { WaveguideStringVoice } from './voice/waveguideString.ts';
import type { Rng, Voice } from './voice/types.ts';
import type { WasmVoiceEngine } from './voice/wasmEngine.ts';
import { curveToParams, toFreeCurve, variationSeed } from './voice/wasmEngine.ts';
import { projectLengthTicks } from '../model/factory.ts';

const BLOCK = 128; // AudioWorklet 블록 크기와 같게 — 블록 경계 효과까지 같이 본다
const MAX_VOICES = 32;

export interface OfflineRenderOptions {
  sampleRate?: number;
  /** 곡이 끝난 뒤 여운을 위해 더 렌더할 시간 */
  tailSec?: number;
  /** 결정론적 결과가 필요할 때 (테스트) */
  rng?: Rng;
  /**
   * Rust DSP 코어.
   *
   * **트랙마다 하나씩 필요하다.** 앰프 체인이 엔진 인스턴스마다 하나뿐이라
   * 여러 트랙이 한 인스턴스를 공유하면 앰프 설정이 섞인다 — 퍼즈 트랙과 클린
   * 트랙이 동시에 울리면 나중에 발음한 쪽 설정이 둘 다에 걸린다 (측정 오차 101%).
   * 실제 재생·내보내기는 트랙마다 워크렛 노드를 따로 두므로 이 문제가 없고,
   * 이 함수도 같은 구조를 따라야 검증이 의미를 갖는다.
   *
   * 배열로 주면 트랙 순서대로 하나씩 쓴다. 하나만 주면 트랙이 하나일 때만 허용한다.
   */
  wasm?: WasmVoiceEngine | readonly WasmVoiceEngine[] | null;
}

function createVoice(voiceType: string, sampleRate: number, rng: Rng): Voice {
  switch (voiceType) {
    case 'waveguide-string':
      return new WaveguideStringVoice(sampleRate, rng);
    default:
      // 모달·버추얼아날로그·샘플러는 M4~M6 (`sound.md` 10절).
      // 조용히 무음을 내면 "왜 소리가 안 나지"로 시간을 버리게 된다
      throw new Error(`보이스 타입 "${voiceType}" 미구현`);
  }
}

export function renderProjectOffline(
  project: Project,
  instrumentDefs: ReadonlyMap<string, InstrumentDefinition>,
  options: OfflineRenderOptions = {},
): { pcm: Float32Array; sampleRate: number } {
  const sampleRate = options.sampleRate ?? 48000;
  const rng = options.rng ?? Math.random;
  const tailSec = options.tailSec ?? 2;

  const lengthTicks = projectLengthTicks(project);
  const totalSamples =
    Math.ceil(ticksToSeconds(lengthTicks, project.tempo) * sampleRate) +
    Math.ceil(tailSec * sampleRate);
  const pcm = new Float32Array(totalSamples);

  // 트랙별로 악기를 한 번만 해석한다 — 음마다 상속을 펼치면 낭비다
  const trackSetup = new Map<string, { params: Record<string, number | string>; voiceType: string; gain: number }>();
  for (const track of project.tracks) {
    const instrument = resolveInstrument(track.instrumentId, instrumentDefs);
    trackSetup.set(track.id, {
      params: instrumentParams(instrument, track.toneId, track.toneParams),
      voiceType: instrument.voice,
      gain: track.gain,
    });
  }

  const events = collectNoteEvents(project, 0, lengthTicks);

  // --- Rust 코어 경로 -------------------------------------------------------
  //
  // **트랙마다 엔진 인스턴스를 따로 쓴다.** 앰프가 인스턴스당 하나뿐이라
  // 공유하면 설정이 섞인다. 실제 재생·내보내기가 트랙마다 워크렛 노드를 따로
  // 두는 것과 같은 구조다 — 그래야 여기서 검증한 것이 실제 동작과 일치한다.
  if (options.wasm) {
    const pool = Array.isArray(options.wasm)
      ? (options.wasm as readonly WasmVoiceEngine[])
      : [options.wasm as WasmVoiceEngine];

    if (pool.length < project.tracks.length) {
      throw new Error(
        `엔진이 ${pool.length}개인데 트랙이 ${project.tracks.length}개다 — ` +
          '앰프 설정이 섞이므로 트랙마다 하나씩 넘겨야 한다',
      );
    }

    const scratch = new Float32Array(BLOCK);

    // 트랙별로 따로 렌더해 합산한다
    project.tracks.forEach((track, trackIndex) => {
      const setup = trackSetup.get(track.id);
      if (!setup) return;
      const wasm = pool[trackIndex]!;
      wasm.allOff();

      const trackEvents = events.filter((event) => event.trackId === track.id);
      if (trackEvents.length === 0) return;

      let cursor = 0;
      const renderTrackTo = (toSample: number) => {
        while (cursor < toSample) {
          const frames = Math.min(BLOCK, toSample - cursor);
          scratch.fill(0);
          wasm.process(scratch, frames);
          for (let i = 0; i < frames; i++) pcm[cursor + i] = pcm[cursor + i]! + scratch[i]!;
          cursor += frames;
        }
      };

      for (const event of trackEvents) {
        const startSample = Math.round(ticksToSeconds(event.startTick, project.tempo) * sampleRate);
        if (startSample >= totalSamples) break;
        renderTrackTo(startSample);
        wasm.noteOn(
          pitchToHz(event.note.pitch, project.tuning),
          event.note.velocity,
          {
            ...setup.params,
            ...curveToParams(event.pitchCurve),
            voiceKind: VOICE_KIND_INDEX[setup.voiceType as keyof typeof VOICE_KIND_INDEX] ?? 0,
          },
          setup.gain,
          // 자유곡선. 안 넘기면 **데이터에는 있고 소리에는 없는** 상태가 된다 —
          // 이 파일이 검증하는 바로 그 버그다
          toFreeCurve(event.pitchCurve, ticksToSeconds(event.lengthTick, project.tempo)),
          variationSeed(event.noteId),
        );
      }
      renderTrackTo(totalSamples);
    });

    if (project.master.gain !== 1) {
      for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! * project.master.gain;
    }
    return { pcm, sampleRate };
  }

  // 보이스 풀. 트랙마다 파라미터가 달라 발음 시점에 setParams 하므로 공용으로 쓴다
  const pool: { voice: Voice; gain: number }[] = [];
  let rr = 0;

  const renderTo = (fromSample: number, toSample: number): void => {
    for (let at = fromSample; at < toSample; at += BLOCK) {
      const frames = Math.min(BLOCK, toSample - at);
      const scratch = new Float32Array(frames);
      for (const slot of pool) {
        if (!slot.voice.active) continue;
        scratch.fill(0);
        slot.voice.process(scratch, frames);
        for (let i = 0; i < frames; i++) pcm[at + i] = pcm[at + i]! + scratch[i]! * slot.gain;
      }
    }
  };

  let cursor = 0;
  for (const event of events) {
    const startSample = Math.round(ticksToSeconds(event.startTick, project.tempo) * sampleRate);
    if (startSample >= totalSamples) break;
    if (startSample > cursor) {
      renderTo(cursor, startSample);
      cursor = startSample;
    }

    const setup = trackSetup.get(event.trackId);
    if (!setup) continue;

    let slot = pool.find((s) => !s.voice.active);
    if (!slot) {
      if (pool.length < MAX_VOICES) {
        slot = { voice: createVoice(setup.voiceType, sampleRate, rng), gain: setup.gain };
        pool.push(slot);
      } else {
        slot = pool[rr % pool.length]!; // 보이스 스틸링
        rr++;
      }
    }
    slot.gain = setup.gain;
    slot.voice.noteOn(pitchToHz(event.note.pitch, project.tuning), event.note.velocity, setup.params);
  }

  renderTo(cursor, totalSamples);

  // 마스터 게인. 리미터를 넣지 않는다 — 비선형은 오버샘플링이 전제다 (`sound.md` 6-1)
  if (project.master.gain !== 1) {
    for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! * project.master.gain;
  }

  return { pcm, sampleRate };
}

export interface RenderNoteOptions {
  voiceType: string;
  params: Readonly<Record<string, number | string>>;
  freqHz: number;
  velocity: number;
  sampleRate: number;
  /** 이 길이를 넘기면 자른다. 보이스가 먼저 조용해지면 거기서 끝난다 */
  maxSec: number;
  rng?: Rng;
}

/**
 * 음 하나를 PCM 으로. 뜯는 줄은 노트온 시점에 결과가 결정되는 원샷이므로
 * 미리 렌더해 두고 정확한 시각에 재생할 수 있다 (`bufferRenderer.ts` 가 이걸 쓴다).
 *
 * **TS 보이스는 음정 곡선을 구현하지 않는다.** 곡선은 Rust 코어에만 있다
 * (`dsp/src/curve.rs`). 여기로 오는 것은 wasm 로드가 실패한 대체 경로뿐이고,
 * 그 경우 화면에 "TypeScript (대체)" 로 표시된다.
 */
export function renderNoteToPcm(options: RenderNoteOptions): Float32Array {
  const { voiceType, params, freqHz, velocity, sampleRate, maxSec } = options;
  const voice = createVoice(voiceType, sampleRate, options.rng ?? Math.random);
  voice.noteOn(freqHz, velocity, params);

  const maxSamples = Math.ceil(maxSec * sampleRate);
  const out = new Float32Array(maxSamples);
  const scratch = new Float32Array(BLOCK);

  let written = 0;
  while (written < maxSamples && voice.active) {
    const frames = Math.min(BLOCK, maxSamples - written);
    scratch.fill(0);
    voice.process(scratch, frames);
    out.set(scratch.subarray(0, frames), written);
    written += frames;
  }

  // 보이스가 먼저 조용해졌으면 그만큼 잘라 메모리를 아낀다
  return written === maxSamples ? out : out.slice(0, written);
}

/** 구간 잘라내기 — 음 하나만 측정할 때 쓴다 */
export function slice(pcm: Float32Array, fromSec: number, toSec: number, sampleRate: number): Float32Array {
  const a = Math.max(0, Math.round(fromSec * sampleRate));
  const b = Math.min(pcm.length, Math.round(toSec * sampleRate));
  return pcm.subarray(a, b);
}

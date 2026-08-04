import { useMemo } from 'react';
import { BRAND } from './brand.ts';
import { createClip, createEmptyProject, createNote, createTrack, projectLengthTicks } from './model/factory.ts';
import { countEditedNotes, isPitchEdited } from './model/project.ts';
import { PPQ, ticksToBarBeat, ticksToSeconds } from './model/time.ts';
import { detune, formatPitch, hzToPitch, pitchToHz } from './model/pitch.ts';

/**
 * 스캐폴드 확인 화면. **제품 UI 가 아니다.**
 *
 * 스튜디오 화면은 impeccable 스킬이 담당하고 (`CLAUDE.md`), 시안은
 * `mockup/studio-v2.html` 에 있다. 여기서는 모델 계층이 실제로 동작하는지만 보여준다.
 */
export function App() {
  const demo = useMemo(() => {
    const project = createEmptyProject('첫 프로젝트');
    project.tempo.bpm = 92;
    project.key = { tonic: 'A', mode: 'minor' };

    const track = createTrack({ name: '어쿠스틱 기타', instrumentId: 'acoustic-guitar', color: 'j3' });
    const clip = createClip({ startTick: 0, lengthTick: 4 * 4 * PPQ, label: 'GTR' });

    // A4 그대로, 그리고 같은 음을 -14센트 내린 것
    const plain = createNote({ startTick: 0, lengthTick: PPQ, midi: 69 });
    const edited = createNote({ startTick: PPQ, lengthTick: PPQ, midi: 69 });
    edited.pitch = detune(edited.pitch, -14);

    clip.notes.push(plain, edited);
    track.clips.push(clip);
    project.tracks.push(track);
    return { project, clip, plain, edited };
  }, []);

  const { project, clip, plain, edited } = demo;
  const lengthTicks = projectLengthTicks(project);

  const rows: [string, string][] = [
    ['프로젝트', `${project.name} · ${project.tempo.bpm} BPM · ${project.timeSignature.num}/${project.timeSignature.den}`],
    ['길이', `${project.lengthBars}마디 = ${lengthTicks}틱 = ${ticksToSeconds(lengthTicks, project.tempo).toFixed(2)}초`],
    ['2번째 음 위치', (() => { const bb = ticksToBarBeat(edited.startTick, project.timeSignature); return `${bb.bar}.${bb.beat}.${(bb.fraction * 100).toFixed(0).padStart(2, '0')}`; })()],
    ['원래 음', formatPitch(plain.pitch, project.tuning)],
    ['−14센트 내린 음', formatPitch(edited.pitch, project.tuning)],
    ['440Hz 직접 입력 → 저장 형태', JSON.stringify(hzToPitch(440, project.tuning))],
    ['446.5Hz 직접 입력 → 저장 형태', JSON.stringify(hzToPitch(446.5, project.tuning))],
    ['다시 Hz 로', `${pitchToHz(hzToPitch(446.5, project.tuning), project.tuning).toFixed(4)} Hz`],
    ['수정한 음 (파생값)', `${countEditedNotes(clip)} / ${clip.notes.length}  (원래 음 편집됨: ${isPitchEdited(plain)})`],
  ];

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 font-sans text-neutral-200">
      <h1 className="text-3xl font-semibold tracking-tight text-white">
        {BRAND.name}
        {BRAND.isPlaceholder && (
          <span className="ml-3 align-middle text-xs font-normal text-neutral-500">이름 임시</span>
        )}
      </h1>
      <p className="mt-3 text-sm/6 text-neutral-400">
        스캐폴드 확인용 화면입니다. 제품 UI 가 아니고, 모델 계층(<code className="text-neutral-300">src/model</code>)이
        동작하는지만 보여줍니다. 스튜디오 화면 시안은 <code className="text-neutral-300">mockup/studio-v2.html</code>.
      </p>

      <dl className="mt-10 divide-y divide-neutral-800 border-y border-neutral-800 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(0,14rem)_1fr] gap-4 py-3">
            <dt className="text-neutral-500">{label}</dt>
            <dd className="font-mono text-neutral-200">{value}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}

/**
 * 곡 템플릿 — 새 곡을 빈 판이 아니라 편성으로 시작한다 (Logic 프로젝트 고르기의 템플릿,
 * `LOGIC_PARITY.md` 1-1). 트랙마다 곡 길이만큼 빈 클립을 깔아 둔다 — 없으면 고르자마자
 * "어디에 찍지?" 가 된다.
 */

import type { Project } from './project.ts';
import { createClip, createEmptyProject, createTrack, projectLengthTicks } from './factory.ts';

export interface Template {
  id: string;
  name: string;
  description: string;
  bpm: number;
  bars: number;
  key: Project['key'];
  tracks: { name: string; instrumentId: string; color: string }[];
}

export const TEMPLATES: Template[] = [
  {
    id: 'empty', name: '빈 곡', description: '트랙 하나 — 처음부터 직접', bpm: 120, bars: 8, key: null,
    tracks: [{ name: '어쿠스틱 피아노', instrumentId: 'acoustic-piano', color: 'j3' }],
  },
  {
    id: 'band', name: '밴드', description: '킥·스네어·하이햇·베이스·기타·피아노', bpm: 110, bars: 16, key: { tonic: 'E', mode: 'minor' },
    tracks: [
      { name: '킥', instrumentId: 'kick', color: 'j6' },
      { name: '스네어', instrumentId: 'snare', color: 'j6' },
      { name: '하이햇', instrumentId: 'hihat', color: 'j6' },
      { name: '베이스', instrumentId: 'electric-bass', color: 'j2' },
      { name: '일렉 기타', instrumentId: 'electric-guitar', color: 'j1' },
      { name: '피아노', instrumentId: 'acoustic-piano', color: 'j3' },
    ],
  },
  {
    id: 'electronic', name: '일렉트로닉', description: '킥·클랩·하이햇·신스 베이스·패드·리드', bpm: 124, bars: 16, key: { tonic: 'A', mode: 'minor' },
    tracks: [
      { name: '킥', instrumentId: 'kick', color: 'j6' },
      { name: '클랩', instrumentId: 'clap', color: 'j6' },
      { name: '하이햇', instrumentId: 'hihat', color: 'j6' },
      { name: '신스 베이스', instrumentId: 'synth-bass', color: 'j2' },
      { name: '패드', instrumentId: 'synth-pad', color: 'j4' },
      { name: '리드', instrumentId: 'supersaw-lead', color: 'j5' },
    ],
  },
  {
    id: 'acoustic', name: '어쿠스틱', description: '기타·콘트라베이스·셰이커·마림바', bpm: 92, bars: 16, key: { tonic: 'G', mode: 'major' },
    tracks: [
      { name: '어쿠스틱 기타', instrumentId: 'acoustic-guitar', color: 'j1' },
      { name: '콘트라베이스', instrumentId: 'double-bass-pizz', color: 'j2' },
      { name: '셰이커', instrumentId: 'shaker', color: 'j6' },
      { name: '마림바', instrumentId: 'marimba', color: 'j3' },
    ],
  },
  {
    id: 'keys', name: '피아노 솔로', description: '피아노 한 대 — 연습·작곡 스케치', bpm: 80, bars: 32, key: { tonic: 'C', mode: 'major' },
    tracks: [{ name: '어쿠스틱 피아노', instrumentId: 'acoustic-piano', color: 'j3' }],
  },
];

export function projectFromTemplate(template: Template, name?: string): Project {
  const project = createEmptyProject(name?.trim() || `새 ${template.name}`);
  project.tempo.bpm = template.bpm;
  project.lengthBars = template.bars;
  project.key = template.key;
  const length = projectLengthTicks(project);
  for (const spec of template.tracks) {
    const track = createTrack({ name: spec.name, instrumentId: spec.instrumentId, color: spec.color });
    track.clips.push(createClip({ startTick: 0, lengthTick: length, label: spec.name }));
    project.tracks.push(track);
  }
  return project;
}

/**
 * **자동 생성 — 손으로 고치지 말 것.** (악기 30개)
 *
 * `npm run instruments:index` 가 `defs/` 폴더를 읽어 만든다.
 * 악기를 추가하려면 `defs/<계열>/<id>.ts` 를 만들고 이 명령을 돌린다.
 * CI 가 최신 여부를 검사하므로, 잊으면 거기서 걸린다.
 */

import type { InstrumentCategory } from './types.ts';

export interface CatalogEntry {
  id: string;
  name: string;
  category: InstrumentCategory;
  family: string;
  /** 상속용 뼈대. 사용자에게 악기로 보이지 않는다 */
  abstract: boolean;
  /** 이 악기로 소리를 내려면 불러와야 하는 계열들 (상속을 따라 계산됨) */
  chunks: readonly string[];
}

export const INSTRUMENT_CATALOG: readonly CatalogEntry[] = [
  { id: 'acoustic-guitar', name: '어쿠스틱 기타', category: '기타', family: 'string', abstract: false, chunks: ['string'] },
  { id: 'electric-guitar-lp', name: '일렉 기타 (레스폴)', category: '기타', family: 'string', abstract: false, chunks: ['string'] },
  { id: 'electric-guitar', name: '일렉 기타 (스트랫)', category: '기타', family: 'string', abstract: false, chunks: ['string'] },
  { id: 'synth-bass', name: '신스 베이스', category: '베이스', family: 'synth', abstract: false, chunks: ['synth'] },
  { id: 'electric-bass', name: '일렉 베이스', category: '베이스', family: 'string', abstract: false, chunks: ['string'] },
  { id: 'acoustic-piano', name: '어쿠스틱 피아노', category: '피아노', family: 'piano', abstract: false, chunks: ['piano', 'string'] },
  { id: 'upright-piano', name: '업라이트 피아노', category: '피아노', family: 'piano', abstract: false, chunks: ['piano', 'string'] },
  { id: 'electric-piano-rhodes', name: '일렉 피아노 (로즈)', category: '피아노', family: 'piano', abstract: false, chunks: ['modal', 'piano'] },
  { id: 'electric-piano-wurlitzer', name: '일렉 피아노 (윌리처)', category: '피아노', family: 'piano', abstract: false, chunks: ['modal', 'piano'] },
  { id: 'clavinet', name: '클라비넷', category: '피아노', family: 'piano', abstract: false, chunks: ['piano', 'string'] },
  { id: 'synth-lead', name: '신스 리드', category: '건반·신스', family: 'synth', abstract: false, chunks: ['synth'] },
  { id: 'synth-pad', name: '신스 패드', category: '건반·신스', family: 'synth', abstract: false, chunks: ['synth'] },
  { id: 'glockenspiel', name: '글로켄슈필', category: '말렛·벨', family: 'modal', abstract: false, chunks: ['modal'] },
  { id: 'marimba', name: '마림바', category: '말렛·벨', family: 'modal', abstract: false, chunks: ['modal'] },
  { id: 'vibraphone', name: '비브라폰', category: '말렛·벨', family: 'modal', abstract: false, chunks: ['modal'] },
  { id: 'tubular-bell', name: '차임벨', category: '말렛·벨', family: 'modal', abstract: false, chunks: ['modal'] },
  { id: 'mandolin', name: '만돌린', category: '줄', family: 'string', abstract: false, chunks: ['string'] },
  { id: 'ukulele-soprano', name: '우쿨렐레 (소프라노)', category: '줄', family: 'string', abstract: false, chunks: ['string'] },
  { id: 'harp', name: '하프', category: '줄', family: 'string', abstract: false, chunks: ['string'] },
  { id: 'snare', name: '스네어', category: '드럼', family: 'drum', abstract: false, chunks: ['drum'] },
  { id: 'clap', name: '클랩', category: '드럼', family: 'drum', abstract: false, chunks: ['drum'] },
  { id: 'kick', name: '킥', category: '드럼', family: 'drum', abstract: false, chunks: ['drum'] },
  { id: 'tom', name: '탐', category: '드럼', family: 'drum', abstract: false, chunks: ['drum'] },
  { id: 'hihat', name: '하이햇', category: '드럼', family: 'drum', abstract: false, chunks: ['drum'] },
  { id: 'hihat-open', name: '하이햇 (열림)', category: '드럼', family: 'drum', abstract: false, chunks: ['drum'] },
  { id: 'synth-base', name: '신스 (기준)', category: '건반·신스', family: 'synth', abstract: true, chunks: ['synth'] },
  { id: 'modal-base', name: '모달 (기준)', category: '말렛·벨', family: 'modal', abstract: true, chunks: ['modal'] },
  { id: 'amped-string', name: '앰프 줄 (기준)', category: '줄', family: 'string', abstract: true, chunks: ['string'] },
  { id: 'string-base', name: '줄 (기준)', category: '줄', family: 'string', abstract: true, chunks: ['string'] },
  { id: 'drum-base', name: '드럼 (기준)', category: '드럼', family: 'drum', abstract: true, chunks: ['drum'] },
];

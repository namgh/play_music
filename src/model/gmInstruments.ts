/**
 * GM(General MIDI) 악기 번호 → 우리 악기.
 *
 * ## 왜 필요한가
 *
 * 밖에서 받은 곡 MIDI 를 넣으면 트랙마다 악기가 지정돼 있다. 그걸 버리면 피아노도
 * 베이스도 드럼도 전부 같은 소리로 나고, 사용자가 **트랙 수만큼 손으로 다시
 * 골라야** 한다. 16트랙짜리 곡을 넣으면 그 자리에서 포기하게 된다.
 *
 * ## 없는 악기는 없다고 적는다
 *
 * 우리는 활 악기(바이올린·첼로)와 관악기가 없다 (`plan.md` — 후순위). GM 에는
 * 있으므로 **가장 가까운 것으로 보낸다**: 지속되는 활 악기는 패드로, 관악기는
 * 신스 리드로. 정확하지 않다는 것을 알고 하는 근사이고, 악기가 생기면 여기만
 * 고치면 된다. 조용히 기타로 두는 것보다 훨씬 낫다.
 *
 * ## 10번 채널은 다르다
 *
 * GM 에서 10번 채널(0부터 세면 9)은 음 높이가 아니라 **어떤 타악기인지**를
 * 가리킨다. 우리는 드럼 하나가 악기 하나이므로, 그 채널은 음 번호에 따라
 * 여러 트랙으로 갈라야 한다 (`midi.ts` 가 그 일을 한다).
 */

/** GM 프로그램 0–127. 인덱스가 곧 프로그램 번호다 */
export const GM_PROGRAM_INSTRUMENTS: readonly string[] = [
  // 0–7 피아노
  'acoustic-piano', 'acoustic-piano', 'acoustic-piano', 'upright-piano',
  'electric-piano-rhodes', 'electric-piano-wurlitzer', 'harpsichord', 'clavinet',
  // 8–15 유율 타악기
  'celesta', 'glockenspiel', 'music-box', 'vibraphone',
  'marimba', 'xylophone', 'tubular-bell', 'koto',
  // 16–23 오르간·아코디언 (아코디언·하모니카는 없다 — 가장 가까운 것으로)
  'synth-organ', 'synth-organ', 'synth-organ', 'synth-organ',
  'synth-organ', 'synth-organ', 'synth-lead', 'synth-organ',
  // 24–31 기타
  'classical-guitar', 'acoustic-guitar', 'archtop-jazz-guitar', 'electric-guitar',
  'electric-guitar', 'electric-guitar-lp', 'electric-guitar-lp', 'electric-guitar',
  // 32–39 베이스
  'double-bass-pizz', 'electric-bass', 'electric-bass', 'electric-bass',
  'electric-bass', 'electric-bass', 'synth-bass', 'sub-bass',
  // 40–47 현 (활 악기가 없어 패드로 보낸다. 뜯는 것은 하프가 맞다)
  'synth-pad', 'synth-pad', 'synth-pad', 'double-bass-pizz',
  'synth-pad', 'harp', 'harp', 'tom-floor',
  // 48–55 앙상블·합창
  'synth-pad', 'synth-pad', 'synth-pad', 'synth-pad',
  'synth-pad', 'synth-pad', 'synth-pad', 'synth-pluck',
  // 56–63 금관 (없다 — 리드로)
  'synth-lead', 'synth-lead', 'synth-lead', 'synth-lead',
  'synth-lead', 'synth-lead', 'synth-lead', 'synth-lead',
  // 64–71 리드 목관 (없다)
  'synth-lead', 'synth-lead', 'synth-lead', 'synth-lead',
  'synth-lead', 'synth-lead', 'synth-lead', 'synth-lead',
  // 72–79 파이프 (없다)
  'synth-lead', 'synth-lead', 'synth-lead', 'synth-lead',
  'synth-lead', 'synth-lead', 'synth-lead', 'synth-lead',
  // 80–87 신스 리드
  'synth-lead', 'supersaw-lead', 'synth-lead', 'synth-pluck',
  'synth-lead', 'synth-lead', 'supersaw-lead', 'synth-bass',
  // 88–95 신스 패드
  'synth-pad', 'synth-pad', 'synth-pad', 'synth-pad',
  'synth-pad', 'synth-pad', 'synth-pad', 'synth-pad',
  // 96–103 신스 효과
  'synth-pad', 'synth-pad', 'synth-pad', 'synth-pad',
  'synth-pad', 'synth-pad', 'synth-pad', 'synth-pad',
  // 104–111 민속 악기
  'sitar', 'banjo', 'koto', 'koto',
  'kalimba', 'synth-lead', 'synth-pad', 'synth-lead',
  // 112–119 타악기성
  'crotales', 'cowbell', 'steel-drum', 'rimshot',
  'tom-floor', 'tom', 'tom', 'hihat-open',
  // 120–127 효과음 (음악적 의미가 없다 — 가장 무해한 것으로)
  'electric-guitar', 'shaker', 'shaker', 'glockenspiel',
  'synth-lead', 'tom-floor', 'shaker', 'snare',
];

/**
 * GM 드럼 맵 — 10번 채널의 **음 번호**가 어떤 타악기인지.
 *
 * 심벌(크래시·라이드·스플래시)이 우리에게 없다. 하이햇으로 보낸다 — 같은
 * 자리에서 같은 박을 치는 소리라 리듬은 살아남는다.
 */
export const GM_DRUM_INSTRUMENTS: Readonly<Record<number, string>> = {
  35: 'kick', 36: 'kick', 37: 'rimshot', 38: 'snare', 39: 'clap', 40: 'snare',
  41: 'tom-floor', 42: 'hihat', 43: 'tom-floor', 44: 'hihat', 45: 'tom',
  46: 'hihat-open', 47: 'tom', 48: 'tom-high', 49: 'crash-cymbal', 50: 'tom-high',
  // 51 라이드, 59 라이드2 — 라이드는 크래시와 다른 악기(짧게 끊기는 리듬 패턴)라
  // 크래시가 생긴 지금도 hihat 으로 남겨 둔다 (다른 대용이 없다)
  51: 'hihat', 52: 'crash-cymbal', 53: 'cowbell', 54: 'tambourine', 55: 'crash-cymbal',
  56: 'cowbell', 57: 'crash-cymbal', 58: 'shaker', 59: 'hihat',
  60: 'bongo', 61: 'bongo', 62: 'conga', 63: 'conga', 64: 'conga',
  65: 'tom-high', 66: 'tom-high', 67: 'cowbell', 68: 'cowbell',
  69: 'shaker', 70: 'shaker', 71: 'shaker', 72: 'shaker', 73: 'shaker', 74: 'shaker',
  75: 'rimshot', 76: 'rimshot', 77: 'rimshot', 78: 'conga', 79: 'conga',
  80: 'crotales', 81: 'crotales', 82: 'shaker', 83: 'tambourine', 84: 'crotales',
  85: 'rimshot', 86: 'tom-floor', 87: 'tom-floor',
};

/** 표에 없는 타악기는 짧은 클릭으로 — 리듬은 남기되 음정을 만들지 않는다 */
export const GM_DRUM_FALLBACK = 'rimshot';
/** 프로그램 체인지가 없는 채널은 GM 기본값(피아노)이다 */
export const GM_DEFAULT_PROGRAM = 0;

export function instrumentForProgram(program: number): string {
  return GM_PROGRAM_INSTRUMENTS[program] ?? GM_PROGRAM_INSTRUMENTS[GM_DEFAULT_PROGRAM]!;
}

export function instrumentForDrumNote(note: number): string {
  return GM_DRUM_INSTRUMENTS[note] ?? GM_DRUM_FALLBACK;
}

/**
 * AI 도우미가 모델에게 묻는 길. 화면은 이것만 안다 — 뒤가 무엇인지는 환경이 정한다.
 *
 * - 설치형: 껍데기(`desktop/ai.cjs`)가 Claude API 를 부른다. 키는 화면 쪽에 오지 않는다.
 * - 웹: 길이 없다 (키를 브라우저에 둘 수 없다). 나중에 우리 서버가 이 자리에 들어온다.
 * - 개발 중 시험: `globalThis.__resonaAiMock` 이 있으면 그것이 답한다 (배포판에서는 보지 않는다).
 */

export interface AiMessage { role: 'user' | 'assistant'; content: string }
export interface AiRequest { system: string; messages: AiMessage[] }
export type AiResult =
  | { ok: true; reply: unknown; usage?: { input: number; output: number }; model?: string }
  | { ok: false; code: string; message: string };

export interface AiStatus {
  /** 이 환경에서 AI 를 쓸 수 있는가 */
  available: boolean;
  /** 키가 들어 있는가 (설치형) */
  hasKey: boolean;
  /** 키를 여기서 넣을 수 있는가 */
  canSetKey: boolean;
  model: string | null;
}

interface Bridge {
  status(): Promise<{ hasKey: boolean; model: string }>;
  setKey(key: string): Promise<{ hasKey: boolean }>;
  ask(request: AiRequest): Promise<AiResult>;
}

type Mock = (request: AiRequest) => Promise<unknown> | unknown;

const bridge = (): Bridge | null => (globalThis as { resona?: { ai?: Bridge } }).resona?.ai ?? null;
const mock = (): Mock | null => (import.meta.env?.DEV ? (globalThis as { __resonaAiMock?: Mock }).__resonaAiMock ?? null : null);

export async function aiStatus(): Promise<AiStatus> {
  if (mock()) return { available: true, hasKey: true, canSetKey: false, model: '시험용 답' };
  const b = bridge();
  if (!b) return { available: false, hasKey: false, canSetKey: false, model: null };
  const s = await b.status();
  return { available: true, hasKey: s.hasKey, canSetKey: true, model: s.model };
}

export async function setAiKey(key: string): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  return (await b.setKey(key)).hasKey;
}

export async function askAi(request: AiRequest): Promise<AiResult> {
  const m = mock();
  if (m) {
    try { return { ok: true, reply: await m(request) }; } catch (err) { return { ok: false, code: 'mock', message: String(err instanceof Error ? err.message : err) }; }
  }
  const b = bridge();
  if (!b) return { ok: false, code: 'unavailable', message: 'AI 도우미는 설치한 앱에서 씁니다' };
  try { return await b.ask(request); } catch (err) { return { ok: false, code: 'bridge', message: String(err instanceof Error ? err.message : err) }; }
}

// AI 도우미 — Claude API 를 **여기(메인 프로세스)서** 부른다. 화면 쪽 스크립트는 키를 볼 수 없다.
//
// 지금은 사용자가 자기 API 키를 넣어 쓴다 (설정 → AI). 키는 OS 보관함의 키로 잠가 디스크에 둔다
// (맥 키체인 · 윈도우 DPAPI). 여러 사람에게 나눠 줄 때는 이 자리를 우리 서버 호출로 바꾼다 —
// 키를 앱에 넣어 배포하면 누구나 꺼내 쓸 수 있다.
const { app, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const MODEL = 'claude-opus-5-5';
const keyFile = () => path.join(app.getPath('userData'), 'ai-key.bin');

function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const raw = fs.readFileSync(keyFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
  } catch { return null; }
}

let schema = null;
/** 답의 모양 — 명령은 한 꼴로 펴 둔다 (안 쓰는 칸은 null). 화면 쪽 `parseAiReply` 가 다시 검사한다 */
function replyFormat() {
  if (schema) return schema;
  const { z } = require('zod');
  const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
  const note = z.object({ beat: z.number(), length: z.number(), midi: z.number(), velocity: z.number() });
  const command = z.object({
    type: z.enum(['transpose', 'tempo', 'velocity', 'quantize', 'humanize', 'length', 'legato', 'shift', 'replace']),
    semitones: z.number().nullable(),
    snapToKey: z.boolean().nullable(),
    bpm: z.number().nullable(),
    scope: z.enum(['song', 'range']).nullable(),
    factor: z.number().nullable(),
    grid: z.enum(['1/4', '1/8', '1/16', '1/32']).nullable(),
    amount: z.number().nullable(),
    beats: z.number().nullable(),
    notes: z.array(note).nullable(),
  });
  schema = betaZodOutputFormat(z.object({ reply: z.string(), options: z.array(z.string()), commands: z.array(command) }));
  return schema;
}

async function ask({ system, messages }) {
  const key = readKey();
  if (!key) return { ok: false, code: 'no_key', message: 'API 키가 없습니다 — 설정에서 넣어 주세요' };
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // 안전 분류기가 거절하면 서버가 알아서 다른 모델로 한 번 더 해 본다
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // 고른 음 몇십 개를 고치는 일이다 — 깊이 생각할 일이 아니고, 사람이 기다리고 있다
      output_config: { effort: 'low', format: replyFormat() },
      system,
      messages,
    });
    if (response.stop_reason === 'refusal') return { ok: false, code: 'refused', message: '이 요청은 처리하지 않습니다' };
    if (response.stop_reason === 'max_tokens') return { ok: false, code: 'too_long', message: '답이 너무 길어 끊겼습니다 — 더 작은 부분을 골라 다시 해 주세요' };
    if (!response.parsed_output) return { ok: false, code: 'bad_reply', message: '답을 읽지 못했습니다 — 다시 해 주세요' };
    return { ok: true, reply: response.parsed_output, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens }, model: response.model };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return { ok: false, code: 'bad_key', message: 'API 키가 맞지 않습니다 — 설정에서 다시 넣어 주세요' };
    if (error instanceof Anthropic.PermissionDeniedError) return { ok: false, code: 'forbidden', message: '이 키로는 이 모델을 쓸 수 없습니다' };
    if (error instanceof Anthropic.RateLimitError) return { ok: false, code: 'rate_limited', message: '요청이 많습니다 — 잠시 뒤에 다시 해 주세요' };
    if (error instanceof Anthropic.APIConnectionError) return { ok: false, code: 'offline', message: '인터넷에 연결되지 않았습니다' };
    if (error instanceof Anthropic.APIError) return { ok: false, code: 'api', message: `AI 서버 오류 (${error.status ?? '?'})` };
    return { ok: false, code: 'unknown', message: String(error && error.message || error).slice(0, 200) };
  }
}

function register() {
  ipcMain.handle('resona:ai-status', () => ({ hasKey: !!readKey(), fromEnv: !!process.env.ANTHROPIC_API_KEY, model: MODEL }));
  ipcMain.handle('resona:ai-set-key', (_e, key) => {
    const text = String(key || '').trim();
    if (!text) { fs.rmSync(keyFile(), { force: true }); return { hasKey: !!process.env.ANTHROPIC_API_KEY }; }
    fs.writeFileSync(keyFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8'), { mode: 0o600 });
    return { hasKey: true };
  });
  ipcMain.handle('resona:ai-ask', (_e, request) => ask(request || {}));
}

module.exports = { register, MODEL };

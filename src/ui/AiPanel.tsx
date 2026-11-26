import { useEffect, useRef, useState } from 'react';

import type { ClipId, Project } from '../model/project.ts';
import type { ProjectEditor } from '../editor/useProjectEditor.ts';
import { findClip } from '../editor/edits.ts';
import {
  AI_SYSTEM, applyAiCommands, buildContext, buildUserMessage, describeCommand, describeTarget, parseAiReply, resolveTarget,
} from '../ai/edits.ts';
import type { AiCommand, AiTarget } from '../ai/edits.ts';
import { aiStatus, askAi, setAiKey } from '../ai/transport.ts';
import type { AiMessage, AiStatus } from '../ai/transport.ts';

/**
 * AI 도우미 — 오른쪽 칸의 넷째 탭 (시안 A, `design/screens/a25-ai-a-tab`).
 *
 * **고른 것에 대고 말한다.** 모델은 편집 명령을 고르고(`ai/edits.ts`), 여기서는 그것을
 * "무엇이 바뀌는지" 로 먼저 보여 준 뒤 미리 듣기 · 적용 · 취소를 받는다. 적용은 한 번의 commit 이라
 * ⌘Z 한 번으로 돌아간다. 뜻이 둘이면 모델이 되묻고, 그 선택지를 단추로 보여 준다.
 */

export interface AiPanelProps {
  project: Project;
  editor: ProjectEditor;
  clipId: ClipId | null;
  playing: boolean;
  /** 곡의 그 자리부터 튼다 (미리 듣기) */
  onPlayFrom: (tick: number) => void;
  onStop: () => void;
}

type Turn =
  | { kind: 'me'; text: string }
  | { kind: 'ai'; text: string; options: string[]; plan: Plan | null; error?: boolean };

interface Plan {
  commands: AiCommand[];
  target: AiTarget;
  label: string;
  /** pending 제안만 · preview 곡에 넣고 듣는 중 · applied 적용 · canceled 취소 */
  state: 'pending' | 'preview' | 'applied' | 'canceled';
}

const QUICK: [string, string][] = [
  ['높게', '이 부분을 조금 높게'], ['낮게', '이 부분을 조금 낮게'], ['빠르게', '이 부분을 조금 빠르게'], ['느리게', '이 부분을 조금 느리게'],
  ['세게', '이 부분을 조금 세게'], ['여리게', '이 부분을 조금 여리게'], ['박자 맞추기', '박자를 맞춰 줘'], ['사람처럼', '사람이 친 것처럼'],
];

const BTN = 'inline-flex h-[30px] items-center gap-1.5 rounded-full border border-rule bg-body px-3 text-xs text-ink disabled:opacity-40';
const GO = 'inline-flex h-[30px] items-center rounded-full bg-cta px-3 text-xs font-semibold text-cta-ink disabled:opacity-40';

export function AiPanel({ project, editor, clipId, playing, onPlayFrom, onStop }: AiPanelProps) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [usage, setUsage] = useState(0);
  const end = useRef<HTMLDivElement | null>(null);
  // 모델에게 보내는 지난 대화 (화면의 말풍선과 따로 — 곡 맥락은 매번 새로 붙인다)
  const history = useRef<AiMessage[]>([]);

  useEffect(() => { void aiStatus().then(setStatus); }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns, busy]);

  const target = resolveTarget(project, clipId, editor.selection);
  const label = target ? describeTarget(project, target) : '';

  const patchPlan = (index: number, state: Plan['state']) => setTurns((list) => list.map((t, i) => (
    i === index && t.kind === 'ai' && t.plan ? { ...t, plan: { ...t.plan, state } } : t)));

  /** 제안을 곡에 넣는다 — commit 한 번. 고른 음은 바뀐 음을 따라간다 */
  const put = (plan: Plan) => {
    const out = applyAiCommands(editor.project, plan.target, plan.commands, Date.now() % 100000);
    editor.commit(out.project);
    if (plan.target.partial || plan.commands.some((c) => c.type === 'replace')) editor.select(out.target.noteIds);
  };

  const send = async (request: string) => {
    const ask = request.trim();
    if (!ask || busy) return;
    setText('');
    setTurns((list) => [...list, { kind: 'me', text: ask }]);
    if (!target) {
      setTurns((list) => [...list, { kind: 'ai', text: '먼저 타임라인에서 고칠 클립을 누르거나, 아래 편집기에서 음을 골라 주세요.', options: [], plan: null }]);
      return;
    }
    setBusy(true);
    const messages: AiMessage[] = [...history.current.slice(-6), { role: 'user', content: buildUserMessage(buildContext(project, target), ask) }];
    const result = await askAi({ system: AI_SYSTEM, messages });
    setBusy(false);
    if (!result.ok) {
      setTurns((list) => [...list, { kind: 'ai', text: result.message, options: [], plan: null, error: true }]);
      if (result.code === 'no_key' || result.code === 'bad_key') setStatus((s) => (s ? { ...s, hasKey: false } : s));
      return;
    }
    const reply = parseAiReply(result.reply);
    if (result.usage) setUsage((n) => n + result.usage!.input + result.usage!.output);
    history.current = [...history.current, { role: 'user', content: `요청: ${ask}` }, { role: 'assistant', content: JSON.stringify({ reply: reply.reply, options: reply.options, commands: reply.commands.map((c) => (c.type === 'replace' ? { type: 'replace', notes: `(${c.notes.length} notes)` } : c)) }) }];
    const plan: Plan | null = reply.commands.length > 0 ? { commands: reply.commands, target, label, state: 'pending' } : null;
    setTurns((list) => [...list, {
      kind: 'ai',
      text: reply.reply || (plan ? '이렇게 바꾸겠습니다.' : reply.options.length ? '어느 쪽인가요?' : '바꿀 것을 찾지 못했습니다. 다르게 말해 주세요.'),
      options: plan ? [] : reply.options,
      plan,
    }]);
  };

  if (status === null) return <div className="p-3 text-xs text-ink-3">불러오는 중…</div>;

  if (!status.available) {
    return (
      <div className="space-y-2 rounded-xl border border-rule bg-body p-4 text-sm text-ink-2" data-ai-unavailable>
        <p className="font-semibold text-ink">AI 도우미는 설치한 앱에서 씁니다</p>
        <p className="text-xs">고른 부분에 "조금 높게", "더 빠르게"처럼 말해서 고치는 기능입니다. 브라우저에는 API 키를 안전하게 둘 곳이 없어 설치형에만 있습니다.</p>
      </div>
    );
  }

  if (!status.hasKey) {
    return (
      <form className="space-y-3 rounded-xl border border-rule bg-body p-4 text-sm" data-ai-key
        onSubmit={async (e) => {
          e.preventDefault();
          setKeyError(null);
          if (!key.trim().startsWith('sk-ant-')) { setKeyError('Claude API 키는 sk-ant- 로 시작합니다'); return; }
          const ok = await setAiKey(key);
          setKey('');
          if (ok) setStatus({ ...status, hasKey: true }); else setKeyError('키를 저장하지 못했습니다');
        }}>
        <p className="font-semibold text-ink">Claude API 키를 넣어 주세요</p>
        <p className="text-xs text-ink-2">키는 이 컴퓨터에만 암호화해 두고, AI 에게 물을 때만 씁니다. 곡에서는 음표와 코드만 보내고 녹음한 소리는 보내지 않습니다.</p>
        <input id="ai-key" aria-label="Claude API 키" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…"
          className="h-9 w-full rounded-md border border-rule bg-body px-2 font-mono text-xs text-ink" />
        {keyError && <p className="text-xs text-rec">{keyError}</p>}
        <button type="submit" disabled={!key.trim()} className={GO}>저장</button>
      </form>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 text-[13px] leading-normal text-ink" data-ai-panel>
      <div className="flex items-center gap-2 rounded-[10px] bg-panel px-2.5 py-2 text-xs text-ink-2" data-ai-target>
        <i className={`h-2 w-2 shrink-0 rounded-full ${target ? 'bg-acc' : 'bg-rule'}`} />
        {target ? <span>고른 것 <b className="font-semibold text-ink">{label}</b>{target.partial ? ' (고른 음만)' : ''}</span> : <span>고칠 클립이나 음을 먼저 골라 주세요</span>}
      </div>

      <div className="flex min-h-[8rem] flex-1 flex-col gap-2.5 overflow-y-auto" aria-live="polite">
        {turns.length === 0 && (
          <p className="px-1 text-xs text-ink-3">고른 부분을 어떻게 바꿀지 말해 보세요. 바꾸기 전에 무엇이 바뀌는지 먼저 보여 드리고, 적용한 뒤에도 ⌘Z 로 되돌릴 수 있습니다.</p>
        )}
        {turns.map((t, i) => (t.kind === 'me' ? (
          <div key={i} className="max-w-[86%] self-end rounded-[14px_14px_4px_14px] bg-ink px-3 py-2 text-body">{t.text}</div>
        ) : (
          <div key={i} data-ai-reply className={`flex max-w-[94%] flex-col gap-2 self-start rounded-[14px_14px_14px_4px] border bg-body px-3 py-2.5 ${t.error ? 'border-rec' : 'border-rule'}`}>
            <span>{t.text}</span>
            {t.plan && (
              <>
                <div className="flex flex-col gap-1.5 rounded-[10px] bg-screen px-3 py-2.5 text-sink" data-ai-plan={t.plan.state}>
                  <small className="text-[11px] text-sink-2">{t.plan.state === 'applied' ? '적용함' : t.plan.state === 'canceled' ? '취소함' : t.plan.state === 'preview' ? '듣는 중 · 아직 확정 전' : '바꿀 것 · 아직 적용 전'} · {t.plan.label}</small>
                  {t.plan.commands.map((c, k) => { const d = describeCommand(c, project); return (
                    <div key={k} className="flex flex-wrap items-baseline gap-x-2.5"><span className="font-num text-[22px] text-acc">{d.big}</span><span className="text-xs">{d.text}</span></div>
                  ); })}
                </div>
                {(t.plan.state === 'pending' || t.plan.state === 'preview') && (
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className={BTN} data-ai-preview onClick={() => {
                      const plan = t.plan!;
                      if (plan.state === 'pending') { put(plan); patchPlan(i, 'preview'); }
                      if (playing) { onStop(); return; }
                      const found = findClip(editor.project, plan.target.clipId);
                      if (found) onPlayFrom(found.clip.startTick);
                    }}>{playing && t.plan.state === 'preview' ? '■ 멈춤' : '▶ 미리 듣기'}</button>
                    <button type="button" className={GO} data-ai-apply onClick={() => { if (t.plan!.state === 'pending') put(t.plan!); patchPlan(i, 'applied'); }}>적용</button>
                    <button type="button" className={BTN} data-ai-cancel onClick={() => { if (t.plan!.state === 'preview') { onStop(); editor.undo(); } patchPlan(i, 'canceled'); }}>취소</button>
                  </div>
                )}
                {t.plan.state === 'applied' && (
                  <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
                    <i className="grid h-3.5 w-3.5 place-items-center rounded-full bg-ok text-[10px] font-bold not-italic text-[#06301f]">✓</i>적용했습니다 — ⌘Z 로 되돌립니다
                  </div>
                )}
              </>
            )}
            {t.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {t.options.map((o) => <button key={o} type="button" className={BTN} data-ai-option disabled={busy} onClick={() => void send(o)}>{o}</button>)}
              </div>
            )}
          </div>
        )))}
        {busy && <div className="self-start rounded-[14px] border border-rule px-3 py-2 text-xs text-ink-3" data-ai-busy>생각하는 중…</div>}
        <div ref={end} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {QUICK.map(([name, ask]) => (
          <button key={name} type="button" disabled={busy || !target} onClick={() => void send(ask)}
            className="h-[26px] rounded-full bg-panel px-2.5 text-xs text-ink-2 hover:text-ink disabled:opacity-40">{name}</button>
        ))}
      </div>
      <form className="flex items-center gap-2 rounded-[22px] border border-rule bg-body py-1.5 pl-3.5 pr-1.5" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input id="ai-ask" aria-label="AI 에게 말하기" value={text} onChange={(e) => setText(e.target.value)}
          // 자판 연주·단축키가 이 칸의 글자를 가로채지 않게
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={target ? '고른 부분을 어떻게 바꿀까요?' : '먼저 클립이나 음을 고르세요'}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3" />
        <button type="submit" aria-label="보내기" disabled={busy || !text.trim()} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-sm text-body disabled:opacity-40">↑</button>
      </form>
      <div className="flex justify-between gap-2 text-[11px] text-ink-3">
        <span>음표와 코드만 보냅니다 · 녹음한 소리는 보내지 않습니다</span>
        <span className="shrink-0">{usage > 0 ? `토큰 ${usage.toLocaleString()}` : status.model}</span>
      </div>
    </div>
  );
}

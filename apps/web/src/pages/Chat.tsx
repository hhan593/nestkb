import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, Copy, MessageSquarePlus, Square, ThumbsDown, ThumbsUp, FileSearch, CircleAlert, X, Menu } from 'lucide-react';
import { api, apiStream } from '../lib/api';
import { parseSseStream } from '../lib/sse';
import { useAuth } from '../lib/auth';
import { parseBlocks, renderInline } from '../components/markdown';

import {
  fmtCost,
  REASON_LABEL,
  type CitationDto,
  type Conversation,
  type MessageDto,
  type RetrievalMetaDto,
  type UsageDto,
} from '../lib/types';

interface StreamMeta {
  messageId: string;
  retrieval: RetrievalMetaDto;
}

interface LiveMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: CitationDto[] | null;
  status?: 'completed' | 'failed' | 'aborted' | 'streaming';
  meta?: RetrievalMetaDto | null;
  usage?: UsageDto | null;
  latencyMs?: number | null;
  error?: { code: string; message: string } | null;
  createdAt: string;
}

const ERROR_HINT: Record<string, string> = {
  NO_EVIDENCE: '知识库中没有检索到相关依据。可以先上传相关文档，或换个问法。',
  QUOTA_EXCEEDED: '部门月度配额已用尽，问答已降级。请联系管理员调整预算（检索不受影响）。',
  RATE_LIMITED: '提问太频繁，稍等片刻再试。',
  INJECTION_BLOCKED: '该问题包含不允许的指令内容。',
  UPSTREAM_ERROR: '模型服务暂时不可用，可稍后重试。',
  HTTP_ERROR: '请求失败，请确认服务已启动。',
  STREAM_INTERRUPTED: '连接中断，回答可能不完整。可点重试重新生成。',
};

/** 这些错误重试有意义（配额/注入拦截之类重试也是同样结果，不给入口） */
const RETRYABLE_ERRORS = new Set(['STREAM_INTERRUPTED', 'UPSTREAM_ERROR', 'HTTP_ERROR', 'RATE_LIMITED']);

export default function Chat() {
  const { me, refreshMe } = useAuth();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'rag' | 'chat'>('rag');
  const [streaming, setStreaming] = useState(false);
  const [convLoading, setConvLoading] = useState(false);
  // rating 必须由「点的是哪个按钮」决定：原来用「是否勾了原因」推导，先点👎勾原因、关掉再点👍会提交 down（#35）
  const [fbTarget, setFbTarget] = useState<{ messageId: string; rating: 'up' | 'down'; x: number; y: number } | null>(null);
  const [fbReasons, setFbReasons] = useState<string[]>([]);
  const [fbComment, setFbComment] = useState('');
  const [fbDone, setFbDone] = useState<Record<string, 'up' | 'down'>>({});
  const [fbBusy, setFbBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  /** 移动端：会话栏是抽屉，≤900px 时默认收起（桌面端该状态无效果） */
  const [convDrawerOpen, setConvDrawerOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<LiveMessage[]>([]);
  messagesRef.current = messages;
  // 输入框与流式状态走 ref：send/retry 因此不依赖每次按键都变的 input，
  // 回调引用保持稳定，MessageView 的 memo 才真正生效（否则每帧 delta 都会重渲全部历史消息）
  const inputRef = useRef(input);
  inputRef.current = input;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  const loadConvs = useCallback(async () => {
    // 三处 void loadConvs() 都会吞掉 rejection：401/500 时会话列表静默为空，用户只看到"还没有会话"
    try {
      setConvs(await api<Conversation[]>('/qa/conversations'));
    } catch (err) {
      setPageError(err instanceof Error ? err.message : '加载会话列表失败');
    }
  }, []);

  useEffect(() => {
    void loadConvs();
  }, [loadConvs]);

  const activeConvRef = useRef<string | null>(null);

  const openConv = useCallback(async (id: string) => {
    setConvDrawerOpen(false); // 移动端：选中会话后收起抽屉，把内容区让出来
    abortRef.current?.abort(); // 切换会话前终止仍在进行的流式回答，避免旧内容串台
    activeConvRef.current = id;
    setActiveConv(id);
    setMessages([]); // 立即清空，避免上一会话内容残留到加载完成后突然替换（闪屏）
    setConvLoading(true);
    try {
      const detail = await api<{ messages: MessageDto[] }>(`/qa/conversations/${id}`);
      if (activeConvRef.current !== id) return; // 已切换到其他会话，丢弃过期响应
      setMessages(
        detail.messages
          .filter((m) => m.content !== '' || m.role === 'user')
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            citations: m.citations,
            status: m.status,
            meta: m.retrievalSnapshot ? { topK: 0, hitCount: m.retrievalSnapshot.hitCount, rerankDegraded: m.retrievalSnapshot.rerankDegraded, latencyMs: m.latencyMs ?? 0 } : null,
            createdAt: m.createdAt,
          })),
      );
    } catch (err) {
      if (activeConvRef.current === id) setPageError(err instanceof Error ? err.message : '加载会话失败');
    } finally {
      if (activeConvRef.current === id) setConvLoading(false);
    }
  }, []);

  useEffect(() => {
    // stick-to-bottom：仅当用户本身在底部附近才跟随流式输出滚动，否则阅读上文会被强行拽回
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 120) el.scrollTo({ top: el.scrollHeight });
  }, [messages]);

  const removeConv = useCallback(async (id: string) => {
    // 破坏性操作先确认：与删除文档（Documents 页）保持一致，误触不该丢掉整段对话
    const title = convs.find((c) => c.id === id)?.title || '新会话';
    if (!window.confirm(`删除会话「${title}」？删除后无法恢复。`)) return;
    try {
      await api(`/qa/conversations/${id}`, { method: 'DELETE' });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : '删除会话失败');
      return;
    }
    if (activeConv === id) {
      abortRef.current?.abort();
      setActiveConv(null);
      setMessages([]);
      setConvDrawerOpen(false);
    }
    void loadConvs();
  }, [activeConv, convs, loadConvs]);

  const newConv = useCallback(async () => {
    try {
      const conv = await api<Conversation>('/qa/conversations', { body: {} });
      await loadConvs();
      abortRef.current?.abort();
      activeConvRef.current = conv.id;
      setActiveConv(conv.id);
      setMessages([]);
      setConvDrawerOpen(false);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : '新建会话失败');
    }
  }, [loadConvs]);

  /** override 供「重试」用：直接重放指定问题，而不是读输入框 */
  // 同步防重入闸门：建会话的 await 期间 streaming 尚未置位，必须用 ref 在入口就挡住连击
  const busyRef = useRef(false);
  const send = useCallback(async (override?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const question = (override ?? inputRef.current).trim();
    if (!question || streamingRef.current) {
      busyRef.current = false;
      return;
    }
    let convId = activeConv;
    try {
      if (!convId) {
        const conv = await api<Conversation>('/qa/conversations', { body: {} });
        await loadConvs();
        activeConvRef.current = conv.id;
        setActiveConv(conv.id);
        convId = conv.id;
      }
    } catch (err) {
      // 建会话失败：还原输入并提示，不让 Promise 链静默失败
      setPageError(err instanceof Error ? err.message : '创建会话失败，请重试');
      busyRef.current = false;
      return;
    }
    setPageError(null);
    if (override === undefined) setInput('');
    setStreaming(true);
    const userMsg: LiveMessage = { id: `u-${Date.now()}`, role: 'user', content: question, createdAt: new Date().toISOString() };
    const draftId = `a-${Date.now()}`;
    const draftMsg: LiveMessage = { id: draftId, role: 'assistant', content: '', status: 'streaming', createdAt: new Date().toISOString() };
    const nextMessages = [...messagesRef.current, userMsg, draftMsg];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    let currentId = draftId;

    const controller = new AbortController();
    abortRef.current = controller;
    const streamConvId = convId;
    // meta 事件会把草稿 id 换成服务端 messageId —— patch 必须跟随当前 id。
    // 注意：不用函数式更新（updater 在并发场景下可能基于过期闭包），直接以 ref 中的最新数组替换。
    const latestRef = { current: messagesRef.current };
    const patch = (fn: (m: LiveMessage) => LiveMessage) => {
      if (activeConvRef.current !== streamConvId) return; // 已切换会话，丢弃流式写入，防止串台
      const next = latestRef.current.map((m) => (m.id === currentId ? fn(m) : m));
      latestRef.current = next;
      setMessages(next);
    };

    /** 是否收到过 done/error：没有终结事件就结束的流必须由前端兜底置为失败，否则气泡永远转圈（#29） */
    let terminated = false;
    try {
      const res = await apiStream(`/qa/conversations/${convId}/messages`, { question, mode }, controller.signal);
      for await (const ev of parseSseStream(res, controller.signal)) {
        if (ev.event === 'meta') {
          const serverId = ev.data.messageId;
          patch((m) => ({ ...m, id: serverId, meta: ev.data.retrieval }));
          currentId = serverId;
        } else if (ev.event === 'delta') {
          patch((m) => ({ ...m, content: m.content + ev.data.text }));
        } else if (ev.event === 'citations') {
          patch((m) => ({ ...m, citations: ev.data.citations }));
        } else if (ev.event === 'usage') {
          patch((m) => ({ ...m, usage: ev.data }));
        } else if (ev.event === 'done') {
          terminated = true;
          patch((m) => ({ ...m, status: 'completed', latencyMs: ev.data.latencyMs }));
        } else if (ev.event === 'error') {
          terminated = true;
          patch((m) => ({ ...m, status: 'failed', error: { code: ev.data.code, message: ev.data.message } }));
        }
      }
      if (!terminated && !controller.signal.aborted) {
        patch((m) =>
          m.status === 'streaming'
            ? { ...m, status: 'failed', error: { code: 'STREAM_INTERRUPTED', message: '连接中断，回答可能不完整' } }
            : m,
        );
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        patch((m) => ({ ...m, status: 'failed', error: { code: 'HTTP_ERROR', message: err instanceof Error ? err.message : '网络异常' } }));
      } else {
        patch((m) => ({ ...m, status: 'aborted' }));
      }
    } finally {
      // 只有自己仍是当前流时才回收全局状态：切会话后立刻提问，旧流的 finally 不能把新流的
      // 控制器清掉、也不能提前解锁输入框（否则停止按钮失效、streaming 与真实请求不一致）
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStreaming(false);
      }
      busyRef.current = false; // 释放入口闸门（本函数所有退出路径都经这里）
      void refreshMe(); // 配额变化
      void loadConvs(); // 会话标题更新
    }
  }, [activeConv, loadConvs, refreshMe, mode]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** 重试：移除失败气泡与它对应的提问，再用同一句话重发（否则同一问题会在列表里堆两遍） */
  const retry = useCallback(
    (assistantId: string) => {
      if (streamingRef.current) return;
      const list = messagesRef.current;
      const idx = list.findIndex((m) => m.id === assistantId);
      if (idx < 1) return;
      for (let i = idx - 1; i >= 0; i--) {
        if (list[i].role !== 'user') continue;
        const question = list[i].content;
        const next = list.filter((_, j) => j !== idx && j !== i);
        messagesRef.current = next;
        setMessages(next);
        void send(question);
        return;
      }
    },
    [send],
  );

  /** 打开反馈弹窗：rating 由按钮决定，坐标用按钮自身的 rect（键盘触发时 clientX/Y 是 0） */
  const openFeedback = useCallback((messageId: string, rating: 'up' | 'down', anchor: DOMRect) => {
    if (messageId.startsWith('u-') || messageId.startsWith('a-')) return; // 尚未落库的流式消息
    setFbReasons([]); // 上一轮的勾选不能带到这一次，否则会把 👍 提交成 down
    setFbComment('');
    setFbTarget({ messageId, rating, x: anchor.left, y: anchor.bottom + 8 });
  }, []);

  const submitFeedback = useCallback(async (messageId: string, rating: 'up' | 'down', reasons: string[], comment: string) => {
    if (fbBusy) return;
    if (messageId.startsWith('u-') || messageId.startsWith('a-')) return; // 尚未落库的流式消息
    setFbBusy(true);
    try {
      await api(`/messages/${messageId}/feedback`, { body: { rating, reasons, comment: comment || undefined } });
      setFbDone((prev) => ({ ...prev, [messageId]: rating }));
      setFbTarget(null);
      setFbReasons([]);
      setFbComment('');
    } catch (err) {
      setPageError(err instanceof Error ? err.message : '提交反馈失败');
    } finally {
      setFbBusy(false);
    }
  }, [fbBusy]);

  return (
    <div className="chat-wrap">
      {convDrawerOpen && <div className="conv-scrim" onClick={() => setConvDrawerOpen(false)} />}
      <aside className={`conv-list${convDrawerOpen ? ' open' : ''}`}>
        <div className="conv-head">
          <button className="btn btn-primary" style={{ justifyContent: 'center' }} onClick={() => void newConv()}>
            <MessageSquarePlus /> 新会话
          </button>
          <button className="icon-btn conv-drawer-close" title="收起会话列表" onClick={() => setConvDrawerOpen(false)}>
            <X />
          </button>
        </div>
        <div className="conv-scroll">
          {convs.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)', textAlign: 'center', padding: 16 }}>还没有会话</div>}
          {convs.map((c) => (
            <div key={c.id} className={`conv-item-row${c.id === activeConv ? ' active' : ''}`}>
              <button className={`conv-item${c.id === activeConv ? ' active' : ''}`} onClick={() => void openConv(c.id)}>
                {c.title || '新会话'}
              </button>
              <button className="icon-btn conv-del" title="删除会话" onClick={() => void removeConv(c.id)}>
                <X />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="chat-main">
        {/* 移动端：会话栏变成抽屉，必须有一个常驻入口，否则新建/切换会话都没有入口 */}
        <div className="chat-mobile-bar">
          <button className="icon-btn" title="会话列表" onClick={() => setConvDrawerOpen(true)}>
            <Menu />
          </button>
          <span className="conv-title">{convs.find((c) => c.id === activeConv)?.title || '新会话'}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => void newConv()}>
            <MessageSquarePlus /> 新会话
          </button>
        </div>
        {pageError && (
          <div className="alert-banner alert-critical" style={{ margin: '12px 16px 0', maxWidth: 640 }}>
            <CircleAlert />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{pageError}</span>
              <button className="icon-btn" title="关闭" onClick={() => setPageError(null)}>
                <X />
              </button>
            </div>
          </div>
        )}
        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-inner">
            {messages.length === 0 && !convLoading && (
              <div className="empty" style={{ marginTop: 80 }}>
                <FileSearch />
                <div className="empty-title">{mode === 'chat' ? '随便聊聊' : '问一个制度问题'}</div>
                <div>
                  {mode === 'chat'
                    ? '自由对话模式：不检索知识库，回答不带引用。'
                    : '回答基于本部门可见的知识库文档，每条结论都带出处。'}
                </div>
              </div>
            )}
            {convLoading && <div className="spinner" style={{ margin: '40px auto' }} />}
            {messages.map((m) => (
              <MessageView
                key={m.id}
                m={m}
                fb={fbDone[m.id]}
                onFeedback={openFeedback}
                onRetry={retry}
              />
            ))}
          </div>
        </div>

        <div className="chat-inputbar">
          <div style={{ display: 'flex', gap: 6, maxWidth: 760, margin: '0 auto 8px', width: '100%' }}>
            {(['rag', 'chat'] as const).map((m) => (
              <button
                key={m}
                className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setMode(m)}
                disabled={streaming}
                title={m === 'rag' ? '检索本部门知识库，答案带引用出处' : '不检索知识库，直接与模型对话'}
              >
                {m === 'rag' ? '知识库问答' : '自由对话'}
              </button>
            ))}
          </div>
          <div className="chat-inputbox">
            <textarea
              rows={1}
              placeholder={me ? `问点什么，${me.email.split('@')[0]}…（Enter 发送，Shift+Enter 换行）` : ''}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 140) + 'px';
              }}
              onKeyDown={(e) => {
                // IME 合成态（拼音候选确认）的 Enter 不代表发送
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={streaming}
            />
            {streaming ? (
              <button className="chat-send" title="停止生成" aria-label="停止生成" onClick={stop}>
                <Square fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button className="chat-send" title="发送" aria-label="发送" disabled={!input.trim()} onClick={() => void send()}>
                <ArrowUp />
              </button>
            )}
          </div>
          <div className="chat-hintline">
            {mode === 'chat'
              ? '自由对话 · 不检索知识库 · 回答无出处，请自行核实'
              : '回答仅基于知识库可见文档 · 引用可点开核对原文 · 无依据时会明确拒答'}
          </div>
        </div>
      </div>

      {fbTarget && (
        <FeedbackPopover
          pos={fbTarget}
          rating={fbTarget.rating}
          reasons={fbReasons}
          onToggle={(r) => setFbReasons((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))}
          comment={fbComment}
          onComment={setFbComment}
          onClose={() => setFbTarget(null)}
          onSubmit={() => void submitFeedback(fbTarget.messageId, fbTarget.rating, fbReasons, fbComment)}
          busy={fbBusy}
        />
      )}
    </div>
  );
}

const MessageView = memo(function MessageView({
  m,
  fb,
  onFeedback,
  onRetry,
}: {
  m: LiveMessage;
  fb?: 'up' | 'down';
  /** 父级用稳定引用（useCallback），配合 memo 避免每帧 delta 重渲全部历史消息 */
  onFeedback: (messageId: string, rating: 'up' | 'down', anchor: DOMRect) => void;
  onRetry: (messageId: string) => void;
}) {
  const retryable = m.status === 'failed' && !!m.error && RETRYABLE_ERRORS.has(m.error.code);
  if (m.role === 'user') {
    return (
      <div className="msg-user">
        <div className="msg-user-bubble">{m.content}</div>
      </div>
    );
  }
  const failed = m.status === 'failed' && m.error;
  return (
    <div className="msg-assistant">
      <div className="msg-role">
        <span className="msg-role-dot">K</span>
        <span>NestKB</span>
        {m.meta?.mode === 'chat' && <span>· 自由对话</span>}
        {m.meta && m.meta.hitCount > 0 && <span>· 检索 {m.meta.hitCount} 块 · {m.meta.latencyMs}ms</span>}
        {m.meta?.rerankDegraded && <span className="badge badge-warn">rerank 降级</span>}
        {m.usage && <span className="num">· {fmtCost(m.usage.costEstimated)} 元</span>}
      </div>

      {failed ? (
        <div className="alert-banner alert-critical" style={{ margin: 0, maxWidth: 640 }}>
          <CircleAlert />
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <b>{m.error!.code === 'NO_EVIDENCE' ? '没有找到依据' : '问答失败'}</b>
              <div style={{ fontWeight: 400 }}>{ERROR_HINT[m.error!.code] ?? m.error!.message}</div>
            </div>
            {retryable && (
              <button className="btn btn-sm btn-ghost" onClick={() => onRetry(m.id)}>
                重试
              </button>
            )}
          </div>
        </div>
      ) : (
        <AnswerText content={m.content} citations={m.citations ?? []} streaming={m.status === 'streaming'} />
      )}

      {m.citations && m.citations.length > 0 && <CitationList citations={m.citations} />}

      {!failed && m.status !== 'streaming' && m.content && (
        <div className="msg-meta">
          {m.usage && <span>{m.usage.promptTokens + m.usage.completionTokens} tokens</span>}
          {m.latencyMs ? <span>· {(m.latencyMs / 1000).toFixed(1)}s</span> : null}
          {m.status === 'aborted' && <span>· 已中断</span>}
          <span className="msg-actions">
            <CopyAnswerButton text={m.content} />
            <button
              className={`icon-btn${fb === 'up' ? ' on' : ''}`}
              title="有帮助"
              aria-label="有帮助"
              aria-pressed={fb === 'up'}
              onClick={(e) => onFeedback(m.id, 'up', e.currentTarget.getBoundingClientRect())}
            >
              <ThumbsUp />
            </button>
            <button
              className={`icon-btn${fb === 'down' ? ' on' : ''}`}
              title="没帮助"
              aria-label="没帮助"
              aria-pressed={fb === 'down'}
              onClick={(e) => onFeedback(m.id, 'down', e.currentTarget.getBoundingClientRect())}
            >
              <ThumbsDown />
            </button>
          </span>
        </div>
      )}
    </div>
  );
});

/** 回答渲染：轻量 Markdown 块级（标题/列表/表格/代码）+ [n] 引用上标点击定位 */
function AnswerText({ content, citations, streaming }: { content: string; citations: CitationDto[]; streaming: boolean }) {
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const refs = useMemo(
    () => ({
      maxRef: citations.length,
      ref: (n: number, key: string) => (
        <span
          key={key}
          className="ref-sup"
          role="button"
          tabIndex={0}
          title={`《${citations[n - 1].title}》 ${citations[n - 1].headingPath}`}
          onClick={() => {
            const el = document.getElementById(`cite-${n}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (el) {
              el.classList.add('cite-flash');
              setTimeout(() => el.classList.remove('cite-flash'), 1600);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              (e.target as HTMLElement).click?.();
            }
          }}
        >
          {n}
        </span>
      ),
    }),
    [citations],
  );
  return (
    // 流式输出对读屏器可见：否则整段回答在视觉上一直在变，辅助技术却毫无反馈
    <div className="msg-answer md-answer" aria-live={streaming ? 'polite' : undefined} aria-busy={streaming || undefined}>
      {blocks.map((b, bi) => {
        const key = `b-${bi}`;
        switch (b.kind) {
          case 'heading': {
            const Tag = `h${b.level}` as 'h1';
            return <Tag key={key}>{renderInline(b.text, refs, key)}</Tag>;
          }
          case 'ul':
            return (
              <ul key={key}>
                {b.items.map((it, ii) => (
                  <li key={ii}>{renderInline(it, refs, `${key}-${ii}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key}>
                {b.items.map((it, ii) => (
                  <li key={ii}>{renderInline(it, refs, `${key}-${ii}`)}</li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <table key={key}>
                <thead>
                  <tr>{b.header.map((h, hi) => <th key={hi}>{renderInline(h, undefined, `${key}-h-${hi}`)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr key={ri}>{row.map((c, ci) => <td key={ci}>{renderInline(c, refs, `${key}-${ri}-${ci}`)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            );
          case 'code':
            return <pre key={key}>{b.text}</pre>;
          case 'quote':
            return <blockquote key={key}>{renderInline(b.text, refs, key)}</blockquote>;
          default:
            return <p key={key}>{renderInline(b.text, refs, key)}</p>;
        }
      })}
      {streaming && <span className="stream-cursor" />}
    </div>
  );
}

/** 复制整段回答：点击后短暂打勾确认（剪贴板不可用时静默失败） */
function CopyAnswerButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`icon-btn${copied ? ' on' : ''}`}
      title="复制回答"
      aria-label="复制回答"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* 非安全上下文或权限被拒：不弹错，保持安静 */
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
    </button>
  );
}

function CitationList({ citations }: { citations: CitationDto[] }) {
  return (
    <div className="citations">
      {citations.map((c) => (
        <div key={c.no} className="citation-card" id={`cite-${c.no}`}>
          <span className="citation-stamp" title={`引用版本 v${c.versionNo}`}>v{c.versionNo}</span>
          <div className="citation-head">
            <span className="citation-no">{c.no}</span>
            <span className="citation-title">《{c.title}》</span>
            {c.possiblyOutdated && <span className="badge badge-warn outdated-tag">可能已过期</span>}
            {c.effectiveAt && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-3)' }}>生效 {c.effectiveAt.slice(0, 10)}</span>}
          </div>
          <div className="citation-path">{c.headingPath || '（无章节）'}</div>
          <div className="citation-quote" style={{ marginTop: 4 }}>{c.quote}</div>
        </div>
      ))}
    </div>
  );
}

function FeedbackPopover(props: {
  pos: { x: number; y: number };
  /** 由点击的按钮决定：提交的 rating 必须与之一致，不能靠"是否勾了原因"推断 */
  rating: 'up' | 'down';
  reasons: string[];
  onToggle: (r: string) => void;
  comment: string;
  onComment: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  busy?: boolean;
}) {
  const { pos, rating, reasons, onToggle, comment, onComment, onClose, onSubmit, busy } = props;
  const isDown = rating === 'down';

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 45 }} onClick={onClose} />
      <div
        className="fb-pop"
        role="dialog"
        aria-modal="true"
        aria-label={isDown ? '回答反馈（没帮助）' : '回答反馈（有帮助）'}
        style={{ left: Math.max(12, pos.x - 130), top: Math.max(12, pos.y), zIndex: 50 }}
      >
        <div className="fb-pop-title">{isDown ? '哪里没帮助？（可多选）' : '反馈这条回答'}</div>
        {isDown && (
          <div className="fb-reasons">
            {Object.entries(REASON_LABEL).map(([k, label]) => (
              <button key={k} className={`fb-reason${reasons.includes(k) ? ' on' : ''}`} onClick={() => onToggle(k)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <textarea
          className="input"
          rows={2}
          placeholder="补充说明（可选）"
          value={comment}
          onChange={(e) => onComment(e.target.value)}
          style={{ fontSize: 13 }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={onSubmit}>
            提交反馈
          </button>
        </div>
      </div>
    </>
  );
}

export type { Conversation, LiveMessage, StreamMeta };

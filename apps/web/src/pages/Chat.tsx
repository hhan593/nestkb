import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, MessageSquarePlus, Square, ThumbsDown, ThumbsUp, FileSearch, CircleAlert, X } from 'lucide-react';
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
};

export default function Chat() {
  const { me, refreshMe } = useAuth();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'rag' | 'chat'>('rag');
  const [streaming, setStreaming] = useState(false);
  const [convLoading, setConvLoading] = useState(false);
  const [fbTarget, setFbTarget] = useState<{ messageId: string; x: number; y: number } | null>(null);
  const [fbReasons, setFbReasons] = useState<string[]>([]);
  const [fbComment, setFbComment] = useState('');
  const [fbDone, setFbDone] = useState<Record<string, 'up' | 'down'>>({});
  const [fbBusy, setFbBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<LiveMessage[]>([]);
  messagesRef.current = messages;

  const loadConvs = useCallback(async () => {
    setConvs(await api<Conversation[]>('/qa/conversations'));
  }, []);

  useEffect(() => {
    void loadConvs();
  }, [loadConvs]);

  const activeConvRef = useRef<string | null>(null);

  const openConv = useCallback(async (id: string) => {
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const removeConv = useCallback(async (id: string) => {
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
    }
    void loadConvs();
  }, [activeConv, loadConvs]);

  const newConv = useCallback(async () => {
    try {
      const conv = await api<Conversation>('/qa/conversations', { body: {} });
      await loadConvs();
      abortRef.current?.abort();
      activeConvRef.current = conv.id;
      setActiveConv(conv.id);
      setMessages([]);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : '新建会话失败');
    }
  }, [loadConvs]);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || streaming) return;
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
      return;
    }
    setPageError(null);
    setInput('');
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
          patch((m) => ({ ...m, status: 'completed', latencyMs: ev.data.latencyMs }));
        } else if (ev.event === 'error') {
          patch((m) => ({ ...m, status: 'failed', error: { code: ev.data.code, message: ev.data.message } }));
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        patch((m) => ({ ...m, status: 'failed', error: { code: 'HTTP_ERROR', message: err instanceof Error ? err.message : '网络异常' } }));
      } else {
        patch((m) => ({ ...m, status: 'aborted' }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      void refreshMe(); // 配额变化
      void loadConvs(); // 会话标题更新
    }
  }, [input, streaming, activeConv, loadConvs, refreshMe, mode]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
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
      <aside className="conv-list">
        <button className="btn btn-primary" style={{ justifyContent: 'center' }} onClick={() => void newConv()}>
          <MessageSquarePlus /> 新会话
        </button>
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
                onFeedback={(x, y) => (m.id.startsWith('a-') ? undefined : setFbTarget({ messageId: m.id, x, y }))}
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
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={streaming}
            />
            {streaming ? (
              <button className="chat-send" title="停止生成" onClick={stop}>
                <Square fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button className="chat-send" title="发送" disabled={!input.trim()} onClick={() => void send()}>
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
          reasons={fbReasons}
          onToggle={(r) => setFbReasons((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))}
          comment={fbComment}
          onComment={setFbComment}
          onClose={() => setFbTarget(null)}
          onSubmit={(rating) => void submitFeedback(fbTarget.messageId, rating, fbReasons, fbComment)}
          busy={fbBusy}
        />
      )}
    </div>
  );
}

function MessageView({ m, fb, onFeedback }: { m: LiveMessage; fb?: 'up' | 'down'; onFeedback: (x: number, y: number) => void }) {
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
          <div>
            <b>{m.error!.code === 'NO_EVIDENCE' ? '没有找到依据' : '问答失败'}</b>
            <div style={{ fontWeight: 400 }}>{ERROR_HINT[m.error!.code] ?? m.error!.message}</div>
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
            <button
              className={`icon-btn${fb === 'up' ? ' on' : ''}`}
              title="有帮助"
              onClick={(e) => onFeedback(e.clientX, e.clientY - 150)}
            >
              <ThumbsUp />
            </button>
            <button
              className={`icon-btn${fb === 'down' ? ' on' : ''}`}
              title="没帮助"
              onClick={(e) => onFeedback(e.clientX, e.clientY - 150)}
            >
              <ThumbsDown />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

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
          title={`《${citations[n - 1].title}》 ${citations[n - 1].headingPath}`}
          onClick={() => document.getElementById(`cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        >
          {n}
        </span>
      ),
    }),
    [citations],
  );
  return (
    <div className="msg-answer md-answer">
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

function CitationList({ citations }: { citations: CitationDto[] }) {
  return (
    <div className="citations">
      {citations.map((c) => (
        <div key={c.no} className="citation-card" id={`cite-${c.no}`}>
          <div className="citation-head">
            <span className="citation-no">{c.no}</span>
            <span className="citation-title">《{c.title}》</span>
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>v{c.versionNo}</span>
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
  reasons: string[];
  onToggle: (r: string) => void;
  comment: string;
  onComment: (v: string) => void;
  onClose: () => void;
  onSubmit: (rating: 'up' | 'down') => void;
  busy?: boolean;
}) {
  const { pos, reasons, onToggle, comment, onComment, onClose, onSubmit, busy } = props;
  const isDown = reasons.length > 0;
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 45 }} onClick={onClose} />
      <div className="fb-pop" style={{ left: Math.max(12, pos.x - 130), top: Math.max(12, pos.y), zIndex: 50 }}>
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
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onSubmit(isDown ? 'down' : 'up')}>
            提交反馈
          </button>
        </div>
      </div>
    </>
  );
}

export type { Conversation, LiveMessage, StreamMeta };

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CitationDto,
  ErrorCodes,
  RetrievalMetaDto,
  UsageDto,
} from '@lib/contracts';
import {
  NO_EVIDENCE_ANSWER,
  PERMISSION_FILTERED_ANSWER,
  buildRagPrompt,
  compressHistory,
  validateCitations,
  isHardBlockedInput,
  sanitizeChunkContent,
} from '@lib/prompts';
import { AccessScope, HybridRetrievalService, RetrievalResult } from '@lib/vector-store';
import { LlmChatService } from '@lib/llm';
import { AppEnv, AppLogger, ENV, QuotaExceededException } from '@app/common';
import { PrismaService } from '@app/prisma';
import type { Message, Prisma } from '@prisma/client';
import { MeteringService } from '../metering/metering.service';
import { QueryLogService } from '../query-logs/query-log.service';
import { SemanticCacheService } from './semantic-cache.service';
import type { AuthedUser } from '../auth/auth.service';

/** SSE 下发接口：Controller 实现（写头 + write 事件），顺序固定 meta→delta*→citations→usage→done */
export interface QaStreamSink {
  open(meta: { messageId: string; requestId: string; retrieval: RetrievalMetaDto }): void;
  delta(text: string): void;
  citations(list: CitationDto[]): void;
  usage(u: UsageDto): void;
  done(data: { latencyMs: number; cached?: boolean }): void;
  error(data: { code: string; message: string; retryable?: boolean; retrieval?: { hitCount: number } }): void;
}

const EMPTY_USAGE: UsageDto = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, costEstimated: 0 };

export interface AskOptions {
  conversationId: string;
  user: AuthedUser;
  question: string;
  topK?: number;
  requestId: string;
  signal?: AbortSignal;
  sink: QaStreamSink;
}

/**
 * 问答编排（计划书 8.2 时序图逐环节）：
 * 缓存查询 → 配额预扣 → 检索（权限前置）→ 无依据分流 → prompt 组装 → 流式 → 引用校验 → 结算落库。
 */
@Injectable()
export class QaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: HybridRetrievalService,
    private readonly llm: LlmChatService,
    private readonly metering: MeteringService,
    private readonly queryLog: QueryLogService,
    private readonly cache: SemanticCacheService,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly logger: AppLogger,
  ) {}

  async createConversation(user: AuthedUser, title?: string) {
    return this.prisma.conversation.create({ data: { userId: user.userId, title: title ?? null } });
  }

  async listConversations(user: AuthedUser) {
    return this.prisma.conversation.findMany({
      where: { userId: user.userId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async deleteConversation(user: AuthedUser, id: string): Promise<void> {
    const conv = await this.prisma.conversation.findFirst({ where: { id, userId: user.userId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.prisma.conversation.delete({ where: { id } }); // messages 级联
  }

  async getConversation(user: AuthedUser, id: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, userId: user.userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conv) throw new NotFoundException('会话不存在');
    return {
      id: conv.id,
      title: conv.title,
      summary: conv.summary,
      messages: conv.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        citations: m.citations,
        retrievalSnapshot: m.retrievalSnapshot,
        latencyMs: m.latencyMs,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async ask(opts: AskOptions): Promise<void> {
    const { user, question, sink, requestId } = opts;
    const t0 = Date.now();

    const conv = await this.prisma.conversation.findFirst({
      where: { id: opts.conversationId, userId: user.userId },
    });
    if (!conv) throw new NotFoundException('会话不存在');

    const messageId = randomUUID();
    const zeroMeta: RetrievalMetaDto = { topK: this.env.retrieval.topKFinal, hitCount: 0, rerankDegraded: false, latencyMs: 0 };

    // 注入硬闸：直接索要系统提示的输入不进入检索
    if (isHardBlockedInput(question)) {
      this.logger.warn(`injection blocked at input: user=${user.userId}`);
      sink.open({ messageId, requestId, retrieval: zeroMeta });
      sink.error({ code: 'INJECTION_BLOCKED', message: '该问题包含不允许的指令内容' });
      return;
    }

    // 语义缓存（保守档）：命中不预扣、不调 LLM
    if (this.env.semanticCacheEnabled) {
      const hit = await this.cache.get(user.deptId, question);
      if (hit) {
        sink.open({ messageId, requestId, retrieval: { ...zeroMeta, latencyMs: Date.now() - t0 } });
        sink.delta(hit.answer);
        sink.citations(hit.citations);
        sink.usage(EMPTY_USAGE);
        sink.done({ latencyMs: Date.now() - t0, cached: true });
        await this.queryLog.write({
          userId: user.userId,
          deptId: user.deptId,
          query: question,
          scene: 'cache_lookup',
          accessFilter: { deptId: user.deptId, isAdmin: user.role === 'admin' },
          requestId,
        });
        return;
      }
    }

    // ── 预扣配额（估算护栏，只做护栏不做计费）
    const topK = opts.topK ?? this.env.retrieval.topKFinal;
    const estPromptTokens = Math.ceil((question.length + topK * 500) / 1.6);
    try {
      await this.metering.preDeduct(user.userId, user.deptId, estPromptTokens);
    } catch (err) {
      const isQuota = err instanceof QuotaExceededException;
      sink.open({ messageId, requestId, retrieval: zeroMeta });
      sink.error({
        code: isQuota ? ErrorCodes.QUOTA_EXCEEDED : ErrorCodes.RATE_LIMITED,
        message: err instanceof Error ? err.message : '预扣失败',
      });
      return;
    }

    // ── 检索（权限 WHERE 前置 → 双路 → RRF → rerank）
    const scope: AccessScope = { userId: user.userId, deptId: user.deptId, isAdmin: user.role === 'admin' };
    let result: RetrievalResult;
    try {
      result = await this.retrieval.retrieve(question, scope, { debug: true });
    } catch (err) {
      this.logger.error('retrieval failed', { err: String(err) });
      sink.open({ messageId, requestId, retrieval: zeroMeta });
      sink.error({ code: ErrorCodes.UPSTREAM_ERROR, message: '检索服务异常，请稍后重试', retryable: true });
      await this.metering.release(user.userId);
      return;
    }
    const { chunks, degraded, hitCount, latencyMs: retrievalMs, debug } = result;

    sink.open({
      messageId,
      requestId,
      retrieval: { topK, hitCount, rerankDegraded: degraded, latencyMs: retrievalMs },
    });

    await this.queryLog.write({
      userId: user.userId,
      deptId: user.deptId,
      query: question,
      scene: 'qa',
      accessFilter: { deptId: user.deptId, isAdmin: user.role === 'admin' },
      hitCount,
      vectorTop: debug?.vectorTop ?? null,
      ftsTop: debug?.ftsTop ?? null,
      fusedTop: debug?.fusedTop ?? null,
      rerankedTop: debug?.rerankedTop ?? null,
      rerankDegraded: degraded,
      latencyBreakdown: debug?.breakdown ?? null,
      totalMs: result.latencyMs,
      requestId,
    });

    // ── 召回为空：区分"真没有"与"被权限滤光"（计划书 难点 3），不调 LLM，零生成成本
    if (chunks.length === 0) {
      const existsSomewhere = await this.retrieval.contrastExists(question, scope);
      const answer = existsSomewhere ? PERMISSION_FILTERED_ANSWER : NO_EVIDENCE_ANSWER;
      await this.persistPair(conv.id, question, answer, [], messageId, result, Date.now() - t0, 'completed');
      if (existsSomewhere) {
        sink.delta(answer);
        sink.citations([]);
        sink.usage(EMPTY_USAGE);
        sink.done({ latencyMs: Date.now() - t0 });
      } else {
        sink.error({ code: ErrorCodes.NO_EVIDENCE, message: '知识库中没有找到依据', retrieval: { hitCount: 0 } });
      }
      await this.metering.release(user.userId);
      return;
    }

    // ── 资料侧消毒：LLM 上下文用净化版（间接注入的指令不进模型），citations 仍引用原文供人工核对
    const interceptedChunks: string[] = [];
    const chunksForPrompt = chunks.map((c) => {
      const { content, intercepted } = sanitizeChunkContent(c.content);
      if (intercepted) interceptedChunks.push(c.chunkId);
      return { ...c, content };
    });
    if (interceptedChunks.length) {
      this.logger.warn(`injection intercepted in retrieved chunks: ${interceptedChunks.join(',')}`);
    }

    // ── 落库 user 消息 + assistant 占位（引用/快照在结算时回填）
    await this.prisma.message.create({ data: { conversationId: conv.id, role: 'user', content: question } });
    await this.prisma.message.create({ data: { id: messageId, conversationId: conv.id, role: 'assistant', content: '' } });

    // ── 历史与多轮压缩（超 HISTORY_MAX_TURNS 轮摘要化，稳定前缀 KV-cache 友好）
    const { history, summary } = await this.loadHistory(conv.id, conv.summary, user);

    const messages = buildRagPrompt(question, chunksForPrompt, history, summary);
    const snapshot = {
      topK,
      hitCount,
      rerankDegraded: degraded,
      chunks: chunks.map((c) => ({
        chunkId: c.chunkId,
        documentId: c.documentId,
        vectorScore: c.debug?.vectorScore ?? null,
        ftsScore: c.debug?.ftsScore ?? null,
        rrfScore: c.debug?.rrfScore ?? null,
        rerankScore: c.debug?.rerankScore ?? null,
      })),
    };

    let content = '';
    try {
      const streamResult = await this.llm.chatStream(messages, {
        requestId,
        scene: 'qa',
        signal: opts.signal,
        onDelta: (t) => {
          content += t;
          sink.delta(t);
        },
      });
      // 引用校验用原始 chunks（编号/原文对应），消毒只影响 LLM 上下文
      const { answer, citations } = validateCitations(streamResult.content, chunks, (w) => this.logger.warn(w));
      const settle = await this.metering.settle({
        userId: user.userId,
        deptId: user.deptId,
        scene: 'qa',
        provider: this.llm.providerName,
        model: this.llm.model,
        usage: streamResult.usage,
        requestId,
      });
      const latencyMs = Date.now() - t0;
      await this.prisma.message.update({
        where: { id: messageId },
        data: {
          content: answer,
          citations: citations as unknown as Prisma.InputJsonValue,
          retrievalSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          usageId: settle.usageId,
          latencyMs,
          status: 'completed',
        },
      });
      sink.citations(citations);
      sink.usage({
        promptTokens: streamResult.usage.prompt_tokens,
        completionTokens: streamResult.usage.completion_tokens,
        cachedTokens: streamResult.usage.prompt_tokens_details?.cached_tokens ?? 0,
        costEstimated: settle.cost,
      });
      sink.done({ latencyMs });

      if (!conv.title) await this.prisma.conversation.update({ where: { id: conv.id }, data: { title: question.slice(0, 30) } });
      if (this.env.semanticCacheEnabled && citations.length) {
        await this.cache.put(user.deptId, question, { answer, citations });
      }
    } catch (err) {
      const aborted = opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      await this.prisma.message.update({
        where: { id: messageId },
        data: {
          content,
          status: aborted ? 'aborted' : 'failed',
          retrievalSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          latencyMs: Date.now() - t0,
        },
      });
      // 按已产生 token 部分结算（防漂移）
      await this.metering
        .settlePartial({
          userId: user.userId,
          deptId: user.deptId,
          scene: 'qa',
          provider: this.llm.providerName,
          model: this.llm.model,
          usage: { prompt_tokens: estPromptTokens, completion_tokens: 0 },
          promptTokensEstimate: estPromptTokens,
          completionChars: content.length,
          requestId,
        })
        .catch(() => this.metering.release(user.userId));
      if (aborted) return; // 客户端已断开，无法下发
      this.logger.error('qa upstream failed', { err: String(err) });
      sink.error({ code: ErrorCodes.UPSTREAM_ERROR, message: '模型调用失败', retryable: true });
    }
  }

  private async persistPair(
    conversationId: string,
    question: string,
    answer: string,
    citations: CitationDto[],
    assistantMessageId: string,
    result: RetrievalResult,
    latencyMs: number,
    status: 'completed' | 'failed',
  ): Promise<void> {
    await this.prisma.message.create({
      data: { conversationId, role: 'user', content: question },
    });
    await this.prisma.message.create({
      data: {
        id: assistantMessageId,
        conversationId,
        role: 'assistant',
        content: answer,
        citations: (citations.length ? citations : undefined) as unknown as Prisma.InputJsonValue | undefined,
        retrievalSnapshot: {
          topK: 0,
          hitCount: result.hitCount,
          rerankDegraded: result.degraded,
          chunks: [],
        },
        latencyMs,
        status,
      },
    });
  }

  /** 历史 > HISTORY_MAX_TURNS 轮 → 摘要化（scene=summary 计量）+ 保留最近 keepRecent 轮 */
  private async loadHistory(
    conversationId: string,
    existingSummary: string | null,
    user: AuthedUser,
  ): Promise<{
    history: Array<{ role: 'user' | 'assistant'; content: string }> | import('@lib/contracts').ChatMessage[];
    summary: string | null;
  }> {
    const rows: Message[] = await this.prisma.message.findMany({
      where: { conversationId, content: { not: '' } },
      orderBy: { createdAt: 'asc' },
    });
    const maxMsgs = this.env.qa.maxHistoryTurns * 2;
    let summary = existingSummary;
    if (rows.length > maxMsgs) {
      summary = await this.summarize(conversationId, existingSummary, rows, user);
      rows.splice(0, rows.length); // 摘要接管全部历史
    }
    const history = compressHistory(
      rows.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      this.env.qa.keepRecent,
    );
    return { history, summary };
  }

  private async summarize(
    conversationId: string,
    existing: string | null,
    rows: Message[],
    user: AuthedUser,
  ): Promise<string> {
    const transcript = rows.map((m) => `${m.role === 'user' ? '问' : '答'}：${m.content}`).join('\n').slice(0, 6000);
    const result = await this.llm.chat(
      [
        { role: 'system', content: '将企业知识库问答的对话历史压缩为不超过 200 字的要点摘要，保留关键数字、条款与结论。' },
        { role: 'user', content: `${existing ? `已有摘要：${existing}\n\n` : ''}对话历史：\n${transcript}` },
      ],
      { requestId: '', scene: 'summary' },
    );
    const summary = result.content.slice(0, 400);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { summary } });
    await this.metering
      .settle({
        userId: user.userId,
        deptId: user.deptId,
        scene: 'summary',
        provider: this.llm.providerName,
        model: this.llm.model,
        usage: result.usage,
      })
      .catch(() => undefined);
    return summary;
  }
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CitationDto,
  ErrorCodes,
  QaMode,
  RetrievalMetaDto,
  RetrievedChunk,
  UsageDto,
} from '@lib/contracts';
import {
  NO_EVIDENCE_ANSWER,
  NO_VISIBLE_DOCS_ANSWER,
  PERMISSION_FILTERED_ANSWER,
  buildChatPrompt,
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
import { visibilityOf } from '../documents/documents.service';
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
  /** rag（默认）：检索增强；chat：纯对话，跳过检索与引用 */
  mode?: QaMode;
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
    // 会话详情倒序取最近 500 条再反转，避免超长会话全量载入内存
    const conv = await this.prisma.conversation.findFirst({
      where: { id, userId: user.userId },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 500 } },
    });
    if (!conv) throw new NotFoundException('会话不存在');
    const messages = [...conv.messages].reverse();
    return {
      id: conv.id,
      title: conv.title,
      summary: conv.summary,
      messages: messages.map((m) => ({
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

    const mode: QaMode = opts.mode ?? 'rag';
    const messageId = randomUUID();
    const zeroMeta: RetrievalMetaDto = { topK: this.env.retrieval.topKFinal, hitCount: 0, rerankDegraded: false, latencyMs: 0, mode };

    // 注入硬闸：直接索要系统提示的输入不进入检索
    if (isHardBlockedInput(question)) {
      this.logger.warn(`injection blocked at input: user=${user.userId}`);
      sink.open({ messageId, requestId, retrieval: zeroMeta });
      sink.error({ code: 'INJECTION_BLOCKED', message: '该问题包含不允许的指令内容' });
      return;
    }

    // 语义缓存（保守档）：命中需先复检引用文档对当前用户可见 —— 缓存按 deptId 共享，
    // user 级白名单授权的答案不能泄露给同部门未授权用户；可见性不过则视为未命中走全链路
    // 纯对话模式不读缓存（无引用可复检，也不该把自由回答写进知识库缓存）
    if (mode === 'rag' && this.env.semanticCacheEnabled) {
      const hit = await this.cache.get(user.deptId, question);
      if (hit && (await this.cacheHitVisible(user, hit))) {
        sink.open({ messageId, requestId, retrieval: { ...zeroMeta, latencyMs: Date.now() - t0 } });
        sink.delta(hit.answer);
        sink.citations(hit.citations);
        sink.usage(EMPTY_USAGE);
        sink.done({ latencyMs: Date.now() - t0, cached: true });
        // 命中同样落库问答对：否则回答在会话历史里消失、无法点踩反馈
        await this.persistPair(conv.id, question, hit.answer, hit.citations, messageId, {
          chunks: [],
          degraded: false,
          hitCount: 0,
          latencyMs: Date.now() - t0,
        }, Date.now() - t0, 'completed');
        if (!conv.title) await this.prisma.conversation.update({ where: { id: conv.id }, data: { title: question.slice(0, 30) } });
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

    // ── 预扣：两种模式都要过成本闸；chat 无资料块，预估只含问题 + 历史 + 预留输出
    const topK = opts.topK ?? this.env.retrieval.topKFinal;
    const estPromptTokens =
      mode === 'chat'
        ? Math.ceil((question.length + 1500) / 1.6)
        : Math.ceil((question.length + topK * 500) / 1.6);
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

    // 预扣成功后必须保证有出口释放：任何未走到结算的路径（检索/落库/摘要化抛错）都由这里的 finally 兜底。
    // 否则 Redis 预留键要等 TTL(300s) 才过期，期间该用户所有提问都会 429「上一笔问答尚未结算」。
    const reservation = { active: true };
    try {
      await this.runAnswer(opts, { conv, mode, messageId, zeroMeta, topK, estPromptTokens, t0, reservation });
    } finally {
      if (reservation.active) await this.metering.release(user.userId).catch(() => undefined);
    }
  }

  /** 问答主体（预扣之后）：所有退出路径要么结算（自身释放），要么由 ask() 的 finally 释放 */
  private async runAnswer(
    opts: AskOptions,
    ctx: {
      conv: { id: string; title: string | null; summary: string | null };
      mode: QaMode;
      messageId: string;
      zeroMeta: RetrievalMetaDto;
      topK: number;
      estPromptTokens: number;
      t0: number;
      reservation: { active: boolean };
    },
  ): Promise<void> {
    const { user, question, sink, requestId } = opts;
    const { conv, mode, messageId, zeroMeta, topK, estPromptTokens, t0, reservation } = ctx;
    /** 提前退出时释放预扣键（幂等：已释放则跳过） */
    const releaseReservation = async (): Promise<void> => {
      if (!reservation.active) return;
      reservation.active = false;
      await this.metering.release(user.userId).catch(() => undefined);
    };

    const scope: AccessScope = { userId: user.userId, deptId: user.deptId, isAdmin: user.role === 'admin' };
    // 两种模式的差异只收在这几个变量上：chat 恒为空召回、无引用、无 rerank 降级
    let chunks: RetrievedChunk[] = [];
    let degraded = false;
    let hitCount = 0;
    let retrievalMs = 0;
    let debug: RetrievalResult['debug'];

    if (mode === 'rag') {
      // ── 检索（权限 WHERE 前置 → 双路 → RRF → rerank）；topK 透传给检索层，meta 与实际召回一致
      let result: RetrievalResult;
      try {
        result = await this.retrieval.retrieve(question, scope, { debug: true, topKFinal: topK });
      } catch (err) {
        this.logger.error('retrieval failed', { err: String(err) });
        sink.open({ messageId, requestId, retrieval: zeroMeta });
        sink.error({ code: ErrorCodes.UPSTREAM_ERROR, message: '检索服务异常，请稍后重试', retryable: true });
        await releaseReservation();
        return;
      }
      chunks = result.chunks;
      degraded = result.degraded;
      hitCount = result.hitCount;
      retrievalMs = result.latencyMs;
      debug = result.debug;

      sink.open({
        messageId,
        requestId,
        retrieval: { topK, hitCount, rerankDegraded: degraded, latencyMs: retrievalMs, mode },
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

      // ── 召回为空：三态分流（计划书 难点 3），不调 LLM，零生成成本
      //    ① 库里没有你可访问的文档 → 说明可见范围，不暗示"问题没依据"
      //    ② 有可见文档且库中存在相似内容（同模型、当前版本、达相似度下限）→ 才是"无权限"
      //    ③ 其余（如「你好」这类无关提问）→ 无依据
      if (chunks.length === 0) {
        const hasVisible = await this.retrieval.hasVisibleDocuments(scope);
        const permissionFiltered = hasVisible && (await this.retrieval.contrastExists(question, scope));
        const answer = permissionFiltered
          ? PERMISSION_FILTERED_ANSWER
          : hasVisible
            ? NO_EVIDENCE_ANSWER
            : NO_VISIBLE_DOCS_ANSWER;
        await this.persistPair(conv.id, question, answer, [], messageId, result, Date.now() - t0, 'completed');
        if (permissionFiltered || !hasVisible) {
          sink.delta(answer);
          sink.citations([]);
          sink.usage(EMPTY_USAGE);
          sink.done({ latencyMs: Date.now() - t0 });
        } else {
          sink.error({ code: ErrorCodes.NO_EVIDENCE, message: '知识库中没有找到依据', retrieval: { hitCount: 0 } });
        }
        await releaseReservation();
        return;
      }
    } else {
      // ── 纯对话：跳过检索 / 权限范围 / rerank，直接进入生成（回答不挂靠知识库，无引用）
      sink.open({ messageId, requestId, retrieval: { ...zeroMeta, mode } });
      await this.queryLog.write({
        userId: user.userId,
        deptId: user.deptId,
        query: question,
        scene: 'qa',
        accessFilter: { deptId: user.deptId, isAdmin: user.role === 'admin', mode },
        hitCount: 0,
        requestId,
      });
    }

    // ── 资料侧消毒：LLM 上下文用净化版（间接注入的指令不进模型），citations 仍引用原文供人工核对
    // chat 模式没有资料块，此段自然空转
    const interceptedChunks: string[] = [];
    const chunksForPrompt =
      mode === 'rag'
        ? chunks.map((c) => {
            const { content, intercepted } = sanitizeChunkContent(c.content);
            if (intercepted) interceptedChunks.push(c.chunkId);
            return { ...c, content };
          })
        : [];
    if (interceptedChunks.length) {
      this.logger.warn(`injection intercepted in retrieved chunks: ${interceptedChunks.join(',')}`);
    }

    // ── 落库 user 消息 + assistant 占位（引用/快照在结算时回填）
    await this.prisma.message.create({ data: { conversationId: conv.id, role: 'user', content: question } });
    await this.prisma.message.create({ data: { id: messageId, conversationId: conv.id, role: 'assistant', content: '' } });

    // ── 历史与多轮压缩（超 HISTORY_MAX_TURNS 轮摘要化，稳定前缀 KV-cache 友好）
    const { history, summary } = await this.loadHistory(conv.id, conv.summary, user);

    const messages =
      mode === 'chat'
        ? buildChatPrompt(question, history, summary)
        : buildRagPrompt(question, chunksForPrompt, history, summary);
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
      // 引用校验用原始 chunks（编号/原文对应），消毒只影响 LLM 上下文；chat 模式不产出引用
      const { answer, citations } =
        mode === 'rag'
          ? validateCitations(streamResult.content, chunks, (w) => this.logger.warn(w))
          : { answer: streamResult.content, citations: [] as CitationDto[] };
      reservation.active = false; // settle 内部（含落库失败）必定释放预扣键，避免 finally 误删下一次请求的预留键
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
      // 按已产生 token 部分结算（防漂移）；settlePartial 内部同样保证释放预扣键
      reservation.active = false;
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

  /** 缓存命中复检：全部被引文档对当前用户可见才允许返回（缓存按 deptId 共享，防白名单内容越权） */
  private async cacheHitVisible(user: AuthedUser, hit: { citations: CitationDto[] }): Promise<boolean> {
    const docIds = [...new Set(hit.citations.map((c) => c.documentId))];
    if (!docIds.length) return true;
    const visible = await this.prisma.document.count({ where: { id: { in: docIds }, ...visibilityOf(user) } });
    return visible >= docIds.length;
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
    const maxMsgs = this.env.qa.maxHistoryTurns * 2;
    // 只取最近 3×maxMsgs 条参与压缩判断；更早历史本就该被摘要接管，避免全量拉取
    const rows: Message[] = await this.prisma.message.findMany({
      where: { conversationId, content: { not: '' } },
      orderBy: { createdAt: 'desc' },
      take: maxMsgs * 3,
    });
    rows.reverse();
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

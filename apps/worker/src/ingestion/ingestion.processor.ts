import { Inject, Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import path from 'node:path';
import { INGEST_QUEUE, IngestJobData } from '@lib/contracts';
import { chunkDocument } from '@lib/chunker';
import { EmbeddingService, LlmUpstreamError, PRICE_TABLE, PriceTable } from '@lib/llm';
import { VectorStoreService } from '@lib/vector-store';
import { AppEnv, ENV, AppLogger } from '@app/common';
import { PrismaService } from '@app/prisma';
import { parseByMime, ParseError } from './parsers';

type IngestStage = 'queued' | 'parsing' | 'chunking' | 'embedding' | 'storing' | 'ready' | 'failed';

interface StageExtra {
  chunkCount?: number;
  costEstimated?: number;
  error?: string;
}

/**
 * 摄取管道（计划书 8.4）：
 * parsing → chunking → embedding（批量+限速退避）→ storing（先删后写单事务）→ ready。
 * 幂等键 = versionId（jobId 去重之外的第二道保险）；阶段迁移同步落库 —— 队列负责执行、表负责可观测与断点重放。
 */
@Processor(INGEST_QUEUE, {
  concurrency: 2,
  limiter: { max: 30, duration: 1000 }, // 队列级限速护 embedding 配额
})
@Injectable()
export class IngestionProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly store: VectorStoreService,
    @Inject(PRICE_TABLE) private readonly prices: PriceTable,
    @Inject(ENV) private readonly env: AppEnv,
    private readonly logger: AppLogger,
  ) {
    super();
  }

  async process(job: Job<IngestJobData>): Promise<void> {
    const d = job.data;
    const stageTimings: Record<string, number> = {};
    let last = { stage: 'queued', at: Date.now() };
    const startedAt = new Date();

    const setStage = async (stage: IngestStage, extra: StageExtra = {}): Promise<void> => {
      const now = Date.now();
      stageTimings[last.stage] = (stageTimings[last.stage] ?? 0) + (now - last.at);
      last = { stage, at: now };
      await this.prisma.ingestionJob.upsert({
        where: { versionId: d.versionId },
        create: { versionId: d.versionId, documentId: d.documentId, stage, startedAt },
        update: { stage, startedAt, stageTimings, attempts: job.attemptsMade + 1, error: null, ...extra },
      });
    };

    // 幂等闸：同版本且同 embedding 模型已入库直接跳过（重复投递/重试零副作用；换模型后旧向量不可复用）
    if (await this.store.hasVersion(d.versionId, this.embedding.modelName)) {
      await this.prisma.ingestionJob.updateMany({
        where: { versionId: d.versionId, stage: { not: 'ready' } },
        data: { stage: 'ready', error: null },
      });
      this.logger.log(`ingest skip (already ready): version=${d.versionId}`);
      return;
    }

    try {
      await setStage('parsing'); // ── 1 parsing：按 mime 分发，失败必须分类
      const parsed = await parseByMime(this.resolveStoragePath(d.storageKey), d.mimeType);
      if (!parsed.text.trim()) throw new ParseError('EMPTY_DOCUMENT');
      await job.updateProgress(15);

      await setStage('chunking'); // ── 2 chunking：清洗（控制字符/换行归一）+ 结构感知分块
      const text = parsed.text.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
      const chunks = chunkDocument(text, { maxChars: 500, overlapChars: 60 });
      if (!chunks.length) throw new ParseError('EMPTY_DOCUMENT');
      await job.updateProgress(30);

      await setStage('embedding'); // ── 3 embedding：批量 + RPM 限速 + 指数退避；标题随内容一起嵌入提升召回
      const vectors: number[][] = [];
      const batchSize = this.env.embedding.batchSize;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const slice = chunks.slice(i, i + batchSize);
        vectors.push(...(await this.embedding.embedWithRetry(slice.map((c) => (c.headingPath ? `${c.headingPath}\n${c.content}` : c.content)))));
        await job.updateProgress(30 + Math.round((Math.min(i + batchSize, chunks.length) / chunks.length) * 50));
      }

      await setStage('storing'); // ── 4 storing：先删后写单事务（advisory lock 防同文档并发互删）
      const totalTokens = chunks.reduce((s, c) => s + c.tokenEstimate, 0);
      const written = await this.store.replaceVersion({
        versionId: d.versionId,
        documentId: d.documentId,
        deptId: d.deptId,
        aclDeptIds: d.aclDeptIds,
        chunks,
        vectors,
        embeddingModel: this.embedding.modelName,
      });
      const cost = this.embedding.estimateCost(totalTokens);

      // 摄取 embedding 花费先落 usage_records（scene=ingest_embed），再标 ready：
      // ready 后重试会走幂等闸早退，先记账可保证崩溃窗口内 usage 不丢
      await this.prisma.usageRecord.create({
        data: {
          userId: d.uploadedBy,
          deptId: d.deptId,
          scene: 'ingest_embed',
          provider: `${this.embedding.providerName}/${this.embedding.modelName}`,
          promptTokens: totalTokens,
          completionTokens: 0,
          costEstimated: cost,
          requestId: d.requestId,
        },
      });
      await setStage('ready', { chunkCount: written, costEstimated: cost });
      await job.updateProgress(100);

      this.logger.log(`ingest ready: version=${d.versionId} chunks=${written} cost=${cost}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 不可恢复的只有两类：解析失败（内容问题，重试无意义）与上游明确不可重试的错误。
      // 其余（DB 抖动、网络、超时、5xx…）一律交给 BullMQ attempts/退避 —— 不能靠错误消息正则猜，
      // 否则 Prisma P1001/ECONNREFUSED 这类基础设施故障会被误判成永久失败直接烧进 DLQ
      const unrecoverable = err instanceof ParseError || (err instanceof LlmUpstreamError && !err.retryable);
      const stageNow = last.stage;
      await this.prisma.ingestionJob.updateMany({
        where: { versionId: d.versionId },
        data: {
          stage: 'failed',
          error: `${err instanceof ParseError ? `PARSE_FAILED:${err.code}` : err instanceof Error ? err.name : 'Error'}: ${message}`.slice(
            0,
            500,
          ),
          attempts: job.attemptsMade + 1,
          stageTimings: { ...stageTimings, [stageNow]: (stageTimings[stageNow] ?? 0) + (Date.now() - last.at) },
        },
      });
      this.logger.error(`ingest failed: version=${d.versionId} stage=${stageNow}`, { message });
      if (unrecoverable) throw new UnrecoverableError(message);
      throw err;
    }
  }

  private resolveStoragePath(storageKey: string): string {
    if (path.isAbsolute(storageKey)) return storageKey;
    return path.join(process.cwd(), this.env.storageDir, storageKey);
  }
}

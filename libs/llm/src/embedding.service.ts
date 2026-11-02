import { Inject, Injectable } from '@nestjs/common';
import { AppEnv, ENV } from '@app/common';
import { PriceTable } from './price-table';
import { EMBEDDING_PROVIDER, PRICE_TABLE } from './tokens';
import { LlmUpstreamError } from './providers/openai-compat';
import type { LlmEmbeddingProvider } from './provider-types';

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 800;

/** 批量 + 限速 + 指数退避（429/5xx/网络抖动），换模型不改调用方 */
@Injectable()
export class EmbeddingService {
  private lastRequestAt = 0;

  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly provider: LlmEmbeddingProvider,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(PRICE_TABLE) private readonly prices: PriceTable,
  ) {}

  get modelName(): string {
    return this.provider.model;
  }

  get dim(): number {
    return this.provider.dim;
  }

  get providerName(): string {
    return this.env.embedding.provider;
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vec] = await this.embedWithRetry([query]);
    return vec;
  }

  /** 批量嵌入（按 EMBEDDING_BATCH_SIZE 分批，RPM 限速，429/5xx 指数退避） */
  async embedWithRetry(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const batch = Math.max(1, this.env.embedding.batchSize);
    for (let i = 0; i < texts.length; i += batch) {
      out.push(...(await this.withRetry(texts.slice(i, i + batch))));
    }
    return out;
  }

  private async withRetry(texts: string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      try {
        // 整体超时：上游挂起（TCP 半开/代理 stall）时不能让 job 永不结束
        return await this.provider.embed(texts, AbortSignal.timeout(this.env.embedding.timeoutMs));
      } catch (err) {
        const retryable = err instanceof LlmUpstreamError ? err.retryable : isTransient(err);
        if (!retryable || attempt >= MAX_RETRIES - 1) throw err;
        await sleep(BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 300);
      }
    }
  }

  /** RPM 限速：与 provider 配额对齐，避免 429 风暴（计划书 6.6 embedding 段堆积=限速过低） */
  private async throttle(): Promise<void> {
    const minInterval = 60_000 / Math.max(1, this.env.embedding.rpm);
    const wait = this.lastRequestAt + minInterval - Date.now();
    this.lastRequestAt = Date.now();
    if (wait > 0) await sleep(wait);
  }

  estimateCost(totalTokens: number): number {
    return this.prices.compute(this.provider.model, { prompt_tokens: totalTokens, completion_tokens: 0 });
  }
}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|429|rate.?limit|5\d{2}|timeout|aborted/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

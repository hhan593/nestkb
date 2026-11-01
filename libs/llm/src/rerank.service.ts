import { Inject, Injectable } from '@nestjs/common';
import { AppEnv, ENV } from '@app/common';
import { PriceTable } from './price-table';
import { RERANK_PROVIDER, PRICE_TABLE } from './tokens';
import type { RerankProvider } from './provider-types';

/**
 * rerank 门面 —— 超时与降级是本服务的契约（计划书 8.6）：
 * 超过 RERANK_TIMEOUT_MS 或任何报错直接抛出，由 HybridRetrievalService 捕获降级为 RRF 粗排。
 */
@Injectable()
export class RerankService {
  constructor(
    @Inject(RERANK_PROVIDER) private readonly provider: RerankProvider,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(PRICE_TABLE) private readonly prices: PriceTable,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  async rerank(query: string, documents: string[], topN: number): Promise<Array<{ index: number; score: number }>> {
    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), this.env.rerank.timeoutMs);
    try {
      return await this.provider.rerank(query, documents, topN, controller.signal);
    } finally {
      clearTimeout(killer);
    }
  }

  estimateCost(calls: number): number {
    return Number((this.prices.perCall(this.model) * calls).toFixed(6));
  }
}

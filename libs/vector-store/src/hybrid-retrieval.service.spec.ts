import { describe, expect, it, vi } from 'vitest';
import type { AccessScope } from './access-filter';
import { HybridRetrievalService } from './hybrid-retrieval.service';
import type { ChunkRow } from './vector-store.service';

const scope: AccessScope = { userId: 'u-1', deptId: 'd-1', isAdmin: false };

function row(id: string, score: number): ChunkRow {
  return {
    id,
    document_id: 'doc-1',
    version_id: 'ver-1',
    chunk_no: 1,
    content: `内容-${id}`,
    heading_path: '第一章',
    title: '员工手册',
    version_no: 1,
    effective_at: new Date('2026-01-01T00:00:00Z'),
    expires_at: null,
    score,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function make(overrides: { ftsDelayMs?: number; rerank?: 'ok' | 'throw' } = {}) {
  const store = {
    countVisibleDocuments: vi.fn(async () => 7),
    searchVectors: vi.fn(async () => [row('c-1', 0.92), row('c-2', 0.81), row('c-3', 0.7)]),
    searchFts: vi.fn(async () => {
      if (overrides.ftsDelayMs) await sleep(overrides.ftsDelayMs);
      return [row('c-1', 0.5), row('c-4', 0.4), row('c-5', 0.3)];
    }),
  };
  const embedding = { embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]) };
  const reranker = {
    rerank: vi.fn(async (_q: string, _docs: string[], k: number) => {
      if (overrides.rerank === 'throw') throw new Error('rerank timeout');
      return Array.from({ length: Math.min(k, 3) }, (_, i) => ({ index: i, score: 0.9 - i * 0.1 }));
    }),
  };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
  const env = { retrieval: { topKCoarse: 50, topKFinal: 8, rrfK: 60, contrastMinSimilarity: 0.35 } };
  const service = new HybridRetrievalService(store as never, embedding as never, reranker as never, logger as never, env as never);
  return { service, store, reranker, logger };
}

describe('HybridRetrievalService.retrieve（#32）', () => {
  it('常规召回不产出 debug 明细，也不查可见版本集合', async () => {
    const { service, store } = make();
    const result = await service.retrieve('q', scope);

    expect(result.debug).toBeUndefined();
    expect(store.countVisibleDocuments).not.toHaveBeenCalled();
    expect(result.breakdown.embedMs).toBeGreaterThanOrEqual(0);
  });

  it('debug 视图用 count(*) 取版本规模，并给出 top10 明细', async () => {
    const { service, store } = make();
    const result = await service.retrieve('q', scope, { debug: true });

    expect(store.countVisibleDocuments).toHaveBeenCalledWith(scope);
    expect(result.debug?.versionIdCount).toBe(7);
    expect(result.debug?.vectorTop).toHaveLength(3);
    expect(result.debug?.ftsTop).toHaveLength(3);
    expect(result.debug?.breakdown).toEqual(result.breakdown);
  });

  it('ftsMs 反映关键词路的真实完成时间，而不是抄向量路的墙钟', async () => {
    const { service } = make({ ftsDelayMs: 25 });
    const result = await service.retrieve('q', scope);

    expect(result.breakdown.ftsMs).toBeGreaterThanOrEqual(20);
    expect(result.breakdown.ftsMs).toBeGreaterThan(result.breakdown.vectorMs);
  });

  it('rerank 失败仍降级返回 RRF 结果', async () => {
    const { service, logger } = make({ rerank: 'throw' });
    const result = await service.retrieve('q', scope, { topKFinal: 2 });

    expect(result.degraded).toBe(true);
    expect(result.chunks).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});

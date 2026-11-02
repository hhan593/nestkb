import { Inject, Injectable } from '@nestjs/common';
import { RetrievedChunk } from '@lib/contracts';
import { AppEnv, AppLogger, ENV } from '@app/common';
import { EmbeddingService } from '@lib/llm';
import { RerankService } from '@lib/llm';
import { AccessScope } from './access-filter';
import { ChunkRow, VectorStoreService } from './vector-store.service';

export interface RetrievalDebugInfo {
  versionIdCount: number;
  vectorTop: Array<{ chunkId: string; score: number }>;
  ftsTop: Array<{ chunkId: string; score: number }>;
  fusedTop: Array<{ chunkId: string; score: number }>;
  rerankedTop: Array<{ chunkId: string; score: number }>;
  /** latency_breakdown：{embedMs, vectorMs, ftsMs, rerankMs} —— P95 超标先看哪段贡献最大 */
  breakdown: { embedMs: number; vectorMs: number; ftsMs: number; fuseMs: number; rerankMs: number };
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  degraded: boolean;
  hitCount: number;
  latencyMs: number;
  debug?: RetrievalDebugInfo;
}

function toChunk(row: ChunkRow): RetrievedChunk {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    versionId: row.version_id,
    versionNo: row.version_no,
    title: row.title,
    headingPath: row.heading_path,
    content: row.content,
    effectiveAt: row.effective_at ? row.effective_at.toISOString() : null,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    score: Number(row.score) || 0,
    debug: {},
  };
}

/** RRF：只比排名不比分值（两路量纲不可比），score(d) = Σ 1/(k+rank) */
export function rrfFuse(vectorRows: ChunkRow[], ftsRows: ChunkRow[], k = 60): RetrievedChunk[] {
  const fused = new Map<string, RetrievedChunk>();
  const add = (rows: ChunkRow[], key: 'vectorRank' | 'ftsRank'): void => {
    rows.forEach((r, rank) => {
      const existing = fused.get(r.id);
      const cur = existing ?? toChunk(r);
      if (!existing) cur.score = 0; // RRF 起点归零：原始分值不参与融合（只比排名）
      cur.score += 1 / (k + rank + 1);
      cur.debug = { vectorScore: undefined, ftsScore: undefined, ...cur.debug };
      cur.debug[key] = rank + 1;
      if (key === 'vectorRank') cur.debug.vectorScore = Number(Number(r.score).toFixed(6));
      else cur.debug.ftsScore = Number(Number(r.score).toFixed(6));
      cur.debug.rrfScore = Number(cur.score.toFixed(8));
      fused.set(r.id, cur);
    });
  };
  add(vectorRows, 'vectorRank');
  add(ftsRows, 'ftsRank');
  return [...fused.values()].sort((x, y) => y.score - x.score);
}

/**
 * 混合检索 + RRF + rerank（计划书 8.6）：
 * 双路召回都在权限过滤之内执行；rerank 是增强不是依赖 —— 超时/报错降级为 RRF 顺序。
 */
@Injectable()
export class HybridRetrievalService {
  constructor(
    private readonly store: VectorStoreService,
    private readonly embedding: EmbeddingService,
    private readonly reranker: RerankService,
    private readonly logger: AppLogger,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async retrieve(query: string, scope: AccessScope, opts: { debug?: boolean; topKFinal?: number } = {}): Promise<RetrievalResult> {
    const coarseK = this.env.retrieval.topKCoarse; // 粗排池取大：rerank 的前提是"先别漏"
    const topKFinal = opts.topKFinal ?? this.env.retrieval.topKFinal;
    const t0 = performance.now();
    const [queryVec, versionIds] = await Promise.all([
      this.embedding.embedQuery(query),
      this.store.currentVersionIds(scope),
    ]);
    const embedMs = performance.now() - t0;

    const t1 = performance.now();
    const [vectorHits, ftsHits] = await Promise.all([
      this.store.searchVectors(queryVec, coarseK, scope, versionIds),
      this.store.searchFts(query, coarseK, scope, versionIds),
    ]);
    const vectorMs = performance.now() - t1;
    const ftsMs = vectorMs; // 双路并行，共享同一段墙钟

    const t2 = performance.now();
    const coarse = rrfFuse(vectorHits, ftsHits, this.env.retrieval.rrfK).slice(0, coarseK);
    const fuseMs = performance.now() - t2;

    const finalK = Math.min(topKFinal, coarse.length);
    let chunks: RetrievedChunk[];
    let degraded = false;
    const t3 = performance.now();
    if (coarse.length > finalK) {
      try {
        const ranked = await this.reranker.rerank(query, coarse.map((c) => c.content), finalK);
        chunks = ranked.map((r) => ({
          ...coarse[r.index],
          score: r.score,
          debug: { ...coarse[r.index].debug, rrfScore: coarse[r.index].score, rerankScore: Number(r.score.toFixed(6)) },
        }));
      } catch (err) {
        // rerank 降级：x-rerank-degraded 标记 + query_logs（计划书 难点 2）；记录原因，避免线上静默劣化无从排查
        this.logger.warn(`rerank degraded: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        chunks = coarse.slice(0, finalK);
        degraded = true;
      }
    } else {
      chunks = coarse.slice(0, finalK);
    }
    const rerankMs = performance.now() - t3;

    const result: RetrievalResult = {
      chunks,
      degraded,
      hitCount: coarse.length,
      latencyMs: Math.round(performance.now() - t0),
    };
    if (opts.debug) {
      result.debug = {
        versionIdCount: versionIds.length,
        vectorTop: vectorHits.slice(0, 10).map((r) => ({ chunkId: r.id, score: Number(Number(r.score).toFixed(6)) })),
        ftsTop: ftsHits.slice(0, 10).map((r) => ({ chunkId: r.id, score: Number(Number(r.score).toFixed(6)) })),
        fusedTop: coarse.slice(0, 10).map((c) => ({ chunkId: c.chunkId, score: Number(c.score.toFixed(6)) })),
        rerankedTop: chunks.map((c) => ({ chunkId: c.chunkId, score: Number(c.score.toFixed(6)) })),
        breakdown: {
          embedMs: Math.round(embedMs),
          vectorMs: Math.round(vectorMs),
          ftsMs: Math.round(ftsMs),
          fuseMs: Math.round(fuseMs),
          rerankMs: Math.round(rerankMs),
        },
      };
    }
    return result;
  }

  /** 权限滤光判定：admin 对照查询有结果而用户视角为空 → 提示"无权限"而非"没有依据" */
  async contrastExists(query: string, scope: AccessScope): Promise<boolean> {
    const queryVec = await this.embedding.embedQuery(query);
    return this.store.contrastExists(queryVec, scope);
  }
}

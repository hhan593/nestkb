import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { AppEnv, ENV } from '@app/common';
import { accessWhereSql, AccessScope } from './access-filter';

/** pg 原始行（document_chunks JOIN documents JOIN document_versions） */
export interface ChunkRow {
  id: string;
  document_id: string;
  version_id: string;
  chunk_no: number;
  content: string;
  heading_path: string;
  title: string;
  version_no: number;
  effective_at: Date | null;
  expires_at: Date | null;
  score: number;
}

export interface ReplaceVersionPayload {
  versionId: string;
  documentId: string;
  deptId: string;
  aclDeptIds: string[]; // 方案 B（Qdrant payload）使用；pgvector 实现仅存档于 metadata
  chunks: Array<{ content: string; chunkNo: number; headingPath: string; isTable: boolean; tokenEstimate: number }>;
  vectors: number[][];
  embeddingModel: string;
}

/**
 * VectorStore —— 向量/关键词/权限数据同库（方案 A：pgvector）。
 * 向量操作（含 <=> 算子）收口在本服务一处，Prisma 不触碰 embedding/tsv 列。
 * 接口与 Qdrant 实现可互换（计划书 4.3：VectorStore 接口化）。
 */
@Injectable()
export class VectorStoreService implements OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly embeddingModel: string;

  constructor(@Inject(ENV) env: AppEnv) {
    this.pool = new Pool({ connectionString: env.pgvectorUrl, max: 10 });
    this.embeddingModel = env.embedding.model;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }

  /** 幂等闸：同版本且同 embedding 模型已入库才跳过；换模型后旧向量不可复用，需重摄取 */
  async hasVersion(versionId: string, embeddingModel = this.embeddingModel): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'SELECT 1 FROM document_chunks WHERE version_id = $1 AND embedding_model = $2 LIMIT 1',
      [versionId, embeddingModel],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 先删后写单事务（防新旧版本混检）：按 document 清空旧块再写入新版本全部块。
   * 事务内取同文档 advisory lock —— 并发摄取同文档的两个 job 串行化，杜绝互删 chunks。
   * tsv 由 to_tsvector('simple') 落库（含章节标题），trgm 走 content 列上的 GIN 索引。
   */
  async replaceVersion(payload: ReplaceVersionPayload): Promise<number> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [payload.documentId]);
      await client.query('DELETE FROM document_chunks WHERE document_id = $1', [payload.documentId]);
      let written = 0;
      const batchSize = 50;
      for (let start = 0; start < payload.chunks.length; start += batchSize) {
        const chunkSlice = payload.chunks.slice(start, start + batchSize);
        const vecSlice = payload.vectors.slice(start, start + batchSize);
        const values: unknown[] = [];
        // 每行 9 个独立参数（documentId 为批次共享的 $1）：
        // versionId, deptId, chunkNo, content, headingPath, embedding, embeddingModel, tokenCount, metadata
        // 列 11 个：document_id, version_id, dept_id, chunk_no, content, heading_path,
        //          embedding, embedding_model, token_count, tsv(表达式), metadata
        const rows = chunkSlice.map((c, i) => {
          const b = i * 9; // 行内 $ 占位基址（$1 = documentId 共享）
          values.push(
            payload.versionId,
            payload.deptId,
            c.chunkNo,
            c.content,
            c.headingPath,
            `[${vecSlice[i].join(',')}]`,
            payload.embeddingModel,
            c.tokenEstimate,
            JSON.stringify({ isTable: c.isTable, aclDeptIds: payload.aclDeptIds }),
          );
          return `($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::vector, $${b + 8}, $${b + 9}, to_tsvector('simple', $${b + 6} || ' ' || $${b + 5}), $${b + 10}::jsonb)`;
        });
        const result = await client.query(
          `INSERT INTO document_chunks
             (document_id, version_id, dept_id, chunk_no, content, heading_path, embedding, embedding_model, token_count, tsv, metadata)
           VALUES ${rows.join(', ')}
           ON CONFLICT (version_id, chunk_no) DO NOTHING`,
          [payload.documentId, ...values],
        );
        written += result.rowCount ?? chunkSlice.length;
      }
      await client.query('COMMIT');
      return written;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 可见文档的当前版本集合：权限解析先行，避免全表 JOIN（计划书 8.6） */
  async currentVersionIds(scope: AccessScope): Promise<string[]> {
    const w = accessWhereSql(scope, 1, 'd.department_id');
    const params = [...w.params];
    const nowIdx = params.length + 1;
    params.push(new Date().toISOString());
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT v.id
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
        WHERE d.status = 'active'
          AND d.current_version_id = v.id
          AND (v.expires_at IS NULL OR v.expires_at > $${nowIdx})
          AND ${w.sql}`,
      params,
    );
    return rows.map((r) => r.id);
  }

  /** 向量召回：权限 WHERE 前置，只检索当前版本，过期文档不可召回；版本范围在 SQL 内解析（免传全库 id 数组） */
  async searchVectors(vector: number[], topK: number, scope: AccessScope): Promise<ChunkRow[]> {
    const wv = accessWhereSql(scope, 1, 'd.department_id');
    const wc = accessWhereSql(scope, wv.params.length + 1, 'c.dept_id');
    const params: unknown[] = [...wv.params, ...wc.params, this.embeddingModel, `[${vector.join(',')}]`, topK];
    const modelIdx = wv.params.length + wc.params.length + 1;
    const vecIdx = modelIdx + 1;
    const limitIdx = modelIdx + 2;
    const { rows } = await this.pool.query<ChunkRow>(
      `SELECT c.id, c.document_id, c.version_id, c.chunk_no, c.content, c.heading_path,
              d.title, v.version_no, v.effective_at, v.expires_at,
              1 - (c.embedding <=> $${vecIdx}) AS score
         FROM document_chunks c
         JOIN documents d         ON d.id = c.document_id
         JOIN document_versions v ON v.id = c.version_id
        WHERE c.version_id IN (
                SELECT v.id
                  FROM document_versions v
                  JOIN documents d ON d.id = v.document_id
                 WHERE d.status = 'active'
                   AND d.current_version_id = v.id
                   AND (v.expires_at IS NULL OR v.expires_at > now())
                   AND ${wv.sql})
          AND (v.expires_at IS NULL OR v.expires_at > now())
          AND c.embedding_model = $${modelIdx}
          AND ${wc.sql}
        ORDER BY c.embedding <=> $${vecIdx}
        LIMIT $${limitIdx}`,
      params,
    );
    return rows;
  }

  /**
   * 关键词召回：PostgreSQL FTS（simple 配置）+ pg_trgm 兜底（中文分词断层时的模糊匹配）。
   * 与向量同库免同步；权限 WHERE 与向量路完全一致。
   */
  async searchFts(query: string, topK: number, scope: AccessScope): Promise<ChunkRow[]> {
    const wv = accessWhereSql(scope, 1, 'd.department_id');
    const wc = accessWhereSql(scope, wv.params.length + 1, 'c.dept_id');
    const params: unknown[] = [...wv.params, ...wc.params, query, topK];
    const queryIdx = wv.params.length + wc.params.length + 1;
    const limitIdx = queryIdx + 1;
    const { rows } = await this.pool.query<ChunkRow>(
      `SELECT c.id, c.document_id, c.version_id, c.chunk_no, c.content, c.heading_path,
              d.title, v.version_no, v.effective_at, v.expires_at,
              GREATEST(
                ts_rank(c.tsv, websearch_to_tsquery('simple', $${queryIdx})),
                similarity(c.content, $${queryIdx})
              ) AS score
         FROM document_chunks c
         JOIN documents d         ON d.id = c.document_id
         JOIN document_versions v ON v.id = c.version_id
        WHERE c.version_id IN (
                SELECT v.id
                  FROM document_versions v
                  JOIN documents d ON d.id = v.document_id
                 WHERE d.status = 'active'
                   AND d.current_version_id = v.id
                   AND (v.expires_at IS NULL OR v.expires_at > now())
                   AND ${wv.sql})
          AND (v.expires_at IS NULL OR v.expires_at > now())
          AND ${wc.sql}
          AND (c.tsv @@ websearch_to_tsquery('simple', $${queryIdx}) OR c.content % $${queryIdx})
        ORDER BY score DESC
        LIMIT $${limitIdx}`,
      params,
    );
    return rows;
  }

  /** 对照查询（admin 视角）：hitCount=0 时区分"真没有"与"被权限滤光"（计划书 难点 3）；归档文档不算库内内容 */
  async contrastExists(vector: number[], scope: AccessScope): Promise<boolean> {
    const adminScope: AccessScope = { userId: scope.userId, deptId: scope.deptId, isAdmin: true };
    const w = accessWhereSql(adminScope, 3, 'c.dept_id');
    const params: unknown[] = [`[${vector.join(',')}]`, ...w.params];
    const limitIdx = params.length + 1;
    params.push(3);
    const { rowCount } = await this.pool.query(
      `SELECT c.id
         FROM document_chunks c
         JOIN documents d         ON d.id = c.document_id
         JOIN document_versions v ON v.id = c.version_id
        WHERE d.status = 'active'
          AND (v.expires_at IS NULL OR v.expires_at > now())
          AND ${w.sql}
        ORDER BY c.embedding <=> $1
        LIMIT $${limitIdx}`,
      params,
    );
    return (rowCount ?? 0) > 0;
  }

  /** 评测/调试：按内容锚点短语解析 gold chunk（ILIKE 走 trgm GIN） */
  async findChunkIdsByMarker(marker: string, versionId?: string): Promise<string[]> {
    const params: unknown[] = [`%${marker}%`];
    let sql = `SELECT c.id FROM document_chunks c WHERE c.content ILIKE $1`;
    if (versionId) {
      sql += ` AND c.version_id = $2`;
      params.push(versionId);
    }
    sql += ' LIMIT 5';
    const { rows } = await this.pool.query<{ id: string }>(sql, params);
    return rows.map((r) => r.id);
  }
}

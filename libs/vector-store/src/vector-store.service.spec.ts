import { describe, expect, it, vi } from 'vitest';
import type { AccessScope } from './access-filter';
import { VectorStoreService } from './vector-store.service';

const scope: AccessScope = { userId: 'u-1', deptId: 'd-1', isAdmin: false };

function make() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
  const env = {
    pgvectorUrl: 'postgresql://unused/none',
    embedding: { model: 'bge-m3' },
    retrieval: { contrastMinSimilarity: 0.35 },
  };
  const service = new VectorStoreService(env as never);
  // 不连真实 PG：只校验 SQL 结构（真实等价性由 e2e + chunk-scope.spec 覆盖）
  (service as unknown as { pool: { query: typeof query; end: () => Promise<void> } }).pool = {
    query,
    end: async () => undefined,
  };
  return { service, query };
}

const sqlOf = (query: ReturnType<typeof make>['query'], call: number): string => String(query.mock.calls[call]?.[0] ?? '');
const paramsOf = (query: ReturnType<typeof make>['query'], call: number): unknown[] =>
  (query.mock.calls[call]?.[1] ?? []) as unknown[];

describe('VectorStore 三条查询的范围一致性（#34）', () => {
  it('主召回与对照查询共用同一「当前版本 + 未过期 + 权限」片段', async () => {
    const { service, query } = make();
    await service.searchVectors([0.1, 0.2], 10, scope);
    await service.searchFts('关键词', 10, scope);
    await service.contrastExists([0.1, 0.2], scope);

    for (const i of [0, 1, 2]) {
      expect(sqlOf(query, i)).toContain('d.current_version_id = v.id');
      expect(sqlOf(query, i)).toContain("d.status = 'active'");
      expect(sqlOf(query, i)).toContain('v.expires_at IS NULL OR v.expires_at > now()');
    }
  });

  it('对照查询与向量召回都限定同一 embedding_model（换模型后不误判"存在"）', async () => {
    const { service, query } = make();
    await service.searchVectors([0.1], 10, scope);
    await service.contrastExists([0.1], scope);

    expect(sqlOf(query, 0)).toMatch(/c\.embedding_model = \$\d+/);
    expect(sqlOf(query, 1)).toMatch(/c\.embedding_model = \$\d+/);
    expect(paramsOf(query, 0)).toContain('bge-m3');
    expect(paramsOf(query, 1)).toContain('bge-m3');
  });

  it('对照查询带相似度下限，且默认取配置值', async () => {
    const { service, query } = make();
    await service.contrastExists([0.1], scope);

    expect(sqlOf(query, 0)).toMatch(/1 - \(c\.embedding <=> \$1\) >= \$\d+/);
    expect(paramsOf(query, 0).at(-1)).toBe(0.35);
  });

  it('hasVisibleDocuments 只探一行，不物化版本集合', async () => {
    const { service, query } = make();
    await service.hasVisibleDocuments(scope);

    expect(sqlOf(query, 0)).toContain('LIMIT 1');
    expect(sqlOf(query, 0)).toContain('d.current_version_id = v.id');
  });
});

import { describe, expect, it } from 'vitest';
import { rrfFuse } from './hybrid-retrieval.service';
import type { ChunkRow } from './vector-store.service';

function row(id: string, score: number): ChunkRow {
  return {
    id,
    document_id: 'doc-1',
    version_id: 'v-1',
    chunk_no: 0,
    content: `content-${id}`,
    heading_path: '',
    title: '文档',
    version_no: 1,
    effective_at: null,
    expires_at: null,
    score,
  };
}

describe('rrfFuse（RRF 纯函数，计划书 8.6）', () => {
  it('双路都命中的 chunk 得分高于单路', () => {
    const fused = rrfFuse([row('a', 0.9), row('b', 0.8)], [row('a', 2.1), row('c', 1.5)], 60);
    const a = fused.find((f) => f.chunkId === 'a')!;
    const b = fused.find((f) => f.chunkId === 'b')!;
    expect(a.score).toBeCloseTo(1 / 61 + 1 / 61, 10);
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('排名靠前得分更高（只比排名不比分值）', () => {
    // b 在向量路分值更低但 fts 路排名更高 → 总分超过只出现在向量路第一的 x？不：单路第一名 1/61
    const fused = rrfFuse([row('x', 0.99)], [row('y', 99), row('z', 10)], 60);
    expect(fused[0].chunkId).toBe('x'); // 1/61 vs 1/61 —— 稳定序由 Map 插入顺序保证
    expect(fused.map((f) => f.chunkId)).toEqual(['x', 'y', 'z']);
  });

  it('双路原始分数进 debug（供 /admin/retrieval/debug）', () => {
    const fused = rrfFuse([row('a', 0.9)], [row('a', 2.1), row('c', 1.0)], 60);
    const a = fused.find((f) => f.chunkId === 'a')!;
    expect(a.debug?.vectorScore).toBeCloseTo(0.9, 6);
    expect(a.debug?.ftsScore).toBeCloseTo(2.1, 6);
    expect(a.debug?.vectorRank).toBe(1);
    expect(a.debug?.ftsRank).toBe(1);
    expect(a.debug?.rrfScore).toBeCloseTo(2 / 61, 6);
  });

  it('k 参数影响分差但不改变排名结构', () => {
    const k10 = rrfFuse([row('a', 1), row('b', 0.5)], [], 10);
    const k100 = rrfFuse([row('a', 1), row('b', 0.5)], [], 100);
    expect(k10[0].score - k10[1].score).toBeGreaterThan(k100[0].score - k100[1].score);
  });
});

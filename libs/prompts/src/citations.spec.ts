import { describe, expect, it } from 'vitest';
import { validateCitations } from './citations';
import type { RetrievedChunk } from '@lib/contracts';

function chunk(no: number): RetrievedChunk {
  return {
    chunkId: `c-${no}`,
    documentId: `doc-${no}`,
    versionId: 'v-1',
    versionNo: 3,
    title: `文档${no}`,
    headingPath: '第一章 > 1.1',
    content: `第${no}号片段的原文内容，用于引用溯源验证。`,
    effectiveAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    score: 0.9,
  };
}

describe('validateCitations（引用校验器，计划书 8.7）', () => {
  it('合法编号映射为 citations（编号↔chunkId/版本/原文对应）', () => {
    const chunks = [chunk(1), chunk(2), chunk(3)];
    const answer = '根据资料[1]与[2]的约定处理。';
    const { citedRefs, citations } = validateCitations(answer, chunks);
    expect(citedRefs).toEqual([1, 2]);
    expect(citations[0]).toMatchObject({ no: 1, chunkId: 'c-1', documentId: 'doc-1', versionNo: 3 });
    expect(citations[1].quote).toContain('第2号片段');
  });

  it('越界/幻觉编号剔除并告警', () => {
    const warnings: string[] = [];
    const chunks = [chunk(1), chunk(2)];
    const { citedRefs, citations } = validateCitations('结论[1]与编造的[5]和[99]', chunks, (w) => warnings.push(w));
    expect(citedRefs).toEqual([1]);
    expect(citations).toHaveLength(1);
    expect(warnings.join(' ')).toContain('[5,99]');
  });

  it('重复编号去重；quote 截断 200 字', () => {
    const long = chunk(1);
    long.content = '长'.repeat(500);
    const { citedRefs, citations } = validateCitations('重复引用[1][1]', [long]);
    expect(citedRefs).toEqual([1]);
    expect(citations[0].quote.length).toBe(200);
  });

  it('possiblyOutdated 由 expires_at 推导', () => {
    const soon = chunk(1);
    soon.expiresAt = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    const far = chunk(2);
    far.expiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const { citations } = validateCitations('引用[1][2]', [soon, far]);
    expect(citations[0].possiblyOutdated).toBe(true);
    expect(citations[1].possiblyOutdated).toBe(false);
  });
});

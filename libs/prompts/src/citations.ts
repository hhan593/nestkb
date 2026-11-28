import type { CitationDto, RetrievedChunk } from '@lib/contracts';

/** 引用视为"可能过期"的提前量：expires_at 落在 30 天内或已过期 */
const OUTDATED_WINDOW_MS = 30 * 24 * 3600 * 1000;

export function mapCitation(no: number, chunk: RetrievedChunk): CitationDto {
  const expiredSoon =
    chunk.expiresAt !== null && new Date(chunk.expiresAt).getTime() <= Date.now() + OUTDATED_WINDOW_MS;
  return {
    no,
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    title: chunk.title,
    versionNo: chunk.versionNo,
    headingPath: chunk.headingPath,
    quote: chunk.content.slice(0, 200),
    fullContent: chunk.content.length > 200 ? chunk.content : undefined,
    effectiveAt: chunk.effectiveAt,
    possiblyOutdated: expiredSoon,
  };
}

/**
 * 引用校验器（计划书 8.7）：模型编造的编号（越界/重复）剔除并告警，citations 只保留合法引用。
 * 幻觉引用监控指标：dropped/total 周趋势突增 → 换了模型或改了 prompt。
 */
export function validateCitations(
  answer: string,
  chunks: RetrievedChunk[],
  warn?: (msg: string) => void,
): { answer: string; citedRefs: number[]; citations: CitationDto[] } {
  const used = [...new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const valid = used.filter((n) => n >= 1 && n <= chunks.length);
  if (used.length > valid.length) {
    warn?.(`citation refs dropped: [${used.filter((n) => !valid.includes(n)).join(',')}]`);
  }
  return { answer, citedRefs: valid, citations: valid.map((n) => mapCitation(n, chunks[n - 1])) };
}

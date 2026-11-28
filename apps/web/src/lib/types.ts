/** 与后端契约对应的类型（libs/contracts 的前端镜像） */

export interface CitationDto {
  no: number;
  chunkId: string;
  documentId: string;
  title: string;
  versionNo: number;
  headingPath: string;
  quote: string;
  /** chunk 完整原文（>200 字时携带；历史会话快照无此字段） */
  fullContent?: string;
  effectiveAt: string | null;
  possiblyOutdated: boolean;
}

export interface RetrievalMetaDto {
  topK: number;
  hitCount: number;
  rerankDegraded: boolean;
  latencyMs: number;
  /** rag = 知识库检索增强；chat = 纯对话（缺省视为 rag） */
  mode?: 'rag' | 'chat';
}

export interface UsageDto {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costEstimated: number;
}

export interface Conversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: CitationDto[] | null;
  retrievalSnapshot: {
    topK: number;
    hitCount: number;
    rerankDegraded: boolean;
    chunks: Array<{ chunkId: string; documentId: string; rrfScore?: number | null; rerankScore?: number | null }>;
  } | null;
  latencyMs: number | null;
  status: 'completed' | 'failed' | 'aborted';
  createdAt: string;
}

export interface DocumentRow {
  id: string;
  title: string;
  accessLevel: 'department' | 'company' | 'whitelist';
  departmentId: string;
  versionCount: number;
  currentVersion: {
    id: string;
    versionNo: number;
    effectiveAt: string;
    expiresAt: string | null;
    ingestion: { stage: string; chunkCount: number | null; error: string | null; attempts: number } | null;
  } | null;
}

export interface VersionDto {
  id: string;
  versionNo: number;
  effectiveAt: string;
  expiresAt: string | null;
  isCurrent: boolean;
  checksum: string;
  ingestion: { stage: string; chunkCount: number | null; error: string | null } | null;
}

export interface UsageRow {
  key: string;
  label: string;
  qaCalls: number;
  promptTokens: number;
  completionTokens: number;
  costCny: number;
  avgCostPerQa: number;
  p95CostPerQa: number;
}

export interface UsageSummary {
  rows: UsageRow[];
  alerts: Array<{ level: 'warn' | 'critical'; message: string }>;
}

export interface DebugChunk {
  chunkId: string;
  documentId: string;
  title: string;
  versionNo: number;
  headingPath: string;
  score: number;
  debug?: { vectorScore?: number; ftsScore?: number; rrfScore?: number; rerankScore?: number; vectorRank?: number; ftsRank?: number };
  preview: string;
}

export interface DebugResult {
  retrieval: { topK: number; hitCount: number; rerankDegraded: boolean; latencyMs: number };
  debug: {
    versionIdCount: number;
    vectorTop: Array<{ chunkId: string; score: number }>;
    ftsTop: Array<{ chunkId: string; score: number }>;
    fusedTop: Array<{ chunkId: string; score: number }>;
    rerankedTop: Array<{ chunkId: string; score: number }>;
    breakdown: { embedMs: number; vectorMs: number; ftsMs: number; fuseMs: number; rerankMs: number };
  };
  chunks: DebugChunk[];
}

export interface EvalRun {
  id: string;
  datasetVersion: string;
  triggeredBy: string;
  recallAt5: number | null;
  fidelity: number | null;
  citationAcc: number | null;
  relevance: number | null;
  avgCost: number | null;
  avgLatencyMs: number | null;
  totalCases: number;
  createdAt: string;
}

export function fmtCost(cny: number | null | undefined): string {
  if (cny === null || cny === undefined) return '—';
  if (cny === 0) return '0';
  return cny < 0.01 ? cny.toFixed(6) : cny.toFixed(4);
}

export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString('zh-CN');
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN');
}

/** 相对时间（#59-4 会话列表时间戳）：刚刚 / N 分钟前 / N 小时前 / N 天前，超过 7 天落回日期 */
export function fmtRelTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDate(iso);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export const ACCESS_LEVEL_LABEL: Record<string, string> = {
  department: '部门内',
  company: '全公司',
  whitelist: '白名单',
};

export const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  parsing: '解析中',
  chunking: '分块中',
  embedding: '向量化中',
  storing: '入库中',
  ready: '就绪',
  failed: '失败',
};

export const REASON_LABEL: Record<string, string> = {
  wrong: '答错了',
  no_citation: '没引用',
  outdated: '内容过时',
  not_found: '检索不到',
  other: '其他',
};

/**
 * @lib/contracts —— api / worker 共享的类型契约
 * 队列 job 类型、SSE 事件类型、LLM 通用类型、错误码。
 * 本库保持零依赖（仅类型），任何一侧引入都不会拉起 Nest 运行时。
 */

// ============ 队列 ============

export const INGEST_QUEUE = 'document-ingest';

/** job.data：摄取任务载荷（计划书 8.4） */
export interface IngestJobData {
  documentId: string;
  versionId: string;
  title: string;
  storageKey: string;
  mimeType: string;
  /** sha256（文件内容），幂等键组成 */
  contentHash: string;
  /** 文档归属部门 */
  deptId: string;
  /** 摄取期解析好的 ACL：company → ['*']；department → [deptId]；whitelist → [deptId, ...授权部门] */
  aclDeptIds: string[];
  /** 上传者（摄取 embedding 花费归因） */
  uploadedBy: string;
  /** TraceId，贯穿 API→队列→LLM */
  requestId: string;
}

// ============ SSE 事件协议（计划书 7.3-④，顺序固定：meta→delta*→citations→usage→done；error 后流终止） ============

export interface CitationDto {
  /** 与回答文本中的 [n] 对应 */
  no: number;
  chunkId: string;
  documentId: string;
  title: string;
  versionNo: number;
  headingPath: string;
  /** 被引 chunk 原文片段（截断 200 字） */
  quote: string;
  effectiveAt: string | null;
  /** 由 expires_at 推导（P1 时效治理） */
  possiblyOutdated: boolean;
}

export interface RetrievalMetaDto {
  topK: number;
  hitCount: number;
  rerankDegraded: boolean;
  latencyMs: number;
}

export interface UsageDto {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costEstimated: number;
}

export type QaSseEvent =
  | { event: 'meta'; data: { messageId: string; requestId: string; retrieval: RetrievalMetaDto } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citations'; data: { citations: CitationDto[] } }
  | { event: 'usage'; data: UsageDto }
  | { event: 'done'; data: { latencyMs: number; cached?: boolean } }
  | {
      event: 'error';
      data: {
        code: string;
        message: string;
        retryable?: boolean;
        retrieval?: { hitCount: number };
      };
    };

// ============ LLM 通用类型 ============

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** usage：以 API 返回值为唯一计费依据（计划书 ai-agent/01 约定） */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface ChatStreamResult {
  content: string;
  usage: TokenUsage;
}

// ============ 检索结果类型（vector-store / prompts / api 共用） ============

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  versionId: string;
  versionNo: number;
  title: string;
  headingPath: string;
  content: string;
  effectiveAt: string | null;
  expiresAt: string | null;
  /** 融合/重排后的排序分（RRF 分或 rerank 分，两路量纲不可比） */
  score: number;
  /** 调试信息：双路原始分数与各阶段排名（/admin/retrieval/debug 与 query_logs 数据源） */
  debug?: {
    vectorScore?: number;
    ftsScore?: number;
    rrfScore?: number;
    rerankScore?: number;
    vectorRank?: number;
    ftsRank?: number;
  };
}

// ============ 统一错误码 ============

export const ErrorCodes = {
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  NO_EVIDENCE: 'NO_EVIDENCE',
  PERMISSION_FILTERED: 'PERMISSION_FILTERED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  PARSE_FAILED: 'PARSE_FAILED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

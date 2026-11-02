import { z } from 'zod';

/**
 * zod 环境变量校验（计划书 5.3/18 篇约定）：缺 key / 维度不一致等问题启动即失败。
 * 业务代码只读 AppEnv，不直连 process.env。
 */

export const ENV = Symbol('ENV');

const providerShape = {
  provider: z.enum(['openai-compat', 'mock']).default('mock'),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
};

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 字符'),
    JWT_ACCESS_TTL: z.string().default('2h'),
    JWT_REFRESH_TTL: z.string().default('7d'),

    // 登录防爆破：同一 IP+邮箱失败 N 次锁定，同一 IP 全局限 M 次（15 分钟窗口）
    AUTH_LOGIN_FAIL_LIMIT: z.coerce.number().int().positive().default(10),
    AUTH_LOGIN_IP_LIMIT: z.coerce.number().int().positive().default(50),
    // CORS 来源白名单（逗号分隔）；留空 = 仅允许同源（无 Origin 头的请求放行）
    CORS_ORIGINS: z.string().default(''),

    DATABASE_URL: z.string().min(1),
    PGVECTOR_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    STORAGE_DIR: z.string().default('storage/uploads'),

    LLM_EMBEDDING_PROVIDER: z.enum(['openai-compat', 'mock']).default('mock'),
    LLM_EMBEDDING_BASE_URL: z.string().optional(),
    LLM_EMBEDDING_API_KEY: z.string().optional(),
    LLM_EMBEDDING_MODEL: z.string().default('mock-embedding'),
    EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(32),
    EMBEDDING_RPM: z.coerce.number().int().positive().default(1200),
    EMBED_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

    LLM_CHAT_PROVIDER: z.enum(['openai-compat', 'mock']).default('mock'),
    LLM_CHAT_BASE_URL: z.string().optional(),
    LLM_CHAT_API_KEY: z.string().optional(),
    LLM_CHAT_MODEL: z.string().default('mock-chat'),
    LLM_CHAT_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    CHAT_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

    LLM_RERANK_PROVIDER: z.enum(['openai-compat', 'mock']).default('mock'),
    LLM_RERANK_BASE_URL: z.string().optional(),
    LLM_RERANK_API_KEY: z.string().optional(),
    LLM_RERANK_MODEL: z.string().default('mock-reranker'),
    RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(800),

    PRICE_JSON: z.string().default(
      JSON.stringify({
        'mock-chat': { input: 2, output: 8 },
        'mock-embedding': { input: 0.5 },
        'mock-reranker': { per_call: 0.001 },
      }),
    ),

    RETRIEVAL_TOPK_COARSE: z.coerce.number().int().positive().default(50),
    RETRIEVAL_TOPK_FINAL: z.coerce.number().int().positive().default(8),
    RRF_K: z.coerce.number().int().positive().default(60),

    DEPT_MONTHLY_QUOTA_CNY: z.coerce.number().nonnegative().default(50),
    QA_REQUEST_LIMIT_PER_MIN: z.coerce.number().int().positive().default(5),

    SEMANTIC_CACHE_ENABLED: z
      .string()
      .default('false')
      .transform((v) => ['1', 'true', 'yes'].includes(v.toLowerCase())),
    HISTORY_MAX_TURNS: z.coerce.number().int().positive().default(8),
    HISTORY_KEEP_RECENT: z.coerce.number().int().positive().default(4),

    EVAL_JUDGE_SAMPLES: z.coerce.number().int().positive().default(1),
    MOCK_STREAM_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  })
  .superRefine((cfg, ctx) => {
    // 非 mock provider 必须给全三要素：baseUrl / apiKey / model
    const trios: Array<[string, string, string, string]> = [
      ['chat', 'LLM_CHAT_PROVIDER', 'LLM_CHAT_BASE_URL', 'LLM_CHAT_API_KEY', 'LLM_CHAT_MODEL'] as unknown as [string, string, string, string],
    ];
    void trios;
    const check = (name: string, p: string, url?: string, key?: string, model?: string) => {
      if (p === 'mock') return;
      const missing: string[] = [];
      if (!url) missing.push(`${name}_BASE_URL`);
      if (!key) missing.push(`${name}_API_KEY`);
      if (!model) missing.push(`${name}_MODEL`);
      if (missing.length)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${p}=${p} 时缺少环境变量：${missing.join(', ')}`,
        });
    };
    check('LLM_CHAT', cfg.LLM_CHAT_PROVIDER, cfg.LLM_CHAT_BASE_URL, cfg.LLM_CHAT_API_KEY, cfg.LLM_CHAT_MODEL);
    check('LLM_EMBEDDING', cfg.LLM_EMBEDDING_PROVIDER, cfg.LLM_EMBEDDING_BASE_URL, cfg.LLM_EMBEDDING_API_KEY, cfg.LLM_EMBEDDING_MODEL);
    check('LLM_RERANK', cfg.LLM_RERANK_PROVIDER, cfg.LLM_RERANK_BASE_URL, cfg.LLM_RERANK_API_KEY, cfg.LLM_RERANK_MODEL);
  });

export interface ProviderConfig {
  provider: 'openai-compat' | 'mock';
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

export interface PriceEntry {
  /** 元/百万 token */
  input?: number;
  output?: number;
  /** 元/次（rerank 按调用计价） */
  per_call?: number;
}

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  jwtSecret: string;
  jwtAccessTtl: string;
  jwtRefreshTtl: string;
  /** 登录防爆破阈值（15 分钟窗口） */
  auth: { loginFailLimit: number; loginIpLimit: number };
  /** CORS 来源白名单；空数组 = 仅同源 */
  corsOrigins: string[];
  databaseUrl: string;
  pgvectorUrl: string;
  redisUrl: string;
  storageDir: string;
  chat: ProviderConfig & { temperature: number; idleTimeoutMs: number };
  embedding: ProviderConfig & { dim: number; batchSize: number; rpm: number; timeoutMs: number };
  rerank: ProviderConfig & { timeoutMs: number };
  /** 模型名 → 价格表（元/百万 token 或 元/次）；成本看板与预算闸唯一依据 */
  priceTable: Record<string, PriceEntry>;
  retrieval: { topKCoarse: number; topKFinal: number; rrfK: number };
  quota: { monthlyCny: number };
  qa: { rateLimitPerMin: number; maxHistoryTurns: number; keepRecent: number };
  semanticCacheEnabled: boolean;
  evalJudgeSamples: number;
  mockStreamDelayMs: number;
}

/** 加载 .env（不覆盖已存在的进程环境变量）——免 dotenv 依赖 */
export function loadDotenvFile(path = '.env'): void {
  try {
    const fs = require('node:fs');
    if (!fs.existsSync(path)) return;
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      const hashIdx = val.indexOf(' #');
      if (hashIdx > 0 && !val.startsWith("'") && !val.startsWith('"')) val = val.slice(0, hashIdx).trim();
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env 缺失不致命：显式环境变量仍然生效
  }
}

export function parseEnv(raw: NodeJS.ProcessEnv): AppEnv {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`环境变量校验失败，启动中止：\n${issues}\n请对照 .env.example 补齐。`);
  }
  const c = parsed.data;
  let priceTable: Record<string, PriceEntry>;
  try {
    priceTable = JSON.parse(c.PRICE_JSON);
  } catch {
    throw new Error(`PRICE_JSON 不是合法 JSON：${c.PRICE_JSON.slice(0, 80)}…`);
  }
  return {
    nodeEnv: c.NODE_ENV,
    port: c.PORT,
    jwtSecret: c.JWT_SECRET,
    jwtAccessTtl: c.JWT_ACCESS_TTL,
    jwtRefreshTtl: c.JWT_REFRESH_TTL,
    auth: { loginFailLimit: c.AUTH_LOGIN_FAIL_LIMIT, loginIpLimit: c.AUTH_LOGIN_IP_LIMIT },
    corsOrigins: c.CORS_ORIGINS
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    databaseUrl: c.DATABASE_URL,
    pgvectorUrl: c.PGVECTOR_URL,
    redisUrl: c.REDIS_URL,
    storageDir: c.STORAGE_DIR,
    chat: {
      provider: c.LLM_CHAT_PROVIDER,
      baseUrl: c.LLM_CHAT_BASE_URL,
      apiKey: c.LLM_CHAT_API_KEY,
      model: c.LLM_CHAT_MODEL,
      temperature: c.LLM_CHAT_TEMPERATURE,
      idleTimeoutMs: c.CHAT_IDLE_TIMEOUT_MS,
    },
    embedding: {
      provider: c.LLM_EMBEDDING_PROVIDER,
      baseUrl: c.LLM_EMBEDDING_BASE_URL,
      apiKey: c.LLM_EMBEDDING_API_KEY,
      model: c.LLM_EMBEDDING_MODEL,
      dim: c.EMBEDDING_DIM,
      batchSize: c.EMBEDDING_BATCH_SIZE,
      rpm: c.EMBEDDING_RPM,
      timeoutMs: c.EMBED_TIMEOUT_MS,
    },
    rerank: {
      provider: c.LLM_RERANK_PROVIDER,
      baseUrl: c.LLM_RERANK_BASE_URL,
      apiKey: c.LLM_RERANK_API_KEY,
      model: c.LLM_RERANK_MODEL,
      timeoutMs: c.RERANK_TIMEOUT_MS,
    },
    priceTable,
    retrieval: { topKCoarse: c.RETRIEVAL_TOPK_COARSE, topKFinal: c.RETRIEVAL_TOPK_FINAL, rrfK: c.RRF_K },
    quota: { monthlyCny: c.DEPT_MONTHLY_QUOTA_CNY },
    qa: { rateLimitPerMin: c.QA_REQUEST_LIMIT_PER_MIN, maxHistoryTurns: c.HISTORY_MAX_TURNS, keepRecent: c.HISTORY_KEEP_RECENT },
    semanticCacheEnabled: c.SEMANTIC_CACHE_ENABLED,
    evalJudgeSamples: c.EVAL_JUDGE_SAMPLES,
    mockStreamDelayMs: c.MOCK_STREAM_DELAY_MS,
  };
}

export type EnvSchema = z.infer<typeof envSchema>;

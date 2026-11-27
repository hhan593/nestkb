import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const base = {
  JWT_SECRET: '0123456789abcdef0123456789abcdef',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  PGVECTOR_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6380/0',
};

describe('env 校验（zod，启动即失败）', () => {
  it('缺 JWT_SECRET 直接抛错并列出问题', () => {
    expect(() => parseEnv({ DATABASE_URL: 'x', PGVECTOR_URL: 'x', REDIS_URL: 'x' })).toThrow(/JWT_SECRET/);
  });

  it('mock provider 零配置可用并给出默认值', () => {
    const env = parseEnv(base);
    expect(env.chat.provider).toBe('mock');
    expect(env.embedding.dim).toBe(1024);
    expect(env.retrieval).toEqual({ topKCoarse: 50, topKFinal: 8, rrfK: 60, contrastMinSimilarity: 0.35 });
  });

  it('对照查询相似度下限可配置，越界即启动失败', () => {
    expect(parseEnv({ ...base, RETRIEVAL_CONTRAST_MIN_SIMILARITY: '0.5' }).retrieval.contrastMinSimilarity).toBe(0.5);
    expect(() => parseEnv({ ...base, RETRIEVAL_CONTRAST_MIN_SIMILARITY: '1.5' })).toThrow();
  });

  it('非 mock provider 缺 baseUrl/apiKey/model 时启动失败', () => {
    expect(() =>
      parseEnv({
        ...base,
        LLM_CHAT_PROVIDER: 'openai-compat',
        LLM_CHAT_MODEL: 'gpt-x',
        // 缺 LLM_CHAT_BASE_URL / LLM_CHAT_API_KEY
      }),
    ).toThrow(/LLM_CHAT/);
  });

  it('PRICE_JSON 非法 JSON 报错；合法时解析为价格表', () => {
    expect(() => parseEnv({ ...base, PRICE_JSON: '{oops' })).toThrow(/PRICE_JSON/);
    const env = parseEnv({ ...base, PRICE_JSON: '{"m":{"input":2,"output":8}}' });
    expect(env.priceTable['m'].input).toBe(2);
  });

  it('生产环境默认禁止 mock provider（桩模型不能当生产配置）', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(/仍为 mock/);
  });

  it('生产环境显式放行后可继续用 mock（离线演示/纯前端联调）', () => {
    const env = parseEnv({ ...base, NODE_ENV: 'production', LLM_ALLOW_MOCK_IN_PROD: 'true' });
    expect(env.allowMockInProd).toBe(true);
    expect(env.chat.provider).toBe('mock');
  });

  it('语义缓存开关解析布尔语义', () => {
    expect(parseEnv({ ...base, SEMANTIC_CACHE_ENABLED: 'true' }).semanticCacheEnabled).toBe(true);
    expect(parseEnv(base).semanticCacheEnabled).toBe(false);
  });
});

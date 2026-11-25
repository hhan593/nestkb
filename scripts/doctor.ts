/**
 * doctor：连通性自检（计划书 5.4）——pg/扩展/redis/队列/LLM 三通路，
 * embedding 探针打印维度并强制与 EMBEDDING_DIM 一致（不一致立即报错）。
 */
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { loadDotenvFile, parseEnv } from '../libs/common/src/config/env';
import { MockChatProvider, MockEmbeddingProvider, MockRerankProvider } from '../libs/llm/src/providers/mock';
import {
  OpenAICompatChatProvider,
  OpenAICompatEmbeddingProvider,
  OpenAICompatRerankProvider,
} from '../libs/llm/src/providers/openai-compat';

loadDotenvFile();
const env = parseEnv(process.env);

type Check = { name: string; ok: boolean; detail: string };

async function main(): Promise<void> {
  const checks: Check[] = [];

  // 1. pg + 扩展
  const pool = new Pool({ connectionString: env.pgvectorUrl, max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector,
              (SELECT extversion FROM pg_extension WHERE extname='pg_trgm') AS trgm`,
    );
    checks.push({
      name: 'PostgreSQL + pgvector + pg_trgm',
      ok: Boolean(rows[0]?.vector) && Boolean(rows[0]?.trgm),
      detail: `vector=${rows[0]?.vector ?? 'missing'} trgm=${rows[0]?.trgm ?? 'missing'}`,
    });
    const tables = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`,
    );
    checks.push({ name: '数据表', ok: tables.rows[0].n > 5, detail: `${tables.rows[0].n} 张表（migrate 后应 14+）` });
  } catch (err) {
    checks.push({ name: 'PostgreSQL', ok: false, detail: String(err) });
  }

  // 2. Prisma 连接
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.push({ name: 'Prisma(DATABASE_URL)', ok: true, detail: 'connected' });
  } catch (err) {
    checks.push({ name: 'Prisma(DATABASE_URL)', ok: false, detail: String(err) });
  }

  // 3. Redis
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    const pong = await redis.ping();
    checks.push({ name: 'Redis', ok: pong === 'PONG', detail: env.redisUrl });
  } catch (err) {
    checks.push({ name: 'Redis', ok: false, detail: `${env.redisUrl} ${String(err)}` });
  }

  // 4. embedding 探针（维度必须与 EMBEDDING_DIM 一致 —— 维度错了入库就是废数据）
  const embedder =
    env.embedding.provider === 'mock'
      ? new MockEmbeddingProvider(env)
      : new OpenAICompatEmbeddingProvider(env.embedding, env.embedding.dim, {
          sendDimensions: env.embedding.sendDimensions,
        });
  try {
    const [vec] = await embedder.embed(['知识库连通性探针']);
    const dimOk = vec?.length === env.embedding.dim;
    checks.push({
      name: `Embedding(${env.embedding.provider}/${env.embedding.model})`,
      ok: dimOk,
      detail: `dim=${vec?.length ?? 'n/a'} EMBEDDING_DIM=${env.embedding.dim}${dimOk ? '' : ' ← 不一致，禁止入库'}`,
    });
  } catch (err) {
    checks.push({ name: `Embedding(${env.embedding.provider})`, ok: false, detail: String(err) });
  }

  // 5. chat / rerank 探针
  const chat = env.chat.provider === 'mock' ? new MockChatProvider(env) : new OpenAICompatChatProvider(env.chat);
  try {
    const r = await chat.chatStream([{ role: 'user', content: '回复 OK' }], {});
    checks.push({ name: `Chat(${env.chat.provider}/${env.chat.model})`, ok: r.content.length > 0, detail: `reply=${r.content.slice(0, 20)}` });
  } catch (err) {
    checks.push({ name: `Chat(${env.chat.provider})`, ok: false, detail: String(err) });
  }

  const reranker = env.rerank.provider === 'mock' ? new MockRerankProvider(env) : new OpenAICompatRerankProvider(env.rerank);
  try {
    const r = await reranker.rerank('知识库', ['知识库问答', '今天天气'], 1);
    checks.push({ name: `Rerank(${env.rerank.provider}/${env.rerank.model})`, ok: r.length === 1, detail: JSON.stringify(r) });
  } catch (err) {
    checks.push({ name: `Rerank(${env.rerank.provider})`, ok: false, detail: `${String(err)}（超时降级为 RRF 粗排，非致命）` });
  }

  const priceModels = Object.keys(env.priceTable);
  checks.push({
    name: 'PRICE_JSON',
    ok: priceModels.length > 0,
    detail: priceModels.join(', ') || '为空：成本看板将失真',
  });

  for (const c of checks) {
    console.log(`  ${c.ok ? '✔' : '✘'} ${c.name} — ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `doctor：${failed.length} 项未通过` : 'doctor：全部通过 ✔');

  await Promise.allSettled([pool.end(), prisma.$disconnect(), redis.quit()]);
  if (failed.length) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

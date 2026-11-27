import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { HealthController } from './health.controller';

const env = {
  chat: { provider: 'openai-compat', model: 'spark-x2.6' },
  embedding: { provider: 'openai-compat', model: 'bge-m3' },
  rerank: { provider: 'mock', model: 'mock-reranker' },
};

const reply = () => ({ status: vi.fn() }) as unknown as FastifyReply;

describe('HealthController（运行时身份， #25）', () => {
  it('暴露实际 provider 与最近一次迁移，桩模型可见', async () => {
    const prisma = {
      $queryRaw: vi.fn(async () => [{ migration_name: '20261101000000_init', finished_at: new Date('2026-11-01T00:00:00Z') }]),
    };
    const res = reply();
    const body = await new HealthController(env as never, prisma as never).check(res);

    expect(body.status).toBe('ok');
    expect(body.providers).toEqual({
      chat: 'openai-compat/spark-x2.6',
      embedding: 'openai-compat/bge-m3',
      rerank: 'mock/mock-reranker',
    });
    expect(body.mockInUse).toBe(true);
    expect(body.migration).toEqual({ name: '20261101000000_init', finishedAt: '2026-11-01T00:00:00.000Z' });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('数据库不可达 → 503 + degraded（编排层能看到真实状态）', async () => {
    const prisma = {
      $queryRaw: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    };
    const res = reply();
    const body = await new HealthController(env as never, prisma as never).check(res);

    expect(body.status).toBe('degraded');
    expect(body.database).toBe('unreachable');
    expect(body.migration).toBe('unavailable');
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('迁移表缺失不影响健康判定，只标记 unavailable', async () => {
    let call = 0;
    const prisma = {
      $queryRaw: vi.fn(async () => {
        call += 1;
        if (call === 1) return []; // SELECT 1
        throw new Error('relation "_prisma_migrations" does not exist');
      }),
    };
    const body = await new HealthController(env as never, prisma as never).check(reply());

    expect(body.status).toBe('ok');
    expect(body.migration).toBe('unavailable');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { MeteringService } from './metering.service';

const params = {
  userId: 'u-1',
  deptId: 'd-1',
  scene: 'qa' as const,
  provider: 'mock',
  model: 'mock-chat',
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  requestId: 'req-1',
};

function makeService(createImpl: () => Promise<{ id: string }>) {
  const prisma = { usageRecord: { create: vi.fn(createImpl) } };
  const redis = { del: vi.fn(async () => 1) };
  const prices = { compute: vi.fn(() => 0.002) };
  const service = new MeteringService(prisma as never, redis as never, {} as never, prices as never);
  return { service, prisma, redis };
}

describe('MeteringService.settle —— 预扣键释放（#23）', () => {
  it('落库成功：返回成本与 usageId，并释放预扣键', async () => {
    const { service, redis } = makeService(async () => ({ id: 'usage-1' }));

    const r = await service.settle(params);

    expect(r.usageId).toBe('usage-1');
    expect(redis.del).toHaveBeenCalledWith('quota:res:u-1');
  });

  it('落库失败：仍然释放预扣键，异常继续上抛', async () => {
    const { service, redis } = makeService(async () => {
      throw new Error('db down');
    });

    await expect(service.settle(params)).rejects.toThrow('db down');
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it('释放失败不影响结算结果（release 自身的异常被吞掉）', async () => {
    const { service, redis } = makeService(async () => ({ id: 'usage-2' }));
    redis.del.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.settle(params)).resolves.toEqual({ cost: 0.002, usageId: 'usage-2' });
  });
});

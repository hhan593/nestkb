import { describe, expect, it, vi } from 'vitest';
import { FeedbackService } from './feedback.service';
import type { AuthedUser } from '../auth/auth.service';

const user: AuthedUser = { userId: 'u-1', email: 'u@a-dept.com', role: 'member', deptId: 'd-1' };

const assistantMessage = {
  id: 'm-assistant',
  conversationId: 'c-1',
  role: 'assistant' as const,
  content: '',
  // 毫秒精度：库里是微秒，读回 JS Date 只剩毫秒，这正是 lte 的原因
  createdAt: new Date('2026-11-27T01:49:22.123Z'),
};

function make(opts: { userMsg?: { content: string } | null; dup?: { id: string } | null } = {}) {
  const prisma = {
    message: {
      findUnique: vi.fn(async (_args: { where: { id: string } }) => assistantMessage),
      findFirst: vi.fn(async (_args: { where: unknown; orderBy?: unknown }) =>
        opts.userMsg === null ? null : { content: '代码评审需要几个人批准？' },
      ),
    },
    conversation: { findUnique: vi.fn(async (_args: { where: { id: string } }) => ({ id: 'c-1', userId: 'u-1' })) },
    feedback: { upsert: vi.fn(async (_args: unknown) => ({ id: 'fb-1' })) },
    evalCase: {
      findFirst: vi.fn(async (_args: unknown) => opts.dup ?? null),
      create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'case-1' })),
    },
  };
  return { service: new FeedbackService(prisma as never), prisma };
}

const down = { rating: 'down' as const, reasons: ['wrong'], comment: '答错了' };

describe('FeedbackService 点踩回流（#41 CI 回归）', () => {
  it('查找本轮提问用 lte：同一毫秒内插入的 user/assistant 不能漏掉', async () => {
    const { service, prisma } = make();
    await service.create(user, 'm-assistant', down);

    const where = prisma.message.findFirst.mock.calls[0][0]!.where as {
      role: string;
      createdAt: { lt?: Date; lte?: Date };
    };
    expect(where.role).toBe('user');
    expect(where.createdAt.lte).toEqual(assistantMessage.createdAt);
    expect(where.createdAt.lt).toBeUndefined();
  });

  it('点踩且无重复问题 → 落一条 feedback 来源的评测用例', async () => {
    const { service, prisma } = make();
    const r = await service.create(user, 'm-assistant', down);

    expect(r.queuedForEval).toBe(true);
    expect(prisma.evalCase.create).toHaveBeenCalledTimes(1);
    const data = prisma.evalCase.create.mock.calls[0][0]!.data as { question: string; source: string };
    expect(data.question).toBe('代码评审需要几个人批准？');
    expect(data.source).toBe('feedback');
  });

  it('同问题已在候选池 → 不重复插入', async () => {
    const { service, prisma } = make({ dup: { id: 'case-existing' } });
    const r = await service.create(user, 'm-assistant', down);

    expect(r.queuedForEval).toBe(false);
    expect(prisma.evalCase.create).not.toHaveBeenCalled();
  });

  it('找不到本轮提问（消息链缺失）→ 不回流也不报错', async () => {
    const { service, prisma } = make({ userMsg: null });
    const r = await service.create(user, 'm-assistant', down);

    expect(r.queuedForEval).toBe(false);
    expect(prisma.evalCase.create).not.toHaveBeenCalled();
  });

  it('点赞不回流', async () => {
    const { service, prisma } = make();
    const r = await service.create(user, 'm-assistant', { rating: 'up', reasons: [] });

    expect(r.queuedForEval).toBe(false);
    expect(prisma.evalCase.findFirst).not.toHaveBeenCalled();
  });

  it('只允许反馈自己的会话消息', async () => {
    const { service, prisma } = make();
    prisma.conversation.findUnique.mockResolvedValueOnce({ id: 'c-1', userId: 'u-other' } as never);

    await expect(service.create(user, 'm-assistant', down)).rejects.toThrow('只能反馈自己的会话消息');
  });

  it('原因标签白名单外的值直接拒绝', async () => {
    const { service } = make();
    await expect(service.create(user, 'm-assistant', { rating: 'down', reasons: ['spam'] })).rejects.toThrow(
      /原因标签不合法/,
    );
  });
});

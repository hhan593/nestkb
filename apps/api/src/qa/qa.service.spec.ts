import { describe, expect, it, vi } from 'vitest';
import { NO_VISIBLE_DOCS_ANSWER, PERMISSION_FILTERED_ANSWER } from '@lib/prompts';
import type { AuthedUser } from '../auth/auth.service';
import { QaService, QaStreamSink } from './qa.service';

const user: AuthedUser = { userId: 'u-1', email: 'u@a-dept.com', role: 'member', deptId: 'd-1' };

function makeSink(): QaStreamSink {
  return {
    open: vi.fn(),
    delta: vi.fn(),
    citations: vi.fn(),
    usage: vi.fn(),
    done: vi.fn(),
    error: vi.fn(),
  };
}

/** 只构造 ask() 链路需要的依赖；其余用最小桩，避免测试耦合真实 infra */
function makeService(overrides: { queryLogWrite?: () => Promise<void> } = {}) {
  const prisma = {
    conversation: {
      findFirst: vi.fn(async () => ({ id: 'c-1', title: null, summary: null })),
      update: vi.fn(async () => ({})),
    },
    message: {
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
  };
  const metering = {
    preDeduct: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    settle: vi.fn(async () => ({ cost: 0.001, usageId: 'usage-1' })),
    settlePartial: vi.fn(async () => ({ cost: 0.001, usageId: 'usage-2' })),
  };
  const queryLog = { write: vi.fn(overrides.queryLogWrite ?? (async () => undefined)) };
  const llm = {
    chatStream: vi.fn(async (_m: unknown, opts: { onDelta?: (t: string) => void }) => {
      opts.onDelta?.('你好');
      return { content: '你好', usage: { prompt_tokens: 10, completion_tokens: 2 } };
    }),
    providerName: 'mock',
    model: 'mock-chat',
  };
  const env = {
    retrieval: { topKFinal: 8, topKCoarse: 50, rrfK: 60, contrastMinSimilarity: 0.35 },
    qa: { rateLimitPerMin: 20, maxHistoryTurns: 8, keepRecent: 4 },
    semanticCacheEnabled: false,
  };
  const retrieval = {
    retrieve: vi.fn(),
    contrastExists: vi.fn(async () => false),
    hasVisibleDocuments: vi.fn(async () => true),
  };
  const service = new QaService(
    prisma as never,
    retrieval as never,
    llm as never,
    metering as never,
    queryLog as never,
    { get: vi.fn(), put: vi.fn() } as never,
    env as never,
    { warn: vi.fn(), error: vi.fn(), log: vi.fn() } as never,
  );
  return { service, prisma, metering, queryLog, llm, retrieval };
}

const askOpts = (sink: QaStreamSink) => ({
  conversationId: 'c-1',
  user,
  question: '你好',
  mode: 'chat' as const,
  requestId: 'req-1',
  sink,
});

describe('QaService.ask —— 预扣键生命周期（#23）', () => {
  it('预扣之后的异常路径会释放预扣键（不会把用户锁 5 分钟）', async () => {
    const { service, metering, queryLog } = makeService({
      queryLogWrite: async () => {
        throw new Error('query log down');
      },
    });

    await expect(service.ask(askOpts(makeSink()))).rejects.toThrow('query log down');

    expect(metering.preDeduct).toHaveBeenCalledTimes(1);
    expect(queryLog.write).toHaveBeenCalledTimes(1);
    expect(metering.release).toHaveBeenCalledTimes(1);
    expect(metering.release).toHaveBeenCalledWith(user.userId);
  });

  it('正常结算后不再重复释放（避免误删下一次请求的预留键）', async () => {
    const { service, metering } = makeService();

    await service.ask(askOpts(makeSink()));

    expect(metering.settle).toHaveBeenCalledTimes(1);
    expect(metering.release).not.toHaveBeenCalled();
  });

  it('预扣失败时不会创建预留，也就不需要释放', async () => {
    const { service, metering } = makeService();
    metering.preDeduct.mockRejectedValueOnce(new Error('quota'));

    await service.ask(askOpts(makeSink()));

    expect(metering.release).not.toHaveBeenCalled();
  });

  it('模型调用抛错走部分结算，且不会额外释放', async () => {
    const { service, metering, llm } = makeService();
    llm.chatStream.mockRejectedValueOnce(new Error('upstream down'));

    await service.ask(askOpts(makeSink()));

    expect(metering.settlePartial).toHaveBeenCalledTimes(1);
    expect(metering.release).not.toHaveBeenCalled();
  });
});

const emptyRetrieval = () => ({
  chunks: [],
  degraded: false,
  hitCount: 0,
  latencyMs: 5,
  breakdown: { embedMs: 1, vectorMs: 1, ftsMs: 1, fuseMs: 0, rerankMs: 0 },
});

const ragOpts = (sink: QaStreamSink) => ({ ...askOpts(sink), mode: 'rag' as const });

describe('QaService.ask —— 空召回三态文案（#24）', () => {
  it('用户没有任何可见文档 → 说明可见范围，不暗示"没有依据"', async () => {
    const sink = makeSink();
    const { service, retrieval } = makeService();
    retrieval.retrieve.mockResolvedValueOnce(emptyRetrieval());
    retrieval.hasVisibleDocuments.mockResolvedValueOnce(false);

    await service.ask(ragOpts(sink));

    expect(retrieval.contrastExists).not.toHaveBeenCalled();
    expect(sink.delta).toHaveBeenCalledWith(NO_VISIBLE_DOCS_ANSWER);
    expect(sink.error).not.toHaveBeenCalled();
  });

  it('有可见文档但库里没有相近内容 → 无依据（而非无权限）', async () => {
    const sink = makeSink();
    const { service, retrieval } = makeService();
    retrieval.retrieve.mockResolvedValueOnce(emptyRetrieval());
    retrieval.hasVisibleDocuments.mockResolvedValueOnce(true);
    retrieval.contrastExists.mockResolvedValueOnce(false);

    await service.ask(ragOpts(sink));

    expect(sink.delta).not.toHaveBeenCalled();
    expect(sink.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_EVIDENCE' }));
  });

  it('对照查询命中（同模型、当前版本、达相似度下限）才提示无权限', async () => {
    const sink = makeSink();
    const { service, retrieval } = makeService();
    retrieval.retrieve.mockResolvedValueOnce(emptyRetrieval());
    retrieval.hasVisibleDocuments.mockResolvedValueOnce(true);
    retrieval.contrastExists.mockResolvedValueOnce(true);

    await service.ask(ragOpts(sink));

    expect(sink.delta).toHaveBeenCalledWith(PERMISSION_FILTERED_ANSWER);
    expect(sink.error).not.toHaveBeenCalled();
  });
});

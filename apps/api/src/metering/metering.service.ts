import { Inject, Injectable } from '@nestjs/common';
import { ErrorCodes, TokenUsage, estimateTokens, monthStartUtc8 } from '@lib/contracts';
import { AppEnv, ENV, QuotaExceededException, RateLimitedException, REDIS } from '@app/common';
import type Redis from 'ioredis';
import { PRICE_TABLE, PriceTable } from '@lib/llm';
import { PrismaService } from '@app/prisma';
import type { UsageScene } from '@prisma/client';

const RESERVATION_TTL_SEC = 300;

export interface SettleParams {
  userId: string;
  deptId: string;
  scene: UsageScene;
  provider: string;
  model: string;
  usage: TokenUsage;
  requestId?: string;
}

/**
 * usage 计量与成本（计划书 8.8）：
 * 预扣（Redis TTL 键，只做护栏）→ 结算（以 API 返回的 usage 为唯一依据落库并回冲）→ 中断部分结算防漂移。
 */
@Injectable()
export class MeteringService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(PRICE_TABLE) private readonly prices: PriceTable,
  ) {}

  /** 预扣：部门月配额闸 + 用户级并发预留（上一笔未结算则拒绝） */
  async preDeduct(userId: string, deptId: string, estPromptTokens: number): Promise<void> {
    const dept = await this.prisma.department.findUniqueOrThrow({ where: { id: deptId } });
    const used = await this.monthUsedCny(deptId);
    if (Number(dept.quotaMonth) <= used) {
      throw new QuotaExceededException(deptId, used, Number(dept.quotaMonth));
    }
    const ok = await this.redis.set(`quota:res:${userId}`, String(estPromptTokens), 'EX', RESERVATION_TTL_SEC, 'NX');
    if (!ok) throw new RateLimitedException('上一笔问答尚未结算，请稍候');
  }

  /** 结算：usage_records 落库 + 预扣键回冲。返回成本（元）与记录 id */
  async settle(p: SettleParams): Promise<{ cost: number; usageId: string }> {
    const cost = this.prices.compute(p.model, {
      prompt_tokens: p.usage.prompt_tokens,
      completion_tokens: p.usage.completion_tokens,
      cached_tokens: p.usage.prompt_tokens_details?.cached_tokens ?? 0,
    });
    try {
      const record = await this.prisma.usageRecord.create({
        data: {
          userId: p.userId,
          deptId: p.deptId,
          scene: p.scene,
          provider: `${p.provider}/${p.model}`,
          promptTokens: p.usage.prompt_tokens,
          completionTokens: p.usage.completion_tokens,
          cachedTokens: p.usage.prompt_tokens_details?.cached_tokens ?? 0,
          costEstimated: cost,
          requestId: p.requestId,
        },
      });
      return { cost, usageId: record.id };
    } finally {
      // 结算即释放预扣键：落库失败也要释放，否则调用方只能靠超时（TTL 300s）解锁
      await this.release(p.userId).catch(() => undefined);
    }
  }

  /** 中断/失败部分结算：按已产生字符估算 completion（防费用漂移，计划书 8.2 失败分支） */
  async settlePartial(
    p: SettleParams & { promptTokensEstimate: number; completionChars: number },
  ): Promise<{ cost: number; usageId: string }> {
    const usage: TokenUsage = {
      prompt_tokens: p.promptTokensEstimate,
      completion_tokens: estimateTokens(p.completionChars),
    };
    return this.settle({ ...p, usage });
  }

  /** 早期退出（配额不足等）直接释放预扣键 */
  async release(userId: string): Promise<void> {
    await this.redis.del(`quota:res:${userId}`);
  }

  /** 本月已用（元）= SUM(cost_estimated) WHERE created_at >= 本月 1 日 */
  async monthUsedCny(deptId: string): Promise<number> {
    const agg = await this.prisma.usageRecord.aggregate({
      _sum: { costEstimated: true },
      where: { deptId, createdAt: { gte: monthStartUtc8() } },
    });
    return Number(agg._sum.costEstimated ?? 0);
  }

  get monthlyQuotaCny(): number {
    return this.env.quota.monthlyCny;
  }

  quotaExceededError(used: number, quota: number): QuotaExceededException {
    return new QuotaExceededException('', used, quota);
  }

  get errorCode(): typeof ErrorCodes {
    return ErrorCodes;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { monthStartUtc8 } from '@lib/contracts';
import { AppEnv, ENV } from '@app/common';
import { PrismaService } from '@app/prisma';

export interface UsageSummaryRow {
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
  rows: UsageSummaryRow[];
  alerts: Array<{ level: 'warn' | 'critical'; message: string }>;
}

interface GroupRow {
  deptId?: string;
  userId?: string;
  scene?: string;
  _count?: { _all?: number };
  _sum?: { promptTokens: number | null; completionTokens: number | null; costEstimated: Prisma.Decimal | null };
}

/** 成本看板聚合（计划书 7.3-⑥ / 调研二 §6.1）：按部门/用户/天/场景聚合 token 与费用 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async usageSummary(dim: 'dept' | 'user' | 'day' | 'scene', from: Date, to: Date): Promise<UsageSummary> {
    const where = { createdAt: { gte: from, lte: to } };

    if (dim === 'day') {
      // 日期维度需要原生 SQL 的 date_trunc
      const dayRows = await this.prisma.$queryRaw<Array<{
        day: Date;
        qa_calls: bigint;
        prompt_tokens: bigint;
        completion_tokens: bigint;
        cost: string | null;
      }>>`
        SELECT date_trunc('day', created_at) AS day,
               COUNT(*) FILTER (WHERE scene = 'qa') AS qa_calls,
               SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
               SUM(cost_estimated) AS cost
          FROM usage_records WHERE created_at >= ${from} AND created_at <= ${to}
         GROUP BY 1 ORDER BY 1`;
      const p95Day = await this.p95Cost(from, to, null);
      return {
        rows: dayRows.map((r) => ({
          key: r.day.toISOString().slice(0, 10),
          label: r.day.toISOString().slice(0, 10),
          qaCalls: Number(r.qa_calls),
          promptTokens: Number(r.prompt_tokens ?? 0),
          completionTokens: Number(r.completion_tokens ?? 0),
          costCny: Number(r.cost ?? 0),
          avgCostPerQa: Number(r.qa_calls) ? Number(r.cost ?? 0) / Number(r.qa_calls) : 0,
          p95CostPerQa: p95Day,
        })),
        alerts: [],
      };
    }

    const groupBy: string[] = { dept: ['deptId'], user: ['userId'], scene: ['scene'] }[dim];
    const grouped = (await this.prisma.usageRecord.groupBy({
      by: groupBy as ['deptId'] | ['userId'] | ['scene'],
      where,
      _sum: { promptTokens: true, completionTokens: true, costEstimated: true },
      _count: { _all: true },
    })) as unknown as GroupRow[];
    const qaCounts = (await this.prisma.usageRecord.groupBy({
      by: groupBy as ['deptId'] | ['userId'] | ['scene'],
      where: { ...where, scene: 'qa' },
      _count: { _all: true },
    })) as unknown as GroupRow[];
    const qaMap = new Map(qaCounts.map((q) => [keyOf(q, groupBy), Number(q._count?._all ?? 0)]));

    const labels = await this.resolveLabels(dim);
    const rows: UsageSummaryRow[] = [];
    for (const g of grouped) {
      const k = keyOf(g, groupBy);
      const cost = Number(g._sum?.costEstimated ?? 0);
      const qaCalls = qaMap.get(k) ?? 0;
      rows.push({
        key: k,
        label: labels.get(k) ?? k,
        qaCalls,
        promptTokens: Number(g._sum?.promptTokens ?? 0),
        completionTokens: Number(g._sum?.completionTokens ?? 0),
        costCny: Number(cost.toFixed(4)),
        avgCostPerQa: qaCalls ? Number((cost / qaCalls).toFixed(6)) : 0,
        p95CostPerQa: await this.p95Cost(from, to, dim === 'dept' || dim === 'user' ? k : null),
      });
    }
    rows.sort((a, b) => b.costCny - a.costCny);
    return { rows, alerts: dim === 'dept' ? await this.quotaAlerts() : [] };
  }

  /** 预算闸告警（看板 alerts 数据源）：>=80% warn，>=100% critical */
  async quotaAlerts(): Promise<Array<{ level: 'warn' | 'critical'; message: string }>> {
    const depts = await this.prisma.department.findMany();
    const alerts: Array<{ level: 'warn' | 'critical'; message: string }> = [];
    for (const d of depts) {
      const agg = await this.prisma.usageRecord.aggregate({
        _sum: { costEstimated: true },
        where: { deptId: d.id, createdAt: { gte: monthStartUtc8() } },
      });
      const used = Number(agg._sum.costEstimated ?? 0);
      const quota = Number(d.quotaMonth);
      const ratio = quota > 0 ? used / quota : 0;
      if (ratio >= 1) alerts.push({ level: 'critical', message: `${d.name}本月已用预算 ${Math.round(ratio * 100)}%，已降级只读检索` });
      else if (ratio >= 0.8) alerts.push({ level: 'warn', message: `${d.name}本月已用预算 ${Math.round(ratio * 100)}%` });
    }
    return alerts;
  }

  /** 单次问答成本 P95：按 requestId 聚合 qa 场景的 cost 后取分位 */
  private async p95Cost(from: Date, to: Date, deptId: string | null): Promise<number> {
    const deptFilter = deptId ? Prisma.sql`AND r.dept_id = ${deptId}::uuid` : Prisma.empty;
    const result = await this.prisma.$queryRaw<Array<{ p95: string | null }>>`
      SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY cost) AS p95
        FROM (SELECT r.request_id, SUM(r.cost_estimated) AS cost
                FROM usage_records r
               WHERE r.scene = 'qa' AND r.request_id IS NOT NULL
                 AND r.created_at >= ${from} AND r.created_at <= ${to}
                 ${deptFilter}
               GROUP BY r.request_id) t`;
    return Number(result[0]?.p95 ?? 0);
  }

  private async resolveLabels(dim: 'dept' | 'user' | 'day' | 'scene'): Promise<Map<string, string>> {
    if (dim === 'dept') {
      const depts = await this.prisma.department.findMany();
      return new Map(depts.map((d) => [d.id, d.name]));
    }
    if (dim === 'user') {
      const users = await this.prisma.user.findMany();
      return new Map(users.map((u) => [u.id, u.email]));
    }
    return new Map();
  }
}

function keyOf(record: GroupRow, groupBy: string[]): string {
  if (!groupBy.length) return '';
  return String(record[groupBy[0] as keyof GroupRow] ?? '');
}



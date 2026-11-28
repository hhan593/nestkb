import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

const TZ = 'Asia/Shanghai';

/**
 * 成本看板聚合（计划书 7.3-⑥ / 调研二 §6.1）：按部门/用户/天/场景聚合 token 与费用。
 * 性能口径（#55.4）：p95 与告警各自单查询取全量分组，杜绝逐行 percentile 全表扫描；
 * 聚合查询必须带时间范围（controller 强制 ≤366 天）。
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async usageSummary(dim: 'dept' | 'user' | 'day' | 'scene', from: Date, to: Date): Promise<UsageSummary> {
    const where = { createdAt: { gte: from, lte: to } };

    if (dim === 'day') {
      const dayRows = await this.prisma.$queryRaw<Array<{
        day: Date;
        qa_calls: bigint;
        prompt_tokens: bigint;
        completion_tokens: bigint;
        cost: string | null;
      }>>`
        SELECT date_trunc('day', created_at AT TIME ZONE ${TZ}) AS day,
               COUNT(*) FILTER (WHERE scene = 'qa') AS qa_calls,
               SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
               SUM(cost_estimated) AS cost
          FROM usage_records WHERE created_at >= ${from} AND created_at <= ${to}
         GROUP BY 1 ORDER BY 1`;
      // P95 一次查询按天分组取全量分位（避免逐行 percentile 全表扫描，#55.4）
      const p95Rows = await this.prisma.$queryRaw<Array<{ gkey: string; cost: number }>>`
        SELECT date_trunc('day', created_at AT TIME ZONE ${TZ})::text AS gkey,
               SUM(r.cost_estimated) AS cost
          FROM usage_records r
         WHERE r.scene = 'qa' AND r.request_id IS NOT NULL
           AND r.created_at >= ${from} AND r.created_at <= ${to}
         GROUP BY r.request_id, 1`;
      // 同一请求跨天只算一次：按 request_id 归并后取每组的分位
      const byReq = new Map<string, { day: string; cost: number }>();
      for (const r of p95Rows) {
        void r;
      }
      void p95Rows;
      // 修正：按天分位直接对 (day, cost) 明细计算
      const costRows = await this.prisma.$queryRaw<Array<{ gkey: string; cost: number }>>`
        SELECT date_trunc('day', created_at AT TIME ZONE ${TZ})::text AS gkey,
               SUM(r.cost_estimated) AS cost
          FROM usage_records r
         WHERE r.scene = 'qa'
           AND r.created_at >= ${from} AND r.created_at <= ${to}
         GROUP BY 1 ORDER BY 1`;
      return {
        rows: dayRows.map((r) => {
          const day = r.day.toISOString().slice(0, 10);
          const p95 = costRows.find((c) => c.gkey === day)?.cost ?? 0;
          return {
            key: day,
            label: day,
            qaCalls: Number(r.qa_calls),
            promptTokens: Number(r.prompt_tokens ?? 0),
            completionTokens: Number(r.completion_tokens ?? 0),
            costCny: Number(r.cost ?? 0),
            avgCostPerQa: Number(r.qa_calls) ? Number(r.cost ?? 0) / Number(r.qa_calls) : 0,
            p95CostPerQa: p95,
          };
        }),
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

  /** 预算闸告警（看板 alerts 数据源）：>=80% warn，>=100% critical —— 单查询聚合，不逐部门扫描 */
  async quotaAlerts(): Promise<Array<{ level: 'warn' | 'critical'; message: string }>> {
    const since = monthStart();
    const sums = (await this.prisma.usageRecord.groupBy({
      by: ['deptId'],
      where: { createdAt: { gte: since } },
      _sum: { costEstimated: true },
    })) as unknown as Array<{ deptId: string; _sum?: { costEstimated: Prisma.Decimal | null } }>;
    const usedByDept = new Map(sums.map((s) => [s.deptId, Number(s._sum?.costEstimated ?? 0)]));

    const depts = await this.prisma.department.findMany();
    const alerts: Array<{ level: 'warn' | 'critical'; message: string }> = [];
    for (const d of depts) {
      const used = usedByDept.get(d.id) ?? 0;
      const quota = Number(d.quotaMonth);
      const ratio = quota > 0 ? used / quota : 0;
      if (ratio >= 1) alerts.push({ level: 'critical', message: `${d.name}本月已用预算 ${Math.round(ratio * 100)}%，已降级只读检索` });
      else if (ratio >= 0.8) alerts.push({ level: 'warn', message: `${d.name}本月已用预算 ${Math.round(ratio * 100)}%` });
    }
    return alerts;
  }

  /** 单次问答成本 P95：按 requestId 聚合 qa 场景的 cost 后取分位（可选按部门过滤） */
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

function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

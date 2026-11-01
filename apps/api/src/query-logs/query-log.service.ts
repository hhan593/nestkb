import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/prisma';

/** 检索侧原始流水（计划书 6.7）：与 messages 分离，分层归因（难点 8）全靠本表 */
@Injectable()
export class QueryLogService {
  constructor(private readonly prisma: PrismaService) {}

  async write(entry: {
    userId?: string | null;
    deptId?: string | null;
    query: string;
    scene: 'qa' | 'debug' | 'eval' | 'cache_lookup';
    accessFilter: Prisma.InputJsonValue;
    hitCount?: number | null;
    vectorTop?: Prisma.InputJsonValue | null;
    ftsTop?: Prisma.InputJsonValue | null;
    fusedTop?: Prisma.InputJsonValue | null;
    rerankedTop?: Prisma.InputJsonValue | null;
    rerankDegraded?: boolean;
    latencyBreakdown?: Prisma.InputJsonValue | null;
    totalMs?: number | null;
    requestId?: string | null;
  }): Promise<void> {
    await this.prisma.queryLog.create({
      data: {
        userId: entry.userId ?? undefined,
        deptId: entry.deptId ?? undefined,
        query: entry.query,
        scene: entry.scene,
        accessFilter: entry.accessFilter,
        hitCount: entry.hitCount ?? null,
        vectorTop: entry.vectorTop ?? Prisma.DbNull,
        ftsTop: entry.ftsTop ?? Prisma.DbNull,
        fusedTop: entry.fusedTop ?? Prisma.DbNull,
        rerankedTop: entry.rerankedTop ?? Prisma.DbNull,
        rerankDegraded: entry.rerankDegraded ?? false,
        latencyBreakdown: entry.latencyBreakdown ?? Prisma.DbNull,
        totalMs: entry.totalMs ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }
}

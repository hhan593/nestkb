import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AccessScope, HybridRetrievalService } from '@lib/vector-store';
import { Roles } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthedUser } from '../auth/auth.service';
import { AdminService } from './admin.service';
import { QueryLogService } from '../query-logs/query-log.service';
import { PrismaService } from '@app/prisma';
import { Inject } from '@nestjs/common';
import { REDIS } from '@app/common';
import type Redis from 'ioredis';
import { invalidateDeptCache } from '../qa/semantic-cache.service';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

class UsageQueryDto {
  @IsOptional()
  @IsString()
  dim?: 'dept' | 'user' | 'day' | 'scene';

  @IsDateString({}, { message: 'from 需为 ISO 日期' })
  from!: string;

  @IsDateString({}, { message: 'to 需为 ISO 日期' })
  to!: string;
}

class ExpireDto {
  @IsDateString()
  expiresAt!: string;
}

class QuotaDto {
  @IsInt()
  @Min(0)
  quotaMonth!: number;
}

class GrantDto {
  @IsIn(['dept', 'user'])
  subjectType!: 'dept' | 'user';

  @IsUUID()
  subjectId!: string;

  /** ISO 时间；不传表示长期有效 */
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

class ImportCasesDto {
  cases!: Array<{
    question: string;
    caseType?: 'fact' | 'table' | 'timeliness' | 'deny' | 'multi_hop';
    goldAnswer?: string | null;
    goldMarkers?: string[];
    expectDeny?: boolean;
  }>;
}
void ImportCasesDto;

/** 管理端（计划书 7.2-15/16/17 + P1）：成本看板 / 检索调试 / 时效与配额治理 */
@Controller('admin')
@Roles('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly retrieval: HybridRetrievalService,
    private readonly queryLog: QueryLogService,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** 部门与用户清单（授权下拉/配额调整的数据源） */
  @Get('departments')
  async departments() {
    const depts = await this.prisma.department.findMany({ select: { id: true, name: true, quotaMonth: true } });
    return depts.map((d) => ({ ...d, quotaMonth: Number(d.quotaMonth) }));
  }

  @Get('users')
  async users() {
    const users = await this.prisma.user.findMany({
      select: { id: true, email: true, role: true, department: { select: { name: true } } },
    });
    return users;
  }

  @Get('usage/summary')
  async usageSummary(@Query() q: UsageQueryDto) {
    const dim = q.dim ?? 'dept';
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from/to 日期不合法');
    }
    return this.admin.usageSummary(dim, from, to);
  }

  /** 检索调试视图（计划书 P1-11 / 难点 8）：双路分数、RRF 排名、rerank 前后对比、分段延迟 */
  @Get('retrieval/debug')
  async retrievalDebug(
    @CurrentUser() user: AuthedUser,
    @Query('q') q: string,
    @Query('deptId') deptId?: string,
  ): Promise<unknown> {
    if (!q?.trim()) throw new BadRequestException('缺少 q 参数');
    const scope: AccessScope = deptId
      ? { userId: user.userId, deptId, isAdmin: false } // 以指定部门视角复现权限过滤
      : { userId: user.userId, deptId: user.deptId, isAdmin: true };
    const result = await this.retrieval.retrieve(q, scope, { debug: true });
    await this.queryLog.write({
      userId: user.userId,
      deptId: scope.deptId,
      query: q,
      scene: 'debug',
      accessFilter: { deptId: scope.deptId, isAdmin: scope.isAdmin },
      hitCount: result.hitCount,
      vectorTop: result.debug?.vectorTop ?? null,
      ftsTop: result.debug?.ftsTop ?? null,
      fusedTop: result.debug?.fusedTop ?? null,
      rerankedTop: result.debug?.rerankedTop ?? null,
      rerankDegraded: result.degraded,
      latencyBreakdown: result.breakdown,
      totalMs: result.latencyMs,
    });
    return {
      retrieval: {
        topK: result.chunks.length,
        hitCount: result.hitCount,
        rerankDegraded: result.degraded,
        latencyMs: result.latencyMs,
      },
      debug: result.debug,
      chunks: result.chunks.map((c) => ({
        chunkId: c.chunkId,
        documentId: c.documentId,
        title: c.title,
        versionNo: c.versionNo,
        headingPath: c.headingPath,
        score: c.score,
        debug: c.debug,
        preview: c.content.slice(0, 120),
      })),
    };
  }

  /** 标记过期（P1 时效治理）：过期文档不可召回 */
  @Post('documents/:id/expire')
  async expire(@Param('id') id: string, @Body() dto: ExpireDto) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc?.currentVersionId) throw new BadRequestException('文档不存在或无当前版本');
    await this.prisma.documentVersion.update({
      where: { id: doc.currentVersionId },
      data: { expiresAt: new Date(dto.expiresAt) },
    });
    // 部门语义缓存可能引用刚过期的文档：立即失效
    await invalidateDeptCache(this.redis, doc.departmentId);
    return { expired: true, expiresAt: dto.expiresAt };
  }

  /** 调整部门月预算 */
  @Post('departments/:id/quota')
  async setQuota(@Param('id') id: string, @Body() dto: QuotaDto) {
    await this.prisma.department.update({ where: { id }, data: { quotaMonth: dto.quotaMonth } });
    return { quotaMonth: dto.quotaMonth };
  }

  /** 评估回归报告列表：见 EvalController GET /admin/eval/runs */

  /** 白名单授权管理：为文档增加部门/个人授权 */
  @Post('documents/:id/grants')
  async grant(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: GrantDto,
  ) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new BadRequestException('文档不存在');
    if (dto.subjectType === 'dept') await this.prisma.department.findUniqueOrThrow({ where: { id: dto.subjectId } });
    const grant = await this.prisma.deptPermission.upsert({
      where: { documentId_subjectType_subjectId: { documentId: id, subjectType: dto.subjectType, subjectId: dto.subjectId } },
      create: {
        documentId: id,
        subjectType: dto.subjectType,
        subjectId: dto.subjectId,
        effect: 'allow',
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        grantedBy: user.userId,
      },
      update: { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null },
    });
    return { grantId: grant.id };
  }
}


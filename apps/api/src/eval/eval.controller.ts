import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthedUser } from '../auth/auth.service';
import { EvalService } from './eval.service';
import { PrismaService } from '@app/prisma';

class RunEvalDto {
  datasetVersion?: string;
  triggeredBy?: string;
}

/** 评估回归触发（计划书 7.2-18 + P1）：pnpm eval / CI 调同一入口 */
@Controller('admin/eval')
@Roles('admin')
export class EvalController {
  constructor(
    private readonly evalService: EvalService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('runs')
  async run(@CurrentUser() user: AuthedUser, @Body() dto: RunEvalDto) {
    const run = await this.evalService.run(user, dto.datasetVersion ?? 'v1', dto.triggeredBy ?? 'manual');
    return this.decimalize(run as unknown as Record<string, unknown>);
  }

  @Get('runs')
  async list() {
    const runs = await this.prisma.evalRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return runs.map((r) => this.decimalize(r as unknown as Record<string, unknown>));
  }

  /** 点踩/失败专项批量导入评测集（source 可标注，防过拟合的三来源之一） */
  @Post('cases/import')
  async importCases(@Body() dto: { cases: Array<{
    question: string;
    caseType?: 'fact' | 'table' | 'timeliness' | 'deny' | 'multi_hop';
    goldAnswer?: string | null;
    goldMarkers?: string[];
    expectDeny?: boolean;
    source?: 'manual' | 'feedback' | 'incident';
  }> }) {
    if (!Array.isArray(dto?.cases) || dto.cases.length === 0) throw new BadRequestException('cases 不能为空');
    const created = await this.prisma.$transaction(
      dto.cases.map((c) =>
        this.prisma.evalCase.create({
          data: {
            question: c.question,
            caseType: c.caseType ?? 'fact',
            goldAnswer: c.goldAnswer ?? null,
            goldChunkIds: [],
            goldMarkers: c.goldMarkers ?? [],
            source: c.source ?? 'manual',
            expectDeny: c.expectDeny ?? false,
          },
        }),
      ),
    );
    return { imported: created.length };
  }

  /** 点踩回流候选池列表（W5 每周回流入口） */
  @Get('cases')
  async cases(@Query('source') source?: string) {
    return this.prisma.evalCase.findMany({
      where: source ? { source: source as 'manual' | 'feedback' | 'incident' } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private decimalize(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] =
        typeof v === 'object' && v !== null && 'toNumber' in v
          ? (v as { toNumber(): number }).toNumber()
          : typeof v === 'object' && v !== null
            ? this.decimalize(v as Record<string, unknown>)
            : v;
    }
    return out;
  }
}

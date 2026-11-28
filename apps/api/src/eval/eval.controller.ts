import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { Roles } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthedUser } from '../auth/auth.service';
import { EvalService } from './eval.service';
import { PrismaService } from '@app/prisma';

/** 无装饰器的 DTO 会被全局 ValidationPipe（whitelist:true）整体剥空：字段必须声明校验规则（#33） */
class RunEvalDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  datasetVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  triggeredBy?: string;
}

/** 批量导入 DTO：显式校验规则必须声明，否则 whitelist:true 会把字段整体剥空（#33 / #55.10） */
class ImportCaseInput {
  @IsString() @Length(1, 500) question!: string;
  @IsOptional() @IsIn(['fact', 'table', 'timeliness', 'deny', 'multi_hop']) caseType?: 'fact' | 'table' | 'timeliness' | 'deny' | 'multi_hop';
  @IsOptional() @IsString() @MaxLength(2000) goldAnswer?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @Length(1, 200, { each: true }) goldMarkers?: string[];
  @IsOptional() @IsBoolean() expectDeny?: boolean;
  @IsOptional() @IsIn(['manual', 'feedback', 'incident']) source?: 'manual' | 'feedback' | 'incident';
}

class ImportCasesDto {
  @IsArray() @ArrayMaxSize(500) cases!: ImportCaseInput[];
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
  async importCases(@Body() dto: ImportCasesDto) {
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

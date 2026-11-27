import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AppEnv, ENV, SkipResponseWrap } from '@app/common';
import { PrismaService } from '@app/prisma';
import { Public } from '../auth';

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
}

/** 迁移信息三态：null = 无迁移记录，'unavailable' = 查不到（表缺失/权限不足） */
type MigrationInfo = { name: string; finishedAt: string | null } | null | 'unavailable';

/**
 * 运行时身份 + 健康检查（#25）。
 *
 * 起因：生产环境整段跑 mock provider 而无任何信号 —— 回答永远是模板、成本恒为 0，却看起来一切正常。
 * 这里把「实际生效的 provider」直接暴露出来，核对一次 /health 比翻日志快；数据库不可达时返回 503，
 * 让编排层能看到真实状态而不是只有一个静态前端页面。
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(ENV) private readonly env: AppEnv,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get()
  @SkipResponseWrap() // 运维探针/监控按裸 JSON 读，不套 { code, data } 信封
  async check(@Res({ passthrough: true }) res: FastifyReply) {
    const database = await this.pingDatabase();
    if (database !== 'ok') res.status(503);
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      providers: {
        chat: `${this.env.chat.provider}/${this.env.chat.model}`,
        embedding: `${this.env.embedding.provider}/${this.env.embedding.model}`,
        rerank: `${this.env.rerank.provider}/${this.env.rerank.model}`,
      },
      /** 任一路仍是桩模型（仅可能出现在显式放行的非生产环境） */
      mockInUse: [this.env.chat, this.env.embedding, this.env.rerank].some((p) => p.provider === 'mock'),
      database,
      migration: database === 'ok' ? await this.latestMigration() : 'unavailable',
      imageVersion: process.env.IMAGE_VERSION ?? process.env.GIT_SHA ?? 'dev',
      uptimeSec: Math.round(process.uptime()),
    };
  }

  private async pingDatabase(): Promise<'ok' | 'unreachable'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'unreachable';
    }
  }

  private async latestMigration(): Promise<MigrationInfo> {
    try {
      const rows = await this.prisma.$queryRaw<MigrationRow[]>`
        SELECT migration_name, finished_at
          FROM _prisma_migrations
         WHERE finished_at IS NOT NULL
         ORDER BY finished_at DESC
         LIMIT 1`;
      const row = rows[0];
      return row ? { name: row.migration_name, finishedAt: row.finished_at ? row.finished_at.toISOString() : null } : null;
    } catch {
      return 'unavailable';
    }
  }
}

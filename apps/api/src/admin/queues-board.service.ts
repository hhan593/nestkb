import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { InjectQueue } from '@nestjs/bullmq';
import { JwtService } from '@nestjs/jwt';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter as BoardFastifyAdapter } from '@bull-board/fastify';
import type { FastifyInstance } from 'fastify';
import { INGEST_QUEUE } from '@lib/contracts';
import type { AuthedUser } from '../auth/auth.service';

/**
 * bull-board 挂 /admin/queues（积压/DLQ 看板，admin 鉴权）。
 * 用 onRequest 钩子做 JWT+admin 校验 —— 插件路由不经过 Nest 守卫链。
 */
@Injectable()
export class QueuesBoardService implements OnModuleInit {
  constructor(
    @InjectQueue(INGEST_QUEUE) private readonly queue: Queue,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly jwt: JwtService,
  ) {}

  onModuleInit(): void {
    const server = this.httpAdapterHost.httpAdapter.getInstance<FastifyInstance>();
    const basePath = '/admin/queues';

    server.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith(basePath)) return;
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) {
        await reply.code(401).send({ code: 'UNAUTHORIZED', message: '缺少 Bearer token' });
        return;
      }
      try {
        const payload = await this.jwt.verifyAsync<{ sub: string; role: string; type: string }>(header.slice(7));
        if (payload.type !== 'access' || payload.role !== 'admin') throw new Error('not admin');
        (req as unknown as { user: AuthedUser }).user = {
          userId: payload.sub,
          email: '',
          role: 'admin',
          deptId: '',
        };
      } catch {
        await reply.code(403).send({ code: 'FORBIDDEN', message: '需要管理员权限' });
      }
    });

    const adapter = new BoardFastifyAdapter();
    adapter.setBasePath(basePath);
    createBullBoard({ queues: [new BullMQAdapter(this.queue)], serverAdapter: adapter });
    void server.register(adapter.registerPlugin() as never, { prefix: basePath });
  }
}

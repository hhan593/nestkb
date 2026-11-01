import { Injectable, NestMiddleware } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * TraceId 贯穿（计划书 74 篇）：入口生成/透传 x-request-id，
 * AsyncLocalStorage 让任意层级的日志与落库都能拿到当前请求的 requestId。
 */
@Injectable()
export class TraceService {
  private readonly als = new AsyncLocalStorage<{ requestId: string }>();

  run<T>(requestId: string, fn: () => T): T {
    return this.als.run({ requestId }, fn);
  }

  get requestId(): string {
    return this.als.getStore()?.requestId ?? '';
  }

  newRequestId(): string {
    return randomUUID();
  }
}

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  constructor(private readonly trace: TraceService) {}

  use(req: FastifyRequest, res: FastifyReply['raw'] & { setHeader?: unknown }, next: () => void): void {
    const incoming = (req.headers['x-request-id'] as string | undefined) || this.trace.newRequestId();
    const raw = res as unknown as { setHeader(name: string, value: string): void };
    try {
      raw.setHeader('x-request-id', incoming);
    } catch {
      // headers already sent 等场景忽略
    }
    this.trace.run(incoming, next);
  }
}

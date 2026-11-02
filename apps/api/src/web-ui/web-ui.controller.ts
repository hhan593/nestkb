import { Controller, Get, Req, Res } from '@nestjs/common';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SkipResponseWrap } from '@app/common';
import { Public } from '../auth';

const WEB_DIST = path.join(process.cwd(), 'apps', 'web', 'dist');

/**
 * 前端 SPA 托管（构建产物 apps/web/dist 存在时）：
 * - `/assets/*` 由 @fastify/static 动态通配提供（main.ts，rebuild 后新 hash 自动生效）；
 * - `/` 与客户端路由（/login 等）由本控制器兜底返回 index.html——
 *   find-my-way 静态段优先于 `*`，不遮蔽 API 路由；
 * - 产物不存在时返回 404 JSON（纯 API 部署形态）。
 * 不缓存 index.html：rebuild 后 hash 引用即时生效。
 */
@Controller()
export class WebUiController {
  private readonly hasWeb = existsSync(path.join(WEB_DIST, 'index.html'));

  @Get()
  @Public()
  @SkipResponseWrap()
  async serveRoot(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    return this.serve(req, res);
  }

  @Get('*')
  @Public()
  @SkipResponseWrap()
  async serve(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const url = (req.url || '').split('?')[0];
    // API 路径空间永不返回 SPA（即便路径未命中 API 路由，也保持 JSON 404 语义）
    const isApi = /^\/(auth|documents|qa|messages|admin)(\/|$)/.test(url);
    const isPage = req.headers.accept?.toString().includes('text/html') ?? false;
    if (!this.hasWeb || isApi || !isPage) {
      void res.code(404).type('application/json').send({ code: 'NOT_FOUND', message: `路由不存在: ${req.method} ${req.url}` });
      return;
    }
    const html = await fs.readFile(path.join(WEB_DIST, 'index.html'), 'utf8');
    void res.type('text/html').send(html);
  }
}

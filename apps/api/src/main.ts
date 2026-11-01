import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ENV } from '@app/common';
import { AppModule } from './app.module';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // ≤20MB（计划书 P0-2）
const WEB_DIST = path.join(process.cwd(), 'apps', 'web', 'dist');

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({ bodyLimit: MAX_UPLOAD_BYTES + 1024 * 1024 });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['log', 'warn', 'error'],
  });

  await app.register(multipart as never, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  });
  await app.register(helmet as never, { contentSecurityPolicy: false });
  await app.register(cors as never, { origin: true, credentials: true });

  // 前端构建产物存在时由 API 同源托管（生产部署形态）：
  // /assets/* 用动态通配 —— rebuild 后新 hash 文件名自动可服务（wildcard:false 会在启动时固化文件路由，导致新构建 404）
  const hasWeb = existsSync(path.join(WEB_DIST, 'assets'));
  if (hasWeb) {
    await app.register(fastifyStatic as never, {
      root: path.join(WEB_DIST, 'assets'),
      prefix: '/assets/',
      decorateReply: false,
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableShutdownHooks();

  await app.init();

  const env = app.get(ENV);
  await app.listen(env.port, '0.0.0.0');
  console.log(
    `${new Date().toISOString()} LOG [api] listening on http://0.0.0.0:${env.port}${hasWeb ? '（含前端 SPA）' : '（仅 API）'}`,
  );
}

void bootstrap();

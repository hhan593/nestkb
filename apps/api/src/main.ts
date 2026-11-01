import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { ENV } from '@app/common';
import { AppModule } from './app.module';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // ≤20MB（计划书 P0-2）

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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableShutdownHooks();

  const env = app.get(ENV);
  await app.listen(env.port, '0.0.0.0');
  console.log(`${new Date().toISOString()} LOG [api] listening on http://0.0.0.0:${env.port}`);
}

void bootstrap();

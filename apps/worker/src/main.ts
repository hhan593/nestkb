import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * 摄取 Worker 进程入口：无 HTTP。
 * SIGTERM 停机钩子：BullMQ WorkerHost close 会等当前 job 完成再退出（78 篇优雅停机）。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
    bufferLogs: false,
  });
  app.enableShutdownHooks();
  await app.init();
  console.log(`${new Date().toISOString()} LOG [worker] ingestion worker started, waiting for jobs...`);
}

void bootstrap();

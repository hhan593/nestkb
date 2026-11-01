import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { CommonModule, ENV } from '@app/common';
import type { AppEnv } from '@app/common';
import { INGEST_QUEUE } from '@lib/contracts';
import { PrismaModule } from '@app/prisma';
import { LlmModule } from '@lib/llm';
import { VectorStoreModule } from '@lib/vector-store';
import { IngestionModule } from './ingestion/ingestion.module';

/** 摄取 Worker 进程：只注册 BullMQ Worker + Prisma + 检索/LLM 依赖，无 HTTP（调研一 §9.2） */
@Module({
  imports: [
    CommonModule,
    PrismaModule,
    LlmModule,
    VectorStoreModule,
    BullModule.forRootAsync({
      useFactory: (env: AppEnv) => ({
        connection: new Redis(env.redisUrl, { maxRetriesPerRequest: null }),
      }),
      inject: [ENV],
    }),
    // registerQueue 必须与 forRoot 同现（v12 coreModuleDefinition 随它引入，BullExplorer 由此注册）
    BullModule.registerQueue({ name: INGEST_QUEUE }),
    IngestionModule,
  ],
})
export class WorkerModule {}

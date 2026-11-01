import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { CommonModule, ENV, ResponseWrapInterceptor, AllExceptionsFilter, TraceMiddleware } from '@app/common';
import type { AppEnv } from '@app/common';
import { PrismaModule } from '@app/prisma';
import { LlmModule } from '@lib/llm';
import { VectorStoreModule } from '@lib/vector-store';
import { INGEST_QUEUE } from '@lib/contracts';
import { AuthModule, JwtAuthGuard, RolesGuard } from './auth';
import { UsersModule } from './users/users.module';
import { DocumentsModule } from './documents/documents.module';
import { QaModule } from './qa/qa.module';
import { MeteringModule } from './metering/metering.module';
import { FeedbackModule } from './feedback/feedback.module';
import { AdminModule } from './admin/admin.module';
import { EvalModule } from './eval/eval.module';
import { QueryLogModule } from './query-logs/query-log.module';
import { WebUiModule } from './web-ui/web-ui.module';

@Module({
  imports: [
    CommonModule,
    PrismaModule,
    LlmModule,
    VectorStoreModule,
    QueryLogModule,
    BullModule.forRootAsync({
      useFactory: (env: AppEnv) => ({ connection: new Redis(env.redisUrl, { maxRetriesPerRequest: null }) }),
      inject: [ENV],
    }),
    BullModule.registerQueue({ name: INGEST_QUEUE }),
    AuthModule,
    UsersModule,
    DocumentsModule,
    QaModule,
    MeteringModule,
    FeedbackModule,
    AdminModule,
    EvalModule,
    WebUiModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard }, // 全局 JWT：@Public 白名单外一律鉴权（30 篇）
    { provide: APP_GUARD, useClass: RolesGuard }, // 管理端 /admin/* 与 @Roles 元数据（31 篇）
    { provide: APP_INTERCEPTOR, useClass: ResponseWrapInterceptor }, // 统一 { code, data, requestId }（74 篇）
    { provide: APP_FILTER, useClass: AllExceptionsFilter }, // 统一异常出口
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}

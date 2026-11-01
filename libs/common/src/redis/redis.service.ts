import { Global, Module, OnApplicationShutdown, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/env';
import type { AppEnv } from '../config/env';

export const REDIS = Symbol('REDIS');

/** 与 BullMQ 共用 Redis 实例（计划书 5.1：限流计数、配额预扣 TTL 键） */
@Injectable()
export class RedisService extends Redis implements OnApplicationShutdown {
  constructor(env: AppEnv) {
    super(env.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
  }

  onApplicationShutdown(): void {
    this.quit().catch(() => this.disconnect());
  }
}

@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: (env: AppEnv) => new RedisService(env), inject: [ENV] },
    { provide: RedisService, useExisting: REDIS },
  ],
  exports: [REDIS, RedisService],
})
export class RedisModule {}

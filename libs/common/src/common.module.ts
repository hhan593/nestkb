import { Global, Module } from '@nestjs/common';
import { EnvModule } from './config/env.module';
import { RedisModule } from './redis/redis.service';
import { TraceService, TraceMiddleware } from './trace/trace';
import { AppLogger } from './logging/logger';

@Global()
@Module({
  imports: [EnvModule, RedisModule],
  providers: [TraceService, AppLogger, TraceMiddleware],
  exports: [TraceService, AppLogger, TraceMiddleware, EnvModule, RedisModule],
})
export class CommonModule {}

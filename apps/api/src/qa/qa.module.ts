import { Module } from '@nestjs/common';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { QaRateLimitGuard } from './qa-rate-limit.guard';
import { SemanticCacheService } from './semantic-cache.service';

@Module({
  controllers: [QaController],
  providers: [QaService, QaRateLimitGuard, SemanticCacheService],
})
export class QaModule {}

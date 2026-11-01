import { Module } from '@nestjs/common';
import { CommonModule } from '../../libs/common/src/common.module';
import { PrismaModule } from '../../libs/prisma/src';
import { LlmModule } from '../../libs/llm/src';
import { VectorStoreModule } from '../../libs/vector-store/src';
import { EvalService } from '../../apps/api/src/eval/eval.service';
import { QueryLogModule } from '../../apps/api/src/query-logs/query-log.module';

/** eval CLI 专用组合模块：EvalService + 全局依赖（无 HTTP） */
@Module({
  imports: [CommonModule, PrismaModule, LlmModule, VectorStoreModule, QueryLogModule],
  providers: [EvalService],
})
export class EvaluationModule {}

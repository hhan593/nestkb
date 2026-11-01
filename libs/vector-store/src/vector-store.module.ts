import { Global, Module } from '@nestjs/common';
import { VectorStoreService } from './vector-store.service';
import { HybridRetrievalService } from './hybrid-retrieval.service';

/** 检索层：pgvector 实现 + 权限过滤 + 混合检索。方案 B 时替换 VectorStoreService 实现即可 */
@Global()
@Module({
  providers: [VectorStoreService, HybridRetrievalService],
  exports: [VectorStoreService, HybridRetrievalService],
})
export class VectorStoreModule {}

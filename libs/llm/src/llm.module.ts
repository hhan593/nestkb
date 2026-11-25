import { Global, Module } from '@nestjs/common';
import { AppEnv, ENV } from '@app/common';
import { PriceTable } from './price-table';
import { CHAT_PROVIDER, EMBEDDING_PROVIDER, PRICE_TABLE, RERANK_PROVIDER } from './tokens';
import { LlmChatService } from './chat.service';
import { EmbeddingService } from './embedding.service';
import { RerankService } from './rerank.service';
import {
  OpenAICompatChatProvider,
  OpenAICompatEmbeddingProvider,
  OpenAICompatRerankProvider,
} from './providers/openai-compat';
import { MockChatProvider, MockEmbeddingProvider, MockRerankProvider } from './providers/mock';
import type { LlmChatProvider, LlmEmbeddingProvider, RerankProvider } from './provider-types';

/** LlmModule 门面（ai-agent/01）：chat / embedding / rerank 三通路，provider 全配置化 */
@Global()
@Module({
  providers: [
    { provide: PRICE_TABLE, useFactory: (env: AppEnv) => new PriceTable(env.priceTable), inject: [ENV] },
    {
      provide: CHAT_PROVIDER,
      useFactory: (env: AppEnv): LlmChatProvider =>
        env.chat.provider === 'mock' ? new MockChatProvider(env) : new OpenAICompatChatProvider(env.chat),
      inject: [ENV],
    },
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (env: AppEnv): LlmEmbeddingProvider =>
        env.embedding.provider === 'mock'
          ? new MockEmbeddingProvider(env)
          : new OpenAICompatEmbeddingProvider(env.embedding, env.embedding.dim, {
              sendDimensions: env.embedding.sendDimensions,
            }),
      inject: [ENV],
    },
    {
      provide: RERANK_PROVIDER,
      useFactory: (env: AppEnv): RerankProvider =>
        env.rerank.provider === 'mock' ? new MockRerankProvider(env) : new OpenAICompatRerankProvider(env.rerank),
      inject: [ENV],
    },
    LlmChatService,
    EmbeddingService,
    RerankService,
  ],
  exports: [LlmChatService, EmbeddingService, RerankService, PRICE_TABLE],
})
export class LlmModule {}

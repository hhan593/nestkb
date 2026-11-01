import { Inject, Injectable } from '@nestjs/common';
import { ChatMessage, ChatStreamResult, TokenUsage } from '@lib/contracts';
import { AppEnv, ENV } from '@app/common';
import { PriceTable } from './price-table';
import { CHAT_PROVIDER, PRICE_TABLE } from './tokens';
import type { LlmChatProvider } from './provider-types';

export interface ChatCallOptions {
  requestId: string;
  scene: 'qa' | 'ingest_embed' | 'rerank' | 'eval' | 'summary';
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

/** chat 通路门面：业务代码不直连 SDK（计划书 4.3 对照表：所有 LLM 调用收口 LlmModule） */
@Injectable()
export class LlmChatService {
  constructor(
    @Inject(CHAT_PROVIDER) private readonly provider: LlmChatProvider,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(PRICE_TABLE) private readonly prices: PriceTable,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  get providerName(): string {
    return this.env.chat.provider;
  }

  chatStream(messages: ChatMessage[], opts: ChatCallOptions): Promise<ChatStreamResult> {
    return this.provider.chatStream(messages, { signal: opts.signal, onDelta: opts.onDelta });
  }

  /** 非流式便捷调用（摘要/judge/评估） */
  async chat(messages: ChatMessage[], opts: ChatCallOptions): Promise<ChatStreamResult> {
    return this.provider.chatStream(messages, { signal: opts.signal });
  }

  estimateCost(usage: TokenUsage): number {
    return this.prices.compute(this.provider.model, usage);
  }
}

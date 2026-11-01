import type { ChatMessage, ChatStreamResult } from '@lib/contracts';

/** chat 通路接口：门面之下可替换 provider（openai-compat / mock / ollama…） */
export interface LlmChatProvider {
  readonly model: string;
  chatStream(
    messages: ChatMessage[],
    opts: { signal?: AbortSignal; onDelta?: (text: string) => void },
  ): Promise<ChatStreamResult>;
}

/** embedding 通路接口：写代码只认路由名不认模型名 */
export interface LlmEmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** rerank 通路接口：兼容 /rerank 端点（Cohere/Jina 风格结果结构） */
export interface RerankProvider {
  readonly model: string;
  rerank(query: string, documents: string[], topN: number, signal?: AbortSignal): Promise<Array<{ index: number; score: number }>>;
}

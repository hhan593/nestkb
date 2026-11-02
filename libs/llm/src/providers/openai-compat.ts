import type { ChatMessage, ChatStreamResult, TokenUsage } from '@lib/contracts';
import type { ProviderConfig } from '@app/common';
import type { LlmChatProvider, LlmEmbeddingProvider, RerankProvider } from '../provider-types';

export class LlmUpstreamError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = 'LlmUpstreamError';
  }
}

/** 统一估算口径：中文 ~1.6 字符/token（护栏用途，计费以 API usage 为准） */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 1.6);
}

function headers(apiKey?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

async function parseError(resp: Response): Promise<LlmUpstreamError> {
  let detail = '';
  try {
    detail = (await resp.text()).slice(0, 300);
  } catch {
    // ignore
  }
  const retryable = resp.status === 429 || resp.status >= 500;
  return new LlmUpstreamError(`upstream ${resp.status}: ${detail}`, retryable, resp.status);
}

/** OpenAI 兼容 /chat/completions（SSE 流式 + usage）。业务代码不直连 SDK，一切经 LlmModule 门面。 */
export class OpenAICompatChatProvider implements LlmChatProvider {
  constructor(
    private readonly cfg: ProviderConfig & { temperature: number; idleTimeoutMs?: number },
  ) {}

  get model(): string {
    return this.cfg.model;
  }

  async chatStream(messages: ChatMessage[], opts: { signal?: AbortSignal; onDelta?: (t: string) => void }): Promise<ChatStreamResult> {
    const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
    // 外部 signal（客户端断开）+ 流间空闲超时合成一个内部 signal：上游挂起时不能让请求永不结束
    const idleMs = this.cfg.idleTimeoutMs ?? 120_000;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleMs);
    };

    try {
      const resp = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(this.cfg.apiKey),
        signal: controller.signal,
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          temperature: this.cfg.temperature,
          stream: true,
          stream_options: { include_usage: true },
        }),
      }).catch((err: Error) => {
        throw new LlmUpstreamError(`connect failed: ${err.message}`, /ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message));
      });
      if (!resp.ok) throw await parseError(resp);
      if (!resp.body) throw new LlmUpstreamError('empty response body', false);

      let content = '';
      let usage: TokenUsage | undefined;
      const consumeLine = (line: string): void => {
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let json: {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: TokenUsage;
        };
        try {
          json = JSON.parse(payload);
        } catch {
          return; // 跳过残缺行
        }
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          opts.onDelta?.(delta);
        }
        if (json.usage) usage = json.usage;
      };

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      armIdle();
      for (;;) {
        const { done, value } = await reader.read();
        armIdle(); // 每收到一段数据重置空闲计时
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          consumeLine(line);
        }
      }
      // 终结 flush：残余 buffer（末行无换行 / [DONE] / usage 帧）不丢弃
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer.trim());
      // 未返回 usage 的 provider：按字符估算兜底（计费口径仍优于丢失）
      usage ??= { prompt_tokens: estimateTokens(inputChars), completion_tokens: estimateTokens(content.length) };
      return { content, usage };
    } catch (err) {
      if (opts.signal?.aborted) throw err; // 客户端断开：原样上抛
      if (controller.signal.aborted && !controller.signal.reason) {
        throw new LlmUpstreamError(`chat stream idle > ${idleMs}ms`, true);
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** OpenAI 兼容 /embeddings，批量化 */
export class OpenAICompatEmbeddingProvider implements LlmEmbeddingProvider {
  constructor(
    private readonly cfg: ProviderConfig,
    readonly dim: number,
  ) {}

  get model(): string {
    return this.cfg.model;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const resp = await fetch(`${this.cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: headers(this.cfg.apiKey),
      signal,
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
    }).catch((err: Error) => {
      throw new LlmUpstreamError(`connect failed: ${err.message}`, /ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message));
    });
    if (!resp.ok) throw await parseError(resp);
    const json = (await resp.json()) as { data: Array<{ embedding: number[]; index: number }> };
    const out: number[][] = new Array(texts.length);
    for (const d of json.data) out[d.index] = d.embedding;
    // 维度错了入库就是废数据 —— 即刻失败
    const bad = out.find((e) => e?.length !== this.dim);
    if (bad) throw new LlmUpstreamError(`embedding dim mismatch: got ${bad?.length}, expect ${this.dim}`, false);
    return out;
  }
}

/** 兼容 /rerank 端点（Cohere/Jina 风格结果结构） */
export class OpenAICompatRerankProvider implements RerankProvider {
  constructor(private readonly cfg: ProviderConfig) {}

  get model(): string {
    return this.cfg.model;
  }

  async rerank(query: string, documents: string[], topN: number, signal?: AbortSignal): Promise<Array<{ index: number; score: number }>> {
    const resp = await fetch(`${this.cfg.baseUrl}/rerank`, {
      method: 'POST',
      headers: headers(this.cfg.apiKey),
      signal,
      body: JSON.stringify({ model: this.cfg.model, query, documents, top_n: topN }),
    }).catch((err: Error) => {
      throw new LlmUpstreamError(`connect failed: ${err.message}`, /ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message));
    });
    if (!resp.ok) throw await parseError(resp);
    const json = (await resp.json()) as { results: Array<{ index: number; relevance_score: number }> };
    return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  }
}

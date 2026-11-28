import type { ChatMessage, ChatStreamResult, TokenUsage } from '@lib/contracts';
import type { AppEnv } from '@app/common';
import { estimateTokens, LlmUpstreamError } from './openai-compat';
import type { LlmChatProvider, LlmEmbeddingProvider, RerankProvider } from '../provider-types';

/**
 * mock provider：零外部依赖跑通全链路（开发/测试/演示用）。
 * - embedding：字符 bigram 哈希成桶 + 归一化 → 同话题文本（共享用字）有相似度，纯异题近正交；
 * - chat：从【参考资料】块合成带 [n] 引用的回答；摘要/judge 类提示词走确定性行为；
 * - rerank：query 与文档的 bigram 覆盖率。
 * 切真实模型：.env 中 LLM_*_PROVIDER 改 openai-compat 即可，业务代码零改动。
 */

// ---------- FNV-1a ----------
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function bigrams(text: string): string[] {
  const t = text.replace(/\s+/g, '');
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) out.push(t.slice(i, i + 2));
  return out.length ? out : (t ? [t] : []);
}

function coverage(query: string, doc: string): number {
  const qGrams = new Set(bigrams(query));
  if (!qGrams.size) return 0;
  const dGrams = new Set(bigrams(doc));
  let hit = 0;
  for (const g of qGrams) if (dGrams.has(g)) hit++;
  return hit / qGrams.size;
}

export class MockEmbeddingProvider implements LlmEmbeddingProvider {
  constructor(
    private readonly env: AppEnv,
    readonly dim: number = env.embedding.dim,
  ) {}

  get model(): string {
    return this.env.embedding.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const v = new Float64Array(this.dim);
    // unigram + bigram 双特征：短查询不塌缩
    const chars = text.replace(/\s+/g, '');
    for (let i = 0; i < chars.length; i++) {
      const h = fnv1a(chars[i]);
      v[h % this.dim] += 1;
      if (i + 1 < chars.length) {
        const hb = fnv1a(chars.slice(i, i + 2));
        v[hb % this.dim] += 1.5;
      }
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    return Array.from(v, (x) => x / norm);
  }
}

interface MaterialBlock {
  no: number;
  title: string;
  body: string;
}

function parseMaterials(userContent: string): MaterialBlock[] {
  if (!userContent.includes('【参考资料】')) return [];
  // material 以 \n 开头（buildRagPrompt 的模板换行）—— trim 后首块才能被 ^[n] 匹配，
  // 否则第一块永远解析失败（表现为单块检索时 mock 拒答、citations 恒空）
  const material = (userContent.split('【参考资料】')[1]?.split('【问题】')[0] ?? '').trim();
  const blocks = material.split(/\n\n---\n\n/);
  const out: MaterialBlock[] = [];
  for (const b of blocks) {
    const m = b.match(/^\[(\d+)\]\s*来源：《(.+?)》/);
    if (!m) continue;
    const body = b
      .split('\n')
      .slice(1)
      .join('')
      .trim();
    out.push({ no: Number(m[1]), title: m[2], body });
  }
  return out;
}

export class MockChatProvider implements LlmChatProvider {
  constructor(private readonly env: AppEnv) {}

  get model(): string {
    return this.env.chat.model;
  }

  async chatStream(
    messages: ChatMessage[],
    opts: { signal?: AbortSignal; onDelta?: (t: string) => void },
  ): Promise<ChatStreamResult> {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    let answer: string;

    if (system.includes('原子论断')) {
      answer = this.judgeFaithfulness(lastUser);
    } else if (system.includes('答案相关性')) {
      answer = JSON.stringify({ score: 4, reason: 'mock judge：与问题主题相关' });
    } else {
      answer = this.answerFromMaterials(lastUser, messages);
    }

    const promptTokens = estimateTokens(messages.reduce((s, m) => s + m.content.length, 0));

    // 模拟流式：按小片下发（MOCK_STREAM_DELAY_MS 运行时覆盖 —— E2E 中途断开用例的窗口）
    const chunkSize = 12;
    const delay = Number(process.env.MOCK_STREAM_DELAY_MS ?? this.env.mockStreamDelayMs);
    for (let i = 0; i < answer.length; i += chunkSize) {
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      opts.onDelta?.(answer.slice(i, i + chunkSize));
      if (delay > 0) await sleep(delay);
    }
    return {
      content: answer,
      usage: { prompt_tokens: promptTokens, completion_tokens: estimateTokens(answer.length) },
    };
  }

  private answerFromMaterials(userContent: string, messages: ChatMessage[]): string {
    const blocks = parseMaterials(userContent);
    if (!blocks.length) {
      if (userContent.includes('摘要')) {
        const history = messages
          .filter((m) => m.role !== 'system')
          .map((m) => m.content.slice(0, 40))
          .join('；');
        return `对话摘要：${history.slice(0, 180)}`;
      }
      return '根据现有资料无法回答。';
    }
    const question = userContent.split('【问题】')[1]?.trim() ?? '';
    // 按与问题的词汇覆盖率排序（模拟真实 LLM 只引用最相关的资料块）
    const ranked = [...blocks].sort((a, b) => coverage(question, b.body) - coverage(question, a.body));
    const picked = ranked.filter((b) => coverage(question, b.body) > 0).slice(0, 3);
    const chosen = picked.length ? picked : blocks.slice(0, 1);
    const lines = chosen.map((b) => {
      const snippet = b.body.replace(/\s+/g, '').slice(0, 80);
      return `根据《${b.title}》：${snippet}…[${b.no}]`;
    });
    return `根据知识库中的资料：\n${lines.join('\n')}\n以上为资料中可直接依据的内容。`;
  }

  /** mock 忠实度裁判：论断中的 2-gram 大部分出现在资料里 → supported（确定性、可复现） */
  private judgeFaithfulness(userContent: string): string {
    const materialIdx = userContent.indexOf('【资料】');
    const answerIdx = userContent.indexOf('【回答】');
    const material = materialIdx >= 0 ? userContent.slice(materialIdx, answerIdx > materialIdx ? answerIdx : undefined) : '';
    const answer = answerIdx >= 0 ? userContent.slice(answerIdx + 4) : userContent;
    const sentences = answer.split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length >= 6);
    const claims = sentences.slice(0, 8).map((s) => {
      // 剥离引语包装（根据《x》：、[n]）再判覆盖，避免展示层措辞拉低忠实度
      const cleaned = s.replace(/根据|《[^》]*》|\[\d+\]|以上为资料中可直接依据的内容/g, '');
      const supported = coverage(cleaned, material) >= 0.3;
      return { claim: s.slice(0, 60), supported };
    });
    if (!claims.length) claims.push({ claim: answer.slice(0, 60), supported: false });
    return JSON.stringify({ claims });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MockRerankProvider implements RerankProvider {
  constructor(private readonly env: AppEnv) {}

  get model(): string {
    return this.env.rerank.model;
  }

  async rerank(query: string, documents: string[], topN: number): Promise<Array<{ index: number; score: number }>> {
    void this.env;
    if (query.length === 0) throw new LlmUpstreamError('mock rerank: empty query', false);
    return documents
      .map((d, index) => ({ index, score: Number(coverage(query, d).toFixed(4)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }
}

import { TokenUsage } from '@lib/contracts';
import type { PriceEntry } from '@app/common';

/** cached prompt tokens 按 5 折计费（与主流 provider 的 cache 折扣同数量级，可按需调整） */
export const CACHED_TOKEN_DISCOUNT = 0.5;

/**
 * 价格表（PRICE_JSON，元/百万 token；rerank 可按 per_call 元/次计价）。
 * usage 折算、成本看板、预算闸唯一依据 —— 改模型不改价格表 = 看板失真。
 */
export class PriceTable {
  constructor(private readonly table: Record<string, PriceEntry>) {}

  /** 返回元（保留 6 位小数） */
  compute(model: string, usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number }): number {
    const entry = this.table[model] ?? {};
    const cached = usage.cached_tokens ?? 0;
    const billablePrompt = Math.max(0, usage.prompt_tokens - cached);
    const cost =
      ((entry.input ?? 0) * (billablePrompt + cached * CACHED_TOKEN_DISCOUNT)) / 1e6 +
      ((entry.output ?? 0) * usage.completion_tokens) / 1e6;
    return Number(cost.toFixed(6));
  }

  perCall(model: string): number {
    return this.table[model]?.per_call ?? 0;
  }
}

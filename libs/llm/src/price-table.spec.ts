import { describe, expect, it } from 'vitest';
import { CACHED_TOKEN_DISCOUNT, PriceTable } from './price-table';

describe('PriceTable（usage 折算，元/百万 token）', () => {
  const table = new PriceTable({
    'chat-model': { input: 2, output: 8 },
    'embed-model': { input: 0.5 },
  });

  it('input+output 基本折算', () => {
    const cost = table.compute('chat-model', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(10, 6);
  });

  it('cached tokens 按 5 折计费', () => {
    const noCache = table.compute('chat-model', { prompt_tokens: 100_000, completion_tokens: 0 });
    const withCache = table.compute('chat-model', {
      prompt_tokens: 100_000,
      completion_tokens: 0,
      cached_tokens: 50_000,
    });
    const expected = (2 * (50_000 + 50_000 * CACHED_TOKEN_DISCOUNT)) / 1e6;
    expect(withCache).toBeCloseTo(expected, 6);
    expect(withCache).toBeLessThan(noCache);
  });

  it('未登记模型成本为 0（新模型必须回填价格表）', () => {
    expect(table.compute('unknown-model', { prompt_tokens: 1000, completion_tokens: 1000 })).toBe(0);
  });

  it('per_call 计价（rerank 按次）', () => {
    const t = new PriceTable({ 'my-reranker': { per_call: 0.001 } });
    expect(t.perCall('my-reranker')).toBe(0.001);
    expect(t.perCall('missing')).toBe(0);
  });
});

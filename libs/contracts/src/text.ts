/**
 * token 估算的唯一口径。
 *
 * 中文约 1.6 字符/token，所有护栏（预扣、截断、成本估算）必须用同一个系数 ——
 * 否则同一段文本在不同环节算出不同 token 数，配额与截断行为会互相打架（#33）。
 * 计费以 provider 返回的 usage 为准，这里只用于"先估一个量级"。
 */
export const CHARS_PER_TOKEN = 1.6;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

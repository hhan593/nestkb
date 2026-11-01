/** eval judge 提示词（计划书 8.9）：judge 与被评模型分离 */

export const FAITHFULNESS_SYSTEM = `你是严格的忠实度裁判。给定【资料】与【回答】，把回答拆成原子论断，逐条判断是否被资料支持。
只输出 JSON：{"claims":[{"claim":"论断","supported":true|false}]}。不要输出其他内容。`;

export function faithfulnessUserPrompt(answer: string, materials: string[]): string {
  return `【资料】\n${materials.join('\n---\n')}\n\n【回答】\n${answer}\n\n请输出 JSON。`;
}

export const RELEVANCE_SYSTEM = `你是答案相关性裁判。对【回答】与【问题】的相关程度打 1~5 分。
只输出 JSON：{"score":4,"reason":"一句话理由"}。不要输出其他内容。`;

export function relevanceUserPrompt(question: string, answer: string): string {
  return `【问题】${question}\n\n【回答】\n${answer}\n\n请输出 JSON。`;
}

/** 从模型输出中稳健提取 JSON（容忍 markdown 代码块包裹） */
export function extractJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

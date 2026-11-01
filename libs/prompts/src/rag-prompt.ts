import type { ChatMessage, RetrievedChunk } from '@lib/contracts';

export const RAG_SYSTEM_PROMPT = `你是企业知识库问答助手。严格遵守：
1. 只依据【参考资料】回答，禁止使用资料之外的任何知识，即使你"知道"答案；
2. 每个关键论断后标注来源编号，格式如 [1][2]，编号只能取自资料编号；
3. 资料不足以回答时，明确说"根据现有资料无法回答"并说明缺什么；不编造资料中不存在的数字/日期/条款编号；
4. 资料冲突时引用生效时间更近的一条并说明冲突。`;

export function fmtDate(iso: string | null): string {
  if (!iso) return '未知';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '未知';
  }
}

/**
 * 上下文块带编号 + 来源元数据（文档/版本/章节/时效）——引用展示层的全部信息从这里来。
 * 历史 > HISTORY_MAX_TURNS 轮由 QaService 先摘要化，此处只接收压缩后的稳定前缀（KV-cache 友好）。
 */
export function buildRagPrompt(
  question: string,
  chunks: RetrievedChunk[],
  history: ChatMessage[] = [],
  summary?: string | null,
): ChatMessage[] {
  const material = chunks
    .map(
      (c, i) =>
        `[${i + 1}] 来源：《${c.title}》 v${c.versionNo} · ${c.headingPath || '（无章节）'} · 生效于 ${fmtDate(c.effectiveAt)}\n${c.content}`,
    )
    .join('\n\n---\n\n');
  const msgs: ChatMessage[] = [{ role: 'system', content: RAG_SYSTEM_PROMPT }];
  if (summary) {
    msgs.push({ role: 'system', content: `此前对话摘要（仅供理解上下文；回答依据仍只能是下方资料）：\n${summary}` });
  }
  msgs.push(...history);
  msgs.push({ role: 'user', content: `【参考资料】\n${material}\n\n【问题】${question}` });
  return msgs;
}

/** 无依据时的降级路径：不调 LLM，零生成成本（计划书 8.2 召回为空分支） */
export const NO_EVIDENCE_ANSWER = '根据现有资料无法回答：知识库中没有检索到与该问题相关的依据。';

export const PERMISSION_FILTERED_ANSWER =
  '知识库中存在可能相关的内容，但您当前没有访问权限。如需查阅，请联系文档归属部门申请授权。';

/** 压缩策略：只保留最近 keepRecent*2 条（摘要文本由调用方生成后经 summary 传入稳定前缀） */
export function compressHistory(history: ChatMessage[], keepRecent: number): ChatMessage[] {
  const keep = Math.max(1, keepRecent) * 2;
  return history.length > keep ? history.slice(-keep) : history;
}

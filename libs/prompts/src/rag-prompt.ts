import type { ChatMessage, RetrievedChunk } from '@lib/contracts';

export const RAG_SYSTEM_PROMPT = `你是企业知识库问答助手。严格遵守：
1. 只依据【参考资料】回答，禁止使用资料之外的任何知识，即使你"知道"答案；
2. 每个关键论断后标注来源编号，格式如 [1][2]，编号只能取自资料编号；
3. 资料不足以回答时，明确说"根据现有资料无法回答"并说明缺什么；资料内容与问题无关时，同样视为资料不足，不得强行作答；不编造资料中不存在的数字/日期/条款编号；
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
 * 历史末条可能已是本轮问题：QaService 先落库 user 消息、再读历史，于是本轮问题会连同资料一起重复一次。
 * 同一句问题进两次 prompt 既多算 token，也容易出现连续两条 user 消息这种不合规结构（#28）。
 */
function withoutTrailingEcho(history: ChatMessage[], question: string): ChatMessage[] {
  const last = history[history.length - 1];
  return last && last.role === 'user' && last.content === question ? history.slice(0, -1) : history;
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
  // 本轮问题的最终载体是下面带【参考资料】的那条，历史里的回声先去掉
  msgs.push(...withoutTrailingEcho(history, question));
  msgs.push({ role: 'user', content: `【参考资料】\n${material}\n\n【问题】${question}` });
  return msgs;
}

/** 无依据时的降级路径：不调 LLM，零生成成本（计划书 8.2 召回为空分支） */
export const NO_EVIDENCE_ANSWER = '根据现有资料无法回答：知识库中没有检索到与该问题相关的依据。';

export const PERMISSION_FILTERED_ANSWER =
  '知识库中存在可能相关的内容，但您当前没有访问权限。如需查阅，请联系文档归属部门申请授权。';

/**
 * 空召回的第二档兜底：当前账号全程看不到任何文档切片（还没上传 / 全被部门墙挡住 / 都已过期）。
 * 与 NO_EVIDENCE_ANSWER 区分开，避免把「库里对你就没东西」说成「这个问题没依据」（#24）。
 */
export const NO_VISIBLE_DOCS_ANSWER =
  '知识库中暂时没有您可以访问的文档，因此无法回答该问题。请联系管理员上传资料或为您所在的部门授权。';

/** 纯对话模式系统提示：不挂靠知识库，明确告知用户此处回答无出处 */
export const CHAT_SYSTEM_PROMPT = `你是 NestKB 的通用 AI 助手，当前处于「自由对话」模式：本轮回答不检索企业知识库，也不提供引用编号。请遵循：
1. 用你自己的知识直接回答，不要声称引用了内部资料，不要编造文档名、编号或出处；
2. 涉及企业制度、流程、条款等内部信息时，提醒用户切到「知识库问答」模式以获得带出处的答案；
3. 不确定的内容直接说明不确定，不臆测具体数字、日期与条款。`;

/**
 * 纯对话 prompt：仅 system + 历史 + 当前问题。
 * history 里可能已含本轮问题（QaService 先落库 user 消息再读历史），重复时不再追加。
 */
export function buildChatPrompt(
  question: string,
  history: ChatMessage[] = [],
  summary?: string | null,
): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }];
  if (summary) msgs.push({ role: 'system', content: `此前对话摘要：\n${summary}` });
  msgs.push(...withoutTrailingEcho(history, question));
  msgs.push({ role: 'user', content: question });
  return msgs;
}

/** 压缩策略：只保留最近 keepRecent*2 条（摘要文本由调用方生成后经 summary 传入稳定前缀） */
export function compressHistory(history: ChatMessage[], keepRecent: number): ChatMessage[] {
  const keep = Math.max(1, keepRecent) * 2;
  return history.length > keep ? history.slice(-keep) : history;
}

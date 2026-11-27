import { describe, expect, it } from 'vitest';
import { buildChatPrompt, buildRagPrompt, compressHistory, NO_EVIDENCE_ANSWER } from './rag-prompt';
import type { RetrievedChunk } from '@lib/contracts';

const chunks: RetrievedChunk[] = [
  {
    chunkId: 'c-1',
    documentId: 'd-1',
    versionId: 'v-1',
    versionNo: 3,
    title: '员工手册',
    headingPath: '第五章 考核 > 5.4 试用期考核',
    content: '试用期考核不通过的，延长试用或依法解除劳动合同。',
    effectiveAt: '2026-03-01T00:00:00Z',
    expiresAt: null,
    score: 0.8,
  },
];

describe('buildRagPrompt（上下文工程，计划书 8.7）', () => {
  it('资料块带编号与来源元数据（引用展示层信息源头）', () => {
    const msgs = buildRagPrompt('试用期考核不通过怎么办？', chunks);
    const user = msgs[msgs.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toContain('[1] 来源：《员工手册》 v3');
    expect(user.content).toContain('第五章 考核 > 5.4 试用期考核');
    expect(user.content).toContain('生效于 2026-03-01');
    expect(user.content).toContain('【问题】试用期考核不通过怎么办？');
  });

  it('system 提示词要求引用编号与拒答约束', () => {
    const msgs = buildRagPrompt('q', chunks);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('标注来源编号');
    expect(msgs[0].content).toContain('根据现有资料无法回答');
  });

  it('有摘要时插入稳定前缀（KV-cache 友好）', () => {
    const msgs = buildRagPrompt('q', chunks, [], '此前讨论过年假。');
    expect(msgs[1].content).toContain('此前对话摘要');
  });

  it('compressHistory 只保留最近 keepRecent*2 条', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }));
    expect(compressHistory(history, 4)).toHaveLength(8);
    expect(compressHistory(history, 4)[0].content).toBe('m12');
  });

  it('无依据答案文案可直接下发', () => {
    expect(NO_EVIDENCE_ANSWER).toContain('无法回答');
  });
});

describe('本轮问题只进 prompt 一次（#28）', () => {
  const echo = [{ role: 'user' as const, content: 'X' }];

  it('history 末条已是本轮问题时不重复拼接', () => {
    const msgs = buildRagPrompt('X', chunks, echo);
    const users = msgs.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toContain('【参考资料】');
    expect(users[0].content).toContain('【问题】X');
  });

  it('出现连续两条 user 消息即视为回归（模型侧不合规结构）', () => {
    const msgs = buildRagPrompt('X', chunks, echo);
    for (let i = 1; i < msgs.length; i++) {
      expect(`${msgs[i - 1].role}->${msgs[i].role}`).not.toBe('user->user');
    }
  });

  it('真正的前序轮次仍保留（只去掉末尾回声）', () => {
    const history = [
      { role: 'user' as const, content: '上一问' },
      { role: 'assistant' as const, content: '上一答' },
      { role: 'user' as const, content: 'X' },
    ];
    const msgs = buildRagPrompt('X', chunks, history);
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(msgs.map((m) => m.content).join('\n')).toContain('上一答');
  });

  it('纯对话模式同样不重复', () => {
    const msgs = buildChatPrompt('X', echo);
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(msgs[msgs.length - 1].content).toBe('X');
  });
});

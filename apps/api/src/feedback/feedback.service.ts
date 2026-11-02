import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCodes } from '@lib/contracts';
import { PrismaService } from '@app/prisma';
import type { AuthedUser } from '../auth/auth.service';

const ALLOWED_REASONS = new Set(['wrong', 'no_citation', 'outdated', 'not_found', 'other']);

export interface FeedbackInput {
  rating: 'up' | 'down';
  reasons: string[];
  comment?: string;
}

/** 反馈采集（计划书 P0-7）：点踩回流评测集候选池，形成反馈→评估→迭代闭环 */
@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthedUser, messageId: string, input: FeedbackInput): Promise<{ feedbackId: string; queuedForEval: boolean }> {
    for (const r of input.reasons) {
      if (!ALLOWED_REASONS.has(r)) {
        throw new ForbiddenException({ code: ErrorCodes.VALIDATION_FAILED, message: `原因标签不合法：${r}` });
      }
    }
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message) throw new NotFoundException('消息不存在');
    const conv = await this.prisma.conversation.findUnique({ where: { id: message.conversationId } });
    if (conv?.userId !== user.userId) throw new ForbiddenException('只能反馈自己的会话消息');

    // (messageId, userId) 唯一约束 + upsert：同一用户对同一消息重复反馈按更新处理，不再无限刷
    const feedback = await this.prisma.feedback.upsert({
      where: { messageId_userId: { messageId, userId: user.userId } },
      create: { messageId, userId: user.userId, rating: input.rating, reasons: input.reasons, comment: input.comment },
      update: { rating: input.rating, reasons: input.reasons, comment: input.comment },
    });

    let queuedForEval = false;
    if (input.rating === 'down') {
      // 点踩 case 回流评测集候选池（source=feedback）：question 取该回答对应的提问；按问题去重防污染评测集
      const userMsg = await this.prisma.message.findFirst({
        where: { conversationId: message.conversationId, role: 'user', createdAt: { lt: message.createdAt } },
        orderBy: { createdAt: 'desc' },
      });
      if (userMsg) {
        const dup = await this.prisma.evalCase.findFirst({
          where: { question: userMsg.content, source: 'feedback' },
          select: { id: true },
        });
        if (!dup) {
          await this.prisma.evalCase.create({
            data: {
              question: userMsg.content,
              caseType: mapCaseType(input.reasons),
              goldAnswer: null,
              goldChunkIds: [],
              goldMarkers: [],
              source: 'feedback',
              expectDeny: input.reasons.includes('not_found'),
            },
          });
          queuedForEval = true;
        }
      }
    }
    return { feedbackId: feedback.id, queuedForEval };
  }
}

function mapCaseType(reasons: string[]): 'fact' | 'timeliness' | 'deny' {
  if (reasons.includes('outdated')) return 'timeliness';
  if (reasons.includes('not_found')) return 'deny';
  return 'fact';
}

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FAITHFULNESS_SYSTEM,
  RELEVANCE_SYSTEM,
  buildRagPrompt,
  extractJson,
  faithfulnessUserPrompt,
  relevanceUserPrompt,
  validateCitations,
} from '@lib/prompts';
import { AccessScope, HybridRetrievalService, VectorStoreService } from '@lib/vector-store';
import { LlmChatService } from '@lib/llm';
import { AppEnv, ENV } from '@app/common';
import { PrismaService } from '@app/prisma';
import type { AuthedUser } from '../auth/auth.service';

interface GoldRef {
  chunkId: string;
  documentId: string;
}

interface CaseResult {
  caseId: string;
  question: string;
  caseType: string;
  recall5: number | null;
  citationAcc: number | null;
  fidelity: number;
  relevance: number | null;
  expectDeny: boolean;
  denyOk: boolean | null;
  degraded: boolean;
  latencyMs: number;
  costCny: number;
  answerPreview: string;
}

interface JudgeUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * 评估回归（计划书 8.9 / 难点 5）：
 * 指标 1 Recall@5（确定性：gold chunk 或同文档近邻进 top5）
 * 指标 2 引用准确率（确定性：被引编号指向 gold chunk/近邻的比例；幻觉引用计入失败）
 * 指标 3 忠实度（LLM-as-judge：supported 论断 / 全部论断；EVAL_JUDGE_SAMPLES 次采样取均值）
 * 指标 4 答案相关性（judge 1~5 归一化）
 * 结果落 eval_runs —— "效果账本"（§6.3），prompt/模型/检索参数变更必须跑回归。
 */
@Injectable()
export class EvalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: HybridRetrievalService,
    private readonly store: VectorStoreService,
    private readonly llm: LlmChatService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async run(user: AuthedUser, datasetVersion = 'v1', triggeredBy = 'manual') {
    const cases = await this.prisma.evalCase.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });
    if (!cases.length) throw new Error('评测集为空：先运行 pnpm seed 或导入用例');
    const scope: AccessScope = { userId: user.userId, deptId: user.deptId, isAdmin: true };

    // gold 标记短语 → chunk id 解析（每次 run 缓存一次）
    const goldCache = new Map<string, GoldRef[]>();
    const detail: CaseResult[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for (const c of cases) {
      const goldRefs = await this.resolveGold(c.goldMarkers, c.goldChunkIds, goldCache);
      const t0 = Date.now();
      const retrieval = await this.retrieval.retrieve(c.question, scope, { debug: true });
      const top5 = retrieval.chunks.slice(0, 5);

      // ── 指标 1 Recall@5（确定性）：gold chunk（或同文档近邻）是否进 top5
      const recall5 = goldRefs.length
        ? goldRefs.some((g) => top5.some((t) => t.chunkId === g.chunkId || t.documentId === g.documentId))
          ? 1
          : 0
        : null;

      // ── 回答（deny 类：检索为空直接拒答，零生成成本）
      let answer: string;
      if (c.expectDeny && retrieval.chunks.length === 0) {
        answer = '根据现有资料无法回答：知识库中没有检索到与该问题相关的依据。';
      } else {
        // 与生产问答共用同一 prompt 资产（buildRagPrompt）—— 评估口径才与线上一致
        const stream = await this.llm.chat(buildRagPrompt(c.question, retrieval.chunks), {
          requestId: '',
          scene: 'eval',
        });
        answer = stream.content;
        promptTokens += stream.usage.prompt_tokens;
        completionTokens += stream.usage.completion_tokens;
      }

      // ── 指标 2 引用准确率：deny 类用例的正确行为是拒答且无引用 → 记满分；
      //    事实类用例：被引编号指向 gold chunk 或同文档近邻的比例（幻觉引用计入失败）
      const { citations } = validateCitations(answer, retrieval.chunks);
      // 拒答类用例的"引用准确率"无意义（模型在拒绝说明里提及资料范围是正当行为），
      // 正确性已由 denyOk + fidelity 覆盖 → 记 null，不参与均值
      const citAcc = c.expectDeny
        ? null
        : citations.length
          ? citations.filter((x) => isGoldOrNeighbor(x.chunkId, x.documentId, goldRefs)).length / citations.length
          : 0;
      const denyPassed = c.expectDeny ? /无法回答|没有找到|没有(检索到)?(相关)?依据|无访问权限/.test(answer) : null;

      // ── 指标 3 忠实度（LLM-as-judge，N 次采样均值记方差）
      let fidelity = 1;
      if (!c.expectDeny) {
        const judged: number[] = [];
        for (let s = 0; s < this.env.evalJudgeSamples; s++) {
          const j = await this.judgeFaithfulness(answer, retrieval.chunks.map((ch) => ch.content));
          judged.push(j.fidelity);
          promptTokens += j.usage.prompt_tokens;
          completionTokens += j.usage.completion_tokens;
        }
        fidelity = mean(judged);
      }

      // ── 指标 4 答案相关性
      const rel = await this.judgeRelevance(c.question, answer);
      promptTokens += rel.usage.prompt_tokens;
      completionTokens += rel.usage.completion_tokens;

      detail.push({
        caseId: c.id,
        question: c.question,
        caseType: c.caseType,
        recall5,
        citationAcc: citAcc,
        fidelity,
        relevance: rel.score,
        expectDeny: c.expectDeny,
        denyOk: denyPassed,
        degraded: retrieval.degraded,
        latencyMs: Date.now() - t0,
        costCny: this.llm.estimateCost({ prompt_tokens: 0, completion_tokens: 0 }),
        answerPreview: answer.slice(0, 200),
      });
    }
    // 逐条成本：按全 run token 总量折算后均摊（粗口径，成本精确值看 usage_records）
    const totalCost = this.llm.estimateCost({ prompt_tokens: promptTokens, completion_tokens: completionTokens });
    for (const d of detail) d.costCny = Number((totalCost / detail.length).toFixed(6));

    // eval 场景 usage 落库（难点 7：eval 场景意外升高=评估跑批没限流）
    if (promptTokens > 0) {
      await this.prisma.usageRecord.create({
        data: {
          userId: user.userId,
          deptId: user.deptId,
          scene: 'eval',
          provider: `${this.llm.providerName}/${this.llm.model}`,
          promptTokens,
          completionTokens,
          costEstimated: totalCost,
        },
      });
    }

    return this.prisma.evalRun.create({
      data: {
        datasetVersion,
        triggeredBy,
        recallAt5: meanOrNull(detail.map((d) => d.recall5)),
        fidelity: meanOrNull(detail.map((d) => (d.expectDeny ? (d.denyOk ? 1 : 0) : d.fidelity))),
        citationAcc: meanOrNull(detail.map((d) => d.citationAcc)),
        relevance: meanOrNull(detail.map((d) => (d.relevance ?? 0) / 5)),
        avgCost: mean(detail.map((d) => d.costCny)),
        avgLatencyMs: Math.round(mean(detail.map((d) => d.latencyMs))),
        totalCases: detail.length,
        detail: detail as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async resolveGold(markers: string[], goldChunkIds: string[], cache: Map<string, GoldRef[]>): Promise<GoldRef[]> {
    const refs: GoldRef[] = [];
    for (const id of goldChunkIds) {
      const row = await this.prisma.documentChunk.findUnique({ where: { id }, select: { documentId: true } });
      if (row) refs.push({ chunkId: id, documentId: row.documentId });
    }
    for (const marker of markers) {
      let resolved = cache.get(marker);
      if (!resolved) {
        const ids = await this.store.findChunkIdsByMarker(marker);
        resolved = await Promise.all(
          ids.map(async (id) => {
            const row = await this.prisma.documentChunk.findUnique({ where: { id }, select: { documentId: true } });
            return { chunkId: id, documentId: row?.documentId ?? '' };
          }),
        );
        cache.set(marker, resolved);
      }
      refs.push(...resolved);
    }
    return refs;
  }

  private async judgeFaithfulness(answer: string, materials: string[]): Promise<{ fidelity: number; usage: JudgeUsage }> {
    const result = await this.llm.chat(
      [
        { role: 'system', content: FAITHFULNESS_SYSTEM },
        { role: 'user', content: faithfulnessUserPrompt(answer, materials) },
      ],
      { requestId: '', scene: 'eval' },
    );
    const parsed = extractJson<{ claims: Array<{ claim: string; supported: boolean }> }>(result.content);
    const claims = parsed?.claims?.length ? parsed.claims : [{ claim: answer.slice(0, 60), supported: false }];
    const supported = claims.filter((c) => c.supported).length;
    return { fidelity: supported / claims.length, usage: result.usage };
  }

  private async judgeRelevance(question: string, answer: string): Promise<{ score: number; usage: JudgeUsage }> {
    const result = await this.llm.chat(
      [
        { role: 'system', content: RELEVANCE_SYSTEM },
        { role: 'user', content: relevanceUserPrompt(question, answer) },
      ],
      { requestId: '', scene: 'eval' },
    );
    const parsed = extractJson<{ score: number }>(result.content);
    const score = Math.max(1, Math.min(5, Number(parsed?.score ?? 3)));
    return { score, usage: result.usage };
  }
}

/** 引用命中判定：直接命中 gold chunk，或同文档近邻（计划书 11.3 口径） */
function isGoldOrNeighbor(chunkId: string, documentId: string, goldRefs: GoldRef[]): boolean {
  if (goldRefs.some((g) => g.chunkId === chunkId)) return true;
  return goldRefs.some((g) => g.documentId && g.documentId === documentId);
}

function mean(xs: number[]): number {
  return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4)) : 0;
}

function meanOrNull(xs: Array<number | null>): number | null {
  const valid = xs.filter((x): x is number => x !== null);
  return valid.length ? mean(valid) : null;
}

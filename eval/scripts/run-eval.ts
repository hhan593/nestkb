/**
 * 评估跑批入口（计划书 8.9）：pnpm eval 或 CI 调用。
 * 以 NestApplicationContext 启动（无 HTTP），与 POST /admin/eval/runs 走同一 EvalService。
 * 环境变量：EVAL_TRIGGER=manual|ci|prompt_change|model_change，EVAL_DATASET_VERSION=v1
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadDotenvFile } from '../../libs/common/src/config/env';
import { EvaluationModule } from './evaluation.module';
import { EvalService } from '../../apps/api/src/eval/eval.service';
import { PrismaService } from '../../libs/prisma/src';

loadDotenvFile();

function dec(v: unknown): number | null {
  return v && typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : (v as number);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(EvaluationModule, { logger: ['warn', 'error'] });
  await app.init();

  const prisma = app.get(PrismaService);
  const admin = await prisma.user.findUnique({ where: { email: 'admin@nestkb.local' } });
  if (!admin) throw new Error('找不到 admin@nestkb.local，先运行 pnpm seed');

  const evalService = app.get(EvalService);
  const datasetVersion = process.env.EVAL_DATASET_VERSION ?? 'v1';
  const triggeredBy = process.env.EVAL_TRIGGER ?? 'manual';
  console.log(`eval 开始：dataset=${datasetVersion} trigger=${triggeredBy}`);

  const run = await evalService.run(
    { userId: admin.id, email: admin.email, role: 'admin', deptId: admin.departmentId },
    datasetVersion,
    triggeredBy,
  );
  console.log('eval 完成：');
  console.log(`  Recall@5     = ${dec(run.recallAt5)}（基线 ≥0.85）`);
  console.log(`  忠实度       = ${dec(run.fidelity)}（基线 ≥0.80）`);
  console.log(`  引用准确率   = ${dec(run.citationAcc)}（基线 ≥0.90）`);
  console.log(`  答案相关性   = ${dec(run.relevance)}（基线 ≥0.75）`);
  console.log(`  平均成本(元) = ${dec(run.avgCost)}`);
  console.log(`  平均延迟(ms) = ${run.avgLatencyMs}`);
  console.log(`  用例数       = ${run.totalCases}`);
  console.log(`  runId        = ${run.id}（eval_runs 已留档，详见 GET /admin/eval/runs）`);

  await app.close();
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

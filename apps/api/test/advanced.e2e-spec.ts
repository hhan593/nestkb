import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../../worker/src/worker.module';
import { PrismaService } from '@app/prisma';
import { ask, baseUrlOf, login, uploadDoc, waitForIngestion, type SseEvent } from './helpers';

process.env.QA_REQUEST_LIMIT_PER_MIN ??= '100';

/**
 * 进阶功能用例（计划书 11.2 补齐）：
 * T02 白名单授权 / T06 过期文档 / T07 版本替换 / T08 rerank 降级 / T09 SSE 中断 / T12 配额耗尽。
 */
describe('RAG 进阶用例 E2E', () => {
  it('非法 grant 参数返回 400 而非 500（DTO 校验生效，#33）', async () => {
    // 不需要真实文档：DTO 层先拒绝，非法 subjectType / 非 UUID subjectId 都不该落到 Prisma
    const res = await request(base)
      .post('/admin/documents/00000000-0000-0000-0000-000000000000/grants')
      .set('Authorization', `Bearer ${admin}`)
      .send({ subjectType: 'group', subjectId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  let app: NestFastifyApplication;
  let base: string;
  let worker: { init(): Promise<unknown>; close(): Promise<unknown> };
  let prisma: PrismaService;
  let alice: string;
  let admin: string;
  let aliceUserId: string;
  const createdDocIds: string[] = [];

  const CORPUS_SECRET = `# 高管保密文件\n\n本年度高管团队构成：首席执行官一名、首席技术官一名、首席财务官一名，薪酬委员会由三名董事组成。`;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 25 * 1024 * 1024 }), { logger: ['error'] });
    await app.register(multipart as never, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10 } });
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = baseUrlOf(app);
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] });
    await worker.init();
    prisma = app.get(PrismaService);

    await prisma.document.updateMany({ data: { currentVersionId: null } });
    await prisma.document.deleteMany({});
    await prisma.conversation.deleteMany({});

    alice = await login(base, 'alice@a-dept.com');
    admin = await login(base, 'admin@nestkb.local');
    aliceUserId = (await prisma.user.findUniqueOrThrow({ where: { email: 'alice@a-dept.com' } })).id;
  }, 120_000);

  afterAll(async () => {
    await app.close().catch(() => undefined);
    await worker.close().catch(() => undefined);
  }, 60_000);

  const newConv = async (token: string): Promise<string> => {
    const res = await request(base).post('/qa/conversations').set('Authorization', `Bearer ${token}`);
    return (res.body.data as { id: string }).id;
  };

  const citationsOf = (events: SseEvent[]): Array<Record<string, unknown>> =>
    ((events.find((e) => e.event === 'citations')?.data as { citations?: Array<Record<string, unknown>> } | undefined)?.citations ?? []);

  it('T02 白名单授权：未授权不可见 → 用户级授权后可见（default deny）', async () => {
    // admin 上传 whitelist 文档（归属研发部，白名单空）
    const doc = await uploadDoc(base, admin, { title: `白名单文档-E2E-${Date.now()}`, accessLevel: 'whitelist', content: CORPUS_SECRET });
    createdDocIds.push(doc.documentId);
    expect(await waitForIngestion(base, admin, doc.documentId)).toBe('ready');

    // 未授权：alice 检索不到（候选集为空 → 该问题无其他可见依据）
    const conv1 = await newConv(alice);
    const events1 = await ask(base, alice, conv1, '高管团队的构成是什么？');
    const meta1 = events1.find((e) => e.event === 'meta')!.data as { retrieval: { hitCount: number } };
    const cites1 = citationsOf(events1);
    const leaked1 = cites1.some((c) => c.documentId === doc.documentId);
    expect(leaked1).toBe(false);

    // admin 授予 alice 用户级白名单授权
    await request(base)
      .post(`/admin/documents/${doc.documentId}/grants`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ subjectType: 'user', subjectId: aliceUserId })
      .expect(201);

    // 授权后可检索引用
    const conv2 = await newConv(alice);
    const events2 = await ask(base, alice, conv2, '高管团队的构成是什么？');
    const cites2 = citationsOf(events2);
    expect(cites2.some((c) => c.documentId === doc.documentId)).toBe(true); // 引用命中白名单文档
    void meta1;
  }, 90_000);

  it('T06 过期文档：expires_at 昨天的文档不可被检索引用', async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    const doc = await uploadDoc(base, admin, {
      title: `过期福利-E2E-${Date.now()}`,
      accessLevel: 'company',
      content: '# 过期福利制度\n\n历史福利：员工每人每月发放 500 元交通补贴（本制度已废止）。',
      expiresAt: yesterday,
    });
    createdDocIds.push(doc.documentId);
    expect(await waitForIngestion(base, admin, doc.documentId)).toBe('ready');

    // 该问题在其他可见文档中无依据 → 检索命中的唯一来源是过期文档 → 必须不可召回
    const conv = await newConv(alice);
    const events = await ask(base, alice, conv, '每人每月 500 元交通补贴政策是什么？');
    const cites = citationsOf(events);
    expect(cites.some((c) => c.documentId === doc.documentId)).toBe(false);
  }, 90_000);

  it('T07 版本替换：新版本 ready 后旧版本 chunk 清除，引用只出 v2', async () => {
    const doc = await uploadDoc(base, admin, {
      title: `版本测试-E2E-${Date.now()}`,
      accessLevel: 'company',
      content: '# 报销规则 V1\n\n市内交通费报销上限为每日 100 元。',
    });
    createdDocIds.push(doc.documentId);
    expect(await waitForIngestion(base, admin, doc.documentId)).toBe('ready');

    // 上传 v2（内容变化）
    const res = await request(base)
      .post(`/documents/${doc.documentId}/versions`)
      .set('Authorization', `Bearer ${admin}`)
      .field('title', '')
      .attach('file', Buffer.from('# 报销规则 V2\n\n市内交通费报销上限调整为每日 200 元，需附行程单。', 'utf8'), { filename: 'v2.md', contentType: 'text/markdown' })
      .expect(202);
    const v2 = res.body.data as { versionId: string; versionNo: number };
    expect(v2.versionNo).toBe(2);
    expect(await waitForIngestion(base, admin, doc.documentId)).toBe('ready');

    // 旧版本 chunk 全部清除：document_chunks 只含 v2
    const chunkVersions = await prisma.documentChunk.findMany({
      where: { documentId: doc.documentId },
      select: { versionId: true },
      distinct: ['versionId'],
    });
    expect(chunkVersions).toHaveLength(1);
    expect(chunkVersions[0].versionId).toBe(v2.versionId);

    // 提问引用只出 v2
    const conv = await newConv(alice);
    const events = await ask(base, alice, conv, '市内交通费报销上限是多少？');
    const cites = citationsOf(events);
    expect(cites.length).toBeGreaterThan(0);
    for (const c of cites) {
      expect(c.versionNo).toBe(2);
    }
  }, 120_000);

  it('T08 rerank 降级：注入故障后问答仍成功、meta 打 degraded 标记', async () => {
    // 先上传一篇长文档保证 coarse 池 > topK（否则不触发 rerank，降级无从谈起）
    const longCorpus = `# 数据安全长文\n\n${Array.from({ length: 14 }, (_, i) => `## 第${i + 1}节 数据安全要求${i + 1}\n\n数据安全第${i + 1}条：生产数据访问必须走堡垒机并留存审计日志，敏感查询需双人复核与主管批准。`).join('\n\n')}`;
    const longDoc = await uploadDoc(base, admin, { title: `数据安全长文-E2E-${Date.now()}`, accessLevel: 'company', content: longCorpus });
    createdDocIds.push(longDoc.documentId);
    expect(await waitForIngestion(base, admin, longDoc.documentId)).toBe('ready');

    // 故障注入开关（MockRerankProvider 读取）
    process.env.LLM_RERANK_FAIL = '1';
    try {
      const conv = await newConv(alice);
      const events = await ask(base, alice, conv, '生产数据访问必须走什么通道？');
      const kinds = events.map((e) => e.event);
      expect(kinds).not.toContain('error'); // 问答仍成功
      const meta = events.find((e) => e.event === 'meta')!.data as { retrieval: { rerankDegraded: boolean; hitCount: number } };
      expect(meta.retrieval.hitCount).toBeGreaterThan(0);
      expect(meta.retrieval.rerankDegraded).toBe(true); // 降级标记
      expect(kinds[kinds.length - 1]).toBe('done');
      // query_logs 留痕
      const log = await prisma.queryLog.findFirst({ where: { rerankDegraded: true }, orderBy: { createdAt: 'desc' } });
      expect(log).toBeTruthy();
    } finally {
      delete process.env.LLM_RERANK_FAIL;
    }
  }, 90_000);

  it('T12 配额耗尽：SSE 返回 QUOTA_EXCEEDED，恢复后正常', async () => {
    const dept = await prisma.department.findFirstOrThrow({ where: { name: '研发部' } });
    const original = dept.quotaMonth;
    await prisma.department.update({ where: { id: dept.id }, data: { quotaMonth: 0.0001 } });
    try {
      const conv = await newConv(alice);
      const events = await ask(base, alice, conv, '代码评审需要几个人批准？');
      const err = events.find((e) => e.event === 'error')?.data as { code: string; message: string } | undefined;
      expect(err?.code).toBe('QUOTA_EXCEEDED');
      expect(err?.message).toContain('配额');
    } finally {
      await prisma.department.update({ where: { id: dept.id }, data: { quotaMonth: original } });
    }
    // 恢复后正常
    const conv2 = await newConv(alice);
    const events2 = await ask(base, alice, conv2, '代码评审需要几个人批准？');
    expect(events2.map((e) => e.event)).toContain('citations');
  }, 90_000);

  it('T09 SSE 中断：客户端断开 → 上游取消 → message.status=aborted + 部分结算', async () => {
    // 拉大 mock 流式间隔，制造"收到 2 个 delta 后断开"的窗口
    const prevDelay = process.env.MOCK_STREAM_DELAY_MS;
    process.env.MOCK_STREAM_DELAY_MS = '150';
    try {
      const token = alice;
      const convId = await newConv(token);
      const before = await prisma.usageRecord.count({ where: { scene: 'qa' } });

      // 原生 http：收到 2 个 delta 后断开（supertest 不支持中途 destroy）
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: new URL(base).port, path: `/qa/conversations/${convId}/messages`, method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } },
          (res) => {
            let deltas = 0;
            res.on('data', (chunk: Buffer) => {
              deltas += (chunk.toString().match(/event: delta/g) || []).length;
              if (deltas >= 2) {
                res.destroy(); // 客户端断开
                resolve();
              }
            });
          },
        );
        req.on('error', () => resolve());
        req.end(JSON.stringify({ question: '员工试用期考核不通过怎么处理？' }));
        setTimeout(() => resolve(), 15000); // 兜底
      });

      // 断开后：服务端 abort 处理与部分结算是异步的，等一拍再断言
      await new Promise((r) => setTimeout(r, 1500));
      const aborted = await prisma.message.findFirst({
        where: { conversationId: convId, role: 'assistant', status: 'aborted' },
        orderBy: { createdAt: 'desc' },
      });
      expect(aborted).toBeTruthy();
      expect(aborted!.content.length).toBeGreaterThan(0);
      // 部分结算：产生了 qa 场景 usage 记录（费用不漂移）
      const after = await prisma.usageRecord.count({ where: { scene: 'qa' } });
      expect(after).toBe(before + 1);
      // 会话消息流里用户消息存在
      const userMsg = await prisma.message.findFirst({ where: { conversationId: convId, role: 'user' } });
      expect(userMsg).toBeTruthy();
    } finally {
      if (prevDelay === undefined) delete process.env.MOCK_STREAM_DELAY_MS;
      else process.env.MOCK_STREAM_DELAY_MS = prevDelay;
    }
  }, 90_000);
});

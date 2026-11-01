/**
 * seed-docs：把 samples/corpus 的语料批量上传入库并入队摄取（W2 验收的批量脚本形态）。
 * 语料头部用 HTML 注释承载元数据：
 *   <!-- title: 员工手册 / dept: a|b / access: company|department|whitelist / expiresAt: ISO -->
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { INGEST_QUEUE, type IngestJobData } from '../libs/contracts/src';
import { loadDotenvFile, parseEnv } from '../libs/common/src/config/env';

loadDotenvFile();
const env = parseEnv(process.env);
const prisma = new PrismaClient();

interface CorpusMeta {
  title: string;
  dept: 'a' | 'b';
  access: 'company' | 'department' | 'whitelist';
  expiresAt?: string;
}

function parseMeta(content: string): CorpusMeta {
  const m = content.match(/<!--\s*([\s\S]*?)-->/);
  const meta: CorpusMeta = { title: '未命名文档', dept: 'a', access: 'company' };
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^\s*(\w+)\s*[:=]\s*(.+?)\s*$/);
      if (!kv) continue;
      const [, k, v] = kv;
      if (k === 'title') meta.title = v;
      if (k === 'dept' && (v === 'a' || v === 'b')) meta.dept = v;
      if (k === 'access' && ['company', 'department', 'whitelist'].includes(v)) meta.access = v as CorpusMeta['access'];
      if (k === 'expiresAt') meta.expiresAt = v;
    }
  }
  return meta;
}

async function main(): Promise<void> {
  const depts = await prisma.department.findMany();
  const deptA = depts.find((d) => d.name === '研发部');
  const deptB = depts.find((d) => d.name === '人事部');
  if (!deptA || !deptB) throw new Error('先运行 pnpm seed 建部门');

  const admin = await prisma.user.findUnique({ where: { email: 'admin@nestkb.local' } });
  if (!admin) throw new Error('先运行 pnpm seed 建账号');

  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<IngestJobData>(INGEST_QUEUE, { connection: redis });

  const dir = path.join(process.cwd(), 'samples', 'corpus');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
  let enqueued = 0;

  for (const file of files) {
    const buffer = await fs.readFile(path.join(dir, file));
    const content = buffer.toString('utf8');
    const meta = parseMeta(content);
    const dept = meta.dept === 'a' ? deptA : deptB;

    const exists = await prisma.document.findFirst({ where: { title: meta.title } });
    if (exists) {
      console.log(`skip（已存在）：${meta.title}`);
      continue;
    }

    const documentId = randomUUID();
    const versionId = randomUUID();
    const checksum = createHash('sha256').update(buffer).digest('hex');
    const storageKey = `${documentId}/${versionId}.md`;

    await prisma.document.create({
      data: {
        id: documentId,
        departmentId: dept.id,
        title: meta.title,
        accessLevel: meta.access,
        versions: {
          create: {
            id: versionId,
            versionNo: 1,
            storageKey,
            mimeType: 'text/markdown',
            effectiveAt: new Date(),
            expiresAt: meta.expiresAt ? new Date(meta.expiresAt) : null,
            checksum,
          },
        },
        ingestionJobs: { create: { versionId, stage: 'queued' } },
      },
    });
    // 自引用 FK：先建版本再切换 current_version_id
    await prisma.document.update({ where: { id: documentId }, data: { currentVersionId: versionId } });

    const absDir = path.join(process.cwd(), env.storageDir, documentId);
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, `${versionId}.md`), buffer);

    await queue.add(
      'ingest',
      {
        documentId,
        versionId,
        title: meta.title,
        storageKey,
        mimeType: 'text/markdown',
        contentHash: checksum,
        deptId: dept.id,
        aclDeptIds: meta.access === 'company' ? ['*'] : [dept.id],
        uploadedBy: admin.id,
        requestId: `seed-${documentId.slice(0, 8)}`,
      } satisfies IngestJobData,
      { jobId: versionId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 500, removeOnFail: false },
    );
    enqueued++;
    console.log(`enqueued：${meta.title}（${dept.name} / ${meta.access}）`);
  }

  console.log(`seed-docs 完成：新入队 ${enqueued} 篇，worker 启动后自动摄取`);
  await queue.close();
  await redis.quit();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

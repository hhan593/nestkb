import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ALLOWED_EXT, ErrorCodes, INGEST_QUEUE, IngestJobData, extForMime } from '@lib/contracts';
import { AccessLevel, type Prisma } from '@prisma/client';
import { AppEnv, ENV, REDIS, TraceService, invalidateDeptCache, maxUploadBytes, maxUploadMb } from '@app/common';
import type Redis from 'ioredis';
import { PrismaService } from '@app/prisma';
import type { AuthedUser } from '../auth/auth.service';

type PrismaDocumentVersion = Awaited<ReturnType<Prisma.TransactionClient['documentVersion']['create']>>;

export interface UploadInput {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  title: string;
  accessLevel: AccessLevel;
  expiresAt?: Date | null;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(INGEST_QUEUE) private readonly ingestQueue: Queue<IngestJobData>,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly trace: TraceService,
  ) {}

  /** 上传建文档 + 版本并入队摄取（计划书 7.3-②，202 受理） */
  async upload(user: AuthedUser, input: UploadInput): Promise<{
    documentId: string;
    versionId: string;
    versionNo: number;
    ingestionJobId: string;
    acceptedAt: string;
  }> {
    return this.createVersionFor(user, null, input);
  }

  /** 重新上传生成新版本（旧版本自动下线：current_version_id 切换 + replaceVersion 清旧块） */
  async addVersion(user: AuthedUser, documentId: string, input: Omit<UploadInput, 'title' | 'accessLevel'>): Promise<{
    documentId: string;
    versionId: string;
    versionNo: number;
    ingestionJobId: string;
    acceptedAt: string;
  }> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException('文档不存在');
    await this.assertCanManage(user, doc);
    return this.createVersionFor(user, documentId, {
      ...input,
      title: doc.title,
      accessLevel: doc.accessLevel,
    });
  }

  private async createVersionFor(
    user: AuthedUser,
    documentId: string | null,
    input: UploadInput,
  ): Promise<{
    documentId: string;
    versionId: string;
    versionNo: number;
    ingestionJobId: string;
    acceptedAt: string;
  }> {
    const ext = path.extname(input.filename).toLowerCase() || extForMime(input.mimetype);
    if (!ALLOWED_EXT.has(ext)) {
      throw new BadRequestException({ code: ErrorCodes.UNSUPPORTED_TYPE, message: `不支持的文件类型：${ext}` });
    }
    if (input.buffer.byteLength > maxUploadBytes()) {
      throw new BadRequestException({ code: ErrorCodes.FILE_TOO_LARGE, message: `文件超过 ${maxUploadMb()}MB 上限` });
    }
    const checksum = createHash('sha256').update(input.buffer).digest('hex');

    const doc = documentId
      ? await this.prisma.document.findUniqueOrThrow({ where: { id: documentId } })
      : await this.prisma.document.create({
          data: {
            departmentId: user.deptId,
            title: input.title,
            accessLevel: input.accessLevel,
          },
        });

    const versionId = randomUUID();
    let versionNo = 0;
    const storageKey = `${doc.id}/${versionId}${ext}`;
    const absDir = path.join(process.cwd(), this.env.storageDir, doc.id);

    // 先落盘再建库：DB 事务提交后文件必然存在，不会留下指向空文件的 current 版本
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, path.basename(storageKey)), input.buffer);

    // 建版本 + 切换 current_version_id + 建摄取任务（单事务）；versionNo 事务内生成，撞唯一约束重试
    let version: { version: PrismaDocumentVersion; job: { id: string }; versionNo: number };
    try {
      version = await this.prisma.$transaction(async (tx) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const maxNo = await tx.documentVersion.aggregate({ _max: { versionNo: true }, where: { documentId: doc.id } });
            const vNo = (maxNo._max.versionNo ?? 0) + 1;
            const v = await tx.documentVersion.create({
              data: {
                id: versionId,
                documentId: doc.id,
                versionNo: vNo,
                storageKey,
                mimeType: input.mimetype || ext,
                effectiveAt: new Date(),
                expiresAt: input.expiresAt ?? null,
                checksum,
              },
            });
            await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: v.id } });
            const job = await tx.ingestionJob.create({
              data: { documentId: doc.id, versionId: v.id, stage: 'queued' },
            });
            return { version: v, job, versionNo: vNo };
          } catch (err) {
            // 并发加版本撞 @@unique([documentId, versionNo])：重取 max 重试
            if (attempt < 2 && typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') continue;
            throw err;
          }
        }
      });
    } catch (err) {
      // 事务失败：回收已落盘文件，不留孤儿
      await fs.rm(path.join(absDir, path.basename(storageKey)), { force: true }).catch(() => undefined);
      throw err;
    }
    versionNo = version.versionNo;

    try {
      await this.ingestQueue.add(
        'ingest',
        {
          documentId: doc.id,
          versionId,
          title: doc.title,
          storageKey,
          mimeType: version.version.mimeType,
          contentHash: checksum,
          // 权限归属以文档所属部门为准（admin 可跨部门重传，不能把自己部门写进 chunk）
          deptId: doc.departmentId,
          aclDeptIds: await this.buildAclDeptIds(doc.accessLevel, doc.departmentId, doc.id),
          uploadedBy: user.userId,
          requestId: this.trace.requestId,
        } satisfies IngestJobData,
        {
          jobId: versionId, // 幂等键：重复投递同版本零副作用
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 500,
          removeOnFail: false, // 失败进 DLQ 供人工重放
        },
      );
    } catch (err) {
      // 入队失败补偿：标记 failed（文件与版本都在，可人工重放），不留永久 queued 悬挂
      await this.prisma.ingestionJob
        .update({ where: { versionId }, data: { stage: 'failed', error: `ENQUEUE_FAILED: ${String(err).slice(0, 400)}` } })
        .catch(() => undefined);
      throw err;
    }

    return {
      documentId: doc.id,
      versionId,
      versionNo,
      ingestionJobId: version.job.id,
      acceptedAt: new Date().toISOString(),
    };
  }

  /** 本部门可见文档列表（分页，含摄取状态）——权限在查询层过滤 */
  async list(user: AuthedUser, query: { page: number; pageSize: number }) {
    const where: Prisma.DocumentWhereInput = {
      status: 'active',
      ...visibilityOf(user),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.document.count({ where }),
      this.prisma.document.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          currentVersion: {
            include: { ingestionJob: { select: { stage: true, chunkCount: true, error: true, attempts: true } } },
          },
          _count: { select: { versions: true } },
        },
      }),
    ]);
    return {
      total,
      rows: rows.map((d) => ({
        id: d.id,
        title: d.title,
        accessLevel: d.accessLevel,
        departmentId: d.departmentId,
        versionCount: d._count.versions,
        currentVersion: d.currentVersion
          ? {
              id: d.currentVersion.id,
              versionNo: d.currentVersion.versionNo,
              effectiveAt: d.currentVersion.effectiveAt.toISOString(),
              expiresAt: d.currentVersion.expiresAt?.toISOString() ?? null,
              ingestion: d.currentVersion.ingestionJob
                ? {
                    stage: d.currentVersion.ingestionJob.stage,
                    chunkCount: d.currentVersion.ingestionJob.chunkCount,
                    error: d.currentVersion.ingestionJob.error,
                    attempts: d.currentVersion.ingestionJob.attempts,
                  }
                : null,
            }
          : null,
      })),
    };
  }

  async detail(user: AuthedUser, id: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id, status: 'active', ...visibilityOf(user) },
      include: {
        versions: { orderBy: { versionNo: 'desc' }, include: { ingestionJob: true } },
        currentVersion: { include: { ingestionJob: true } },
        permissions: true,
        department: { select: { name: true } },
      },
    });
    if (!doc) throw new NotFoundException({ code: ErrorCodes.NOT_FOUND, message: '文档不存在或无权访问' });
    return {
      id: doc.id,
      title: doc.title,
      accessLevel: doc.accessLevel,
      departmentName: doc.department.name,
      permissions: doc.permissions.map((p) => ({
        id: p.id,
        subjectType: p.subjectType,
        subjectId: p.subjectId,
        effect: p.effect,
        expiresAt: p.expiresAt?.toISOString() ?? null,
      })),
      versions: doc.versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        effectiveAt: v.effectiveAt.toISOString(),
        expiresAt: v.expiresAt?.toISOString() ?? null,
        isCurrent: v.id === doc.currentVersionId,
        checksum: v.checksum.slice(0, 12),
        ingestion: v.ingestionJob
          ? { stage: v.ingestionJob.stage, chunkCount: v.ingestionJob.chunkCount, error: v.ingestionJob.error }
          : null,
      })),
    };
  }

  /** 删除：级联清 chunks/versions/jobs/permissions（FK cascade），文件尽力清理 */
  async remove(user: AuthedUser, id: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('文档不存在');
    await this.assertCanManage(user, doc);
    const versions = await this.prisma.documentVersion.findMany({ where: { documentId: id } });
    // 先断开自引用（current_version_id → document_versions），否则级联删除时 FK 校验失败
    await this.prisma.document.update({ where: { id }, data: { currentVersionId: null } });
    await this.prisma.document.delete({ where: { id } });
    // 部门语义缓存可能引用已删除文档：立即失效，避免 24h TTL 内继续返回旧答案
    await invalidateDeptCache(this.redis, doc.departmentId);
    await Promise.all(
      versions.map((v) =>
        fs.rm(path.join(process.cwd(), this.env.storageDir, v.storageKey), { force: true }).catch(() => undefined),
      ),
    ).catch(() => undefined);
  }

  /** 摄取状态：stage/进度/chunkCount/error/stageDurationsMs（计划书 7.3-③） */
  async ingestionStatus(user: AuthedUser, id: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id, ...visibilityOf(user) },
      include: { currentVersion: { include: { ingestionJob: true } } },
    });
    if (!doc?.currentVersion?.ingestionJob) throw new NotFoundException('文档或摄取任务不存在');
    const jobRow = doc.currentVersion.ingestionJob;
    const bullJob = await this.ingestQueue.getJob(doc.currentVersion.id);
    const progress = typeof bullJob?.progress === 'number' ? bullJob.progress : jobRow.stage === 'ready' ? 100 : 0;
    return {
      stage: jobRow.stage,
      progress,
      attempts: jobRow.attempts,
      chunkCount: jobRow.chunkCount,
      error: jobRow.error,
      startedAt: jobRow.startedAt?.toISOString() ?? null,
      stageDurationsMs: jobRow.stageTimings as Record<string, number>,
    };
  }

  /** DLQ/失败任务人工重放（admin）：失败 job retry 或重新入队 */
  async reingest(id: string): Promise<{ requeued: boolean }> {
    const doc = await this.prisma.document.findUnique({
      where: { id },
      include: { currentVersion: { include: { ingestionJob: true } } },
    });
    if (!doc?.currentVersion?.ingestionJob) throw new NotFoundException('文档或摄取任务不存在');
    const versionId = doc.currentVersion.id;
    const row = doc.currentVersion.ingestionJob;
    if (row.stage === 'ready') throw new BadRequestException('当前版本已是 ready，无需重放');
    await this.prisma.ingestionJob.update({
      where: { versionId },
      data: { stage: 'queued', error: null },
    });
    const bullJob = await this.ingestQueue.getJob(versionId);
    const originalUploader = (bullJob?.data as IngestJobData | undefined)?.uploadedBy ?? versionId;
    if (bullJob) {
      try {
        await bullJob.retry();
        return { requeued: true };
      } catch {
        await this.ingestQueue.remove(versionId).catch(() => undefined);
      }
    }
    await this.ingestQueue.add(
      'ingest',
      {
        documentId: doc.id,
        versionId,
        title: doc.title,
        storageKey: doc.currentVersion.storageKey,
        mimeType: doc.currentVersion.mimeType,
        contentHash: doc.currentVersion.checksum,
        deptId: doc.departmentId,
        aclDeptIds: await this.buildAclDeptIds(doc.accessLevel, doc.departmentId, doc.id),
        uploadedBy: originalUploader,
        requestId: this.trace.requestId,
      } satisfies IngestJobData,
      { jobId: versionId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 500, removeOnFail: false },
    );
    return { requeued: true };
  }

  /**
   * 管理权 = 归属权 ∩ 可见权（admin 直通，#26）。
   *
   * 这两条判据原先各管一段：`remove` 只查归属、`list/detail` 走 visibilityOf，于是
   * 「列表里根本看不到的 whitelist 文档」仍能被同部门成员删掉或覆盖新版本。管理不该比查看更宽。
   */
  private async assertCanManage(
    user: AuthedUser,
    doc: { id: string; departmentId: string; accessLevel: AccessLevel },
  ): Promise<void> {
    if (user.role === 'admin') return; // admin 直通：治理操作不受白名单过滤影响
    if (user.deptId !== doc.departmentId) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: '只能管理本部门文档' });
    }
    if (doc.accessLevel !== 'whitelist') return; // company/department 对本部门天然可见
    // 白名单 default deny：归属部门同样要显式授权才看得见，看不见就不该能删
    const visible = await this.prisma.document.count({ where: { id: doc.id, ...visibilityOf(user) } });
    if (!visible) {
      throw new ForbiddenException({
        code: ErrorCodes.FORBIDDEN,
        message: '该白名单文档未授权给您，无法管理；请联系文档归属部门或管理员',
      });
    }
  }

  /** 摄取期 ACL 解析（方案 B payload 需要；pgvector 侧存档于 chunk metadata） */
  private async buildAclDeptIds(accessLevel: AccessLevel, deptId: string, documentId: string): Promise<string[]> {
    if (accessLevel === 'company') return ['*'];
    if (accessLevel === 'department') return [deptId];
    const grants = await this.prisma.deptPermission.findMany({
      where: { documentId, subjectType: 'dept', effect: 'allow', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    return [...new Set([deptId, ...grants.map((g) => g.subjectId)])];
  }

}

/** 可见性 OR 条件：company / 本部门 department / whitelist 显式授权（含用户级），default deny。
 * admin 直通（全量可见）—— 管理端与治理操作不受白名单过滤影响。 */
export function visibilityOf(user: AuthedUser): Prisma.DocumentWhereInput {
  if (user.role === 'admin') return {}; // admin 直通（不能用 OR:[{}]，Prisma 会丢弃空对象分支）
  const now = new Date();
  return { OR: [
    { accessLevel: 'company' as const },
    { accessLevel: 'department' as const, departmentId: user.deptId },
    {
      accessLevel: 'whitelist' as const,
      permissions: {
        some: {
          AND: [
            { effect: 'allow' as const },
            {
              OR: [
                { subjectType: 'dept' as const, subjectId: user.deptId },
                { subjectType: 'user' as const, subjectId: user.userId },
              ],
            },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
        },
      },
    },
  ] };
}

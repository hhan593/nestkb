import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { AuthedUser } from '../auth/auth.service';
import { DocumentsService } from './documents.service';

const member: AuthedUser = { userId: 'u-1', email: 'u@a-dept.com', role: 'member', deptId: 'd-1' };
const outsider: AuthedUser = { userId: 'u-2', email: 'u@b-dept.com', role: 'member', deptId: 'd-2' };
const admin: AuthedUser = { userId: 'u-admin', email: 'a@x.com', role: 'admin', deptId: 'd-1' };

const whitelistDoc = { id: 'doc-1', departmentId: 'd-1', accessLevel: 'whitelist' };
const deptDoc = { id: 'doc-2', departmentId: 'd-1', accessLevel: 'department' };

function make() {
  const prisma = {
    document: {
      findUnique: vi.fn(async (): Promise<unknown> => undefined),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    documentVersion: { findMany: vi.fn(async () => []) },
  };
  const queue = { add: vi.fn(async () => ({})), getJob: vi.fn(async () => undefined) };
  const redis = { scan: vi.fn(async () => ['0', []]), unlink: vi.fn(async () => 1) };
  const service = new DocumentsService(
    prisma as never,
    queue as never,
    { storageDir: 'storage/uploads' } as never,
    redis as never,
    { requestId: 'req-1' } as never,
  );
  return { service, prisma, queue, redis };
}

describe('DocumentsService.remove —— 管理权 = 归属 ∩ 可见（#26）', () => {
  it('同部门成员删除未授权的 whitelist 文档 → 403，且不落删除', async () => {
    const { service, prisma } = make();
    prisma.document.findUnique.mockResolvedValueOnce(whitelistDoc);
    prisma.document.count.mockResolvedValueOnce(0);

    await expect(service.remove(member, 'doc-1')).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.document.delete).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it('被显式授权（dept/user 级）的同部门成员可以删除', async () => {
    const { service, prisma } = make();
    prisma.document.findUnique.mockResolvedValueOnce(whitelistDoc);
    prisma.document.count.mockResolvedValueOnce(1);

    await service.remove(member, 'doc-1');

    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
  });

  it('department 文档对本部门天然可见，不额外查白名单', async () => {
    const { service, prisma } = make();
    prisma.document.findUnique.mockResolvedValueOnce(deptDoc);

    await service.remove(member, 'doc-2');

    expect(prisma.document.count).not.toHaveBeenCalled();
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'doc-2' } });
  });

  it('跨部门仍然 403（归属权先于可见权）', async () => {
    const { service, prisma } = make();
    prisma.document.findUnique.mockResolvedValueOnce(whitelistDoc);

    await expect(service.remove(outsider, 'doc-1')).rejects.toThrow('只能管理本部门文档');
    expect(prisma.document.count).not.toHaveBeenCalled();
    expect(prisma.document.delete).not.toHaveBeenCalled();
  });

  it('admin 直通：白名单文档也可治理', async () => {
    const { service, prisma } = make();
    prisma.document.findUnique.mockResolvedValueOnce(whitelistDoc);

    await service.remove(admin, 'doc-1');

    expect(prisma.document.count).not.toHaveBeenCalled();
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { id: 'doc-1' } });
  });
});

describe('DocumentsService.addVersion —— 同一判据（#26）', () => {
  it('未授权的 whitelist 文档不允许覆盖新版本', async () => {
    const { service, prisma, queue } = make();
    prisma.document.findUnique.mockResolvedValueOnce(whitelistDoc);
    prisma.document.count.mockResolvedValueOnce(0);

    await expect(
      service.addVersion(member, 'doc-1', { buffer: Buffer.from('x'), filename: 'a.md', mimetype: 'text/markdown' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

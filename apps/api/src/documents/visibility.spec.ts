import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { AuthedUser } from '../auth/auth.service';
import { visibilityOf } from './documents.service';

const member: AuthedUser = { userId: 'u-1', email: 'u@a-dept.com', role: 'member', deptId: 'd-1' };
const admin: AuthedUser = { userId: 'u-admin', email: 'a@x.com', role: 'admin', deptId: 'd-1' };

type Where = Prisma.DocumentWhereInput & { OR?: Array<Record<string, unknown>> };

/** 权限矩阵：visibilityOf 是 list/detail 与 assertCanManage 共用的唯一判据（#34） */
describe('visibilityOf —— 可见性矩阵', () => {
  it('admin 直通：不附加任何过滤', () => {
    expect(visibilityOf(admin)).toEqual({});
  });

  it('member 三条分支：company / 本部门 department / 被显式授权的 whitelist', () => {
    const where = visibilityOf(member) as Where;
    expect(where.OR).toHaveLength(3);
    expect(where.OR?.[0]).toEqual({ accessLevel: 'company' });
    // department 只认本部门：跨部门要看归属部门，不能靠访问者 deptId 猜测
    expect(where.OR?.[1]).toEqual({ accessLevel: 'department', departmentId: 'd-1' });
  });

  it('whitelist 分支要求 allow + (dept 或 user 授权) + 未过期，default deny', () => {
    const where = visibilityOf(member) as Where;
    const whitelist = where.OR?.[2] as {
      accessLevel: string;
      permissions: { some: { AND: Array<Record<string, unknown>> } };
    };
    expect(whitelist.accessLevel).toBe('whitelist');
    // 关键：没有 departmentId 条件 —— 归属部门成员未授权也看不见（正是 #26 越权的前提）
    expect(whitelist).not.toHaveProperty('departmentId');

    const and = whitelist.permissions.some.AND;
    expect(and[0]).toEqual({ effect: 'allow' });
    expect((and[1] as { OR: unknown[] }).OR).toEqual([
      { subjectType: 'dept', subjectId: 'd-1' },
      { subjectType: 'user', subjectId: 'u-1' },
    ]);
    expect((and[2] as { OR: unknown[] }).OR[0]).toEqual({ expiresAt: null });
  });

  it('过期判定基线取调用时刻', () => {
    const before = Date.now();
    const where = visibilityOf(member) as Where;
    const after = Date.now();
    const gt = (
      where.OR?.[2] as unknown as {
        permissions: { some: { AND: Array<{ OR: Array<{ expiresAt?: { gt?: Date } }> }> } };
      }
    ).permissions.some.AND[2].OR[1].expiresAt?.gt as Date;

    expect(gt.getTime()).toBeGreaterThanOrEqual(before);
    expect(gt.getTime()).toBeLessThanOrEqual(after);
  });
});

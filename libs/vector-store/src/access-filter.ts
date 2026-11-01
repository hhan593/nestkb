/**
 * 权限前置过滤（计划书 8.5）——"可检索"判定 SQL 片段。
 * 权限是检索的第一个 WHERE 条件，不是 prompt 提示；越权数据从未进入候选集。
 * access_level 三档：company 全公司 / department 本部门 / whitelist 显式授权（default deny）。
 */
import { ErrorCodes } from '@lib/contracts';

export interface AccessScope {
  userId: string;
  deptId: string;
  isAdmin: boolean;
}

export class AccessScopeRequiredError extends Error {
  readonly code = ErrorCodes.UNAUTHORIZED;
  constructor() {
    super('AccessScope is required: 无权限主体的检索在接口上无法构造');
    this.name = 'AccessScopeRequiredError';
  }
}

/**
 * 生成 access 判定 SQL（参数占位从 startParam 开始，返回按序追加的参数）。
 * @param deptColumn 权限冗余列：chunks 查询用 c.dept_id；documents 查询用 d.department_id
 */
export function accessWhereSql(
  scope: AccessScope,
  startParam: number,
  deptColumn: string,
): { sql: string; params: string[] } {
  if (!scope?.deptId) throw new AccessScopeRequiredError();
  if (scope.isAdmin) return { sql: 'TRUE', params: [] };
  return {
    params: [scope.deptId, scope.userId],
    sql: `
    ( d.access_level = 'company'
      OR (d.access_level = 'department' AND ${deptColumn} = $${startParam})
      OR (d.access_level = 'whitelist' AND EXISTS (
            SELECT 1 FROM dept_permissions p
             WHERE p.document_id = d.id AND p.effect = 'allow'
               AND ((p.subject_type = 'dept' AND p.subject_id = $${startParam})
                 OR (p.subject_type = 'user' AND p.subject_id = $${startParam + 1}))
               AND (p.expires_at IS NULL OR p.expires_at > now()))) )`,
  };
}

/** 方案 B（Qdrant）等价 filter：摄取期已把 ACL 解析成 acl_dept_ids 数组（计划书 6.11） */
export const qdrantAccessFilter = (scope: AccessScope, versionIds: string[]) => ({
  must: [
    { key: 'acl_dept_ids', match: { any: scope.isAdmin ? ['*'] : [scope.deptId] } },
    { key: 'version_id', match: { any: versionIds } },
  ],
  must_not: [{ key: 'expires_at', range: { lte: new Date().toISOString() } }],
});

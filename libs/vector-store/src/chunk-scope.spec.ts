import { describe, expect, it } from 'vitest';
import { chunkScopeSql } from './chunk-scope';

describe('chunkScopeSql（可检索范围唯一组装处，#24）', () => {
  it('member：只认当前版本 + 未过期，权限参数按 startParam 顺延', () => {
    const s = chunkScopeSql({ userId: 'u-1', deptId: 'd-1', isAdmin: false }, 1);
    // 文档层与块层各判一次，因此同组参数出现两遍
    expect(s.params).toEqual(['d-1', 'u-1', 'd-1', 'u-1']);
    expect(s.sql).toContain('d.current_version_id = v.id');
    expect(s.sql).toContain("d.status = 'active'");
    expect(s.sql).toContain('v.expires_at IS NULL OR v.expires_at > now()');
    expect(s.sql).toContain("d.access_level = 'department' AND d.department_id = $1");
    expect(s.sql).toContain("p.subject_type = 'user' AND p.subject_id = $2");
    // 块层从 startParam + 2 起（文档层占了 2 个占位）
    expect(s.sql).toContain("d.access_level = 'department' AND c.dept_id = $3");
    expect(s.sql).toContain("p.subject_type = 'dept' AND p.subject_id = $3");
    expect(s.sql).toContain("p.subject_type = 'user' AND p.subject_id = $4");
  });

  it('admin：权限直通 TRUE 且不产生参数（对照查询用）', () => {
    const s = chunkScopeSql({ userId: 'u-1', deptId: 'd-1', isAdmin: true }, 2);
    expect(s.params).toEqual([]);
    expect(s.sql).toContain('TRUE');
    expect(s.sql).toContain('d.current_version_id = v.id');
  });

  it('member 与 admin 只在权限表达式上分叉，版本/有效期条件逐字一致', () => {
    const member = chunkScopeSql({ userId: 'u-1', deptId: 'd-1', isAdmin: false }, 1);
    const admin = chunkScopeSql({ userId: 'u-1', deptId: 'd-1', isAdmin: true }, 2);
    const versionGuard = (sql: string) => sql.match(/c\.version_id IN \([\s\S]*?\)/)?.[0];
    expect(versionGuard(member.sql)).toBe(versionGuard(admin.sql));
    expect(versionGuard(member.sql)).toContain('d.current_version_id = v.id');
    expect(member.sql).toContain("d.access_level = 'department'");
    expect(admin.sql).not.toContain("d.access_level = 'department'");
  });
});

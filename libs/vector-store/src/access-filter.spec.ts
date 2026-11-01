import { describe, expect, it } from 'vitest';
import { accessWhereSql, qdrantAccessFilter } from './access-filter';

describe('accessWhereSql（权限 WHERE 组装器，计划书 8.5）', () => {
  it('member：company/department/whitelist 三分支齐全，参数从 startParam 起', () => {
    const w = accessWhereSql({ userId: 'u-1', deptId: 'd-1', isAdmin: false }, 3, 'c.dept_id');
    expect(w.params).toEqual(['d-1', 'u-1']);
    expect(w.sql).toContain("d.access_level = 'company'");
    expect(w.sql).toContain("d.access_level = 'department' AND c.dept_id = $3");
    expect(w.sql).toContain("p.subject_type = 'dept' AND p.subject_id = $3");
    expect(w.sql).toContain("p.subject_type = 'user' AND p.subject_id = $4");
    expect(w.sql).toContain("p.effect = 'allow'");
    expect(w.sql).toContain('p.expires_at IS NULL OR p.expires_at > now()');
  });

  it('deptColumn 可替换（documents 查询用 d.department_id）', () => {
    const w = accessWhereSql({ userId: 'u-1', deptId: 'd-1', isAdmin: false }, 1, 'd.department_id');
    expect(w.sql).toContain('d.department_id = $1');
  });

  it('admin 直通 TRUE（对照查询用）', () => {
    const w = accessWhereSql({ userId: 'u-1', deptId: 'd-1', isAdmin: true }, 1, 'c.dept_id');
    expect(w.sql).toBe('TRUE');
    expect(w.params).toEqual([]);
  });

  it('无 deptId 的 scope 直接抛错（"无权限的检索"无法构造）', () => {
    expect(() => accessWhereSql({ userId: 'u', deptId: '', isAdmin: false }, 1, 'c.dept_id')).toThrow();
  });
});

describe('qdrantAccessFilter（方案 B payload filter）', () => {
  it('acl_dept_ids + version_id 前置，过期 must_not', () => {
    const f = qdrantAccessFilter({ userId: 'u', deptId: 'd-9', isAdmin: false }, ['v-1', 'v-2']);
    expect(f.must).toContainEqual({ key: 'acl_dept_ids', match: { any: ['d-9'] } });
    expect(f.must).toContainEqual({ key: 'version_id', match: { any: ['v-1', 'v-2'] } });
    expect(f.must_not[0].key).toBe('expires_at');
  });
});

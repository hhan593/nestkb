import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { invalidateDeptCache, semanticCacheKey } from './semantic-cache';

describe('semanticCacheKey —— 读写与失效共用的键契约', () => {
  it('格式保持 scache:<deptId>:<sha1(归一化问题)>，改动会让存量缓存失效', () => {
    const expected = `scache:d-1:${createHash('sha1').update('a b').digest('hex')}`;
    expect(semanticCacheKey('d-1', '  A   B  ')).toBe(expected);
    expect(semanticCacheKey('d-1', 'A B')).toBe(expected);
  });

  it('部门隔离、问题隔离', () => {
    expect(semanticCacheKey('d-1', '问题')).not.toBe(semanticCacheKey('d-2', '问题'));
    expect(semanticCacheKey('d-1', '问题一')).not.toBe(semanticCacheKey('d-1', '问题二'));
  });
});

describe('invalidateDeptCache', () => {
  it('按部门前缀扫描全部游标并删除命中的键', async () => {
    const redis = {
      scan: vi
        .fn()
        .mockResolvedValueOnce(['1', ['scache:d-1:a', 'scache:d-1:b']])
        .mockResolvedValueOnce(['0', ['scache:d-1:c']]),
      unlink: vi.fn(async (..._keys: string[]) => 1),
    };

    await invalidateDeptCache(redis as never, 'd-1');

    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.scan.mock.calls[0]).toEqual(['0', 'MATCH', 'scache:d-1:*', 'COUNT', 200]);
    expect(redis.scan.mock.calls[1][0]).toBe('1');
    expect(redis.unlink).toHaveBeenCalledTimes(2);
    expect(redis.unlink.mock.calls[0]).toEqual(['scache:d-1:a', 'scache:d-1:b']);
  });

  it('一无所获时不调用 unlink', async () => {
    const redis = { scan: vi.fn(async () => ['0', []]), unlink: vi.fn(async () => 0) };

    await invalidateDeptCache(redis as never, 'd-9');

    expect(redis.unlink).not.toHaveBeenCalled();
  });
});

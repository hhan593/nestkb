import { createHash } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * 语义缓存键契约（读写与失效共用）。
 *
 * 原先 key 拼接在 SemanticCacheService 内、失效匹配字符串在另一个函数里各写一份，
 * 前缀一旦改动就会出现清不掉的"幽灵缓存"（最长存活 24h 的过期引用）。
 * 同时把失效工具下沉到基础设施层，避免 documents/admin 反向依赖 qa 域（包级循环）。
 */
function normalize(question: string): string {
  return question.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function semanticCacheKey(deptId: string, question: string): string {
  return `scache:${deptId}:${createHash('sha1').update(normalize(question)).digest('hex')}`;
}

/** 文档删除/过期/权限回收后调用：清空该部门全部缓存 */
export async function invalidateDeptCache(redis: Redis, deptId: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `scache:${deptId}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length) await redis.unlink(...keys);
  } while (cursor !== '0');
}

import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CitationDto } from '@lib/contracts';
import { REDIS } from '@app/common';
import type Redis from 'ioredis';

const CACHE_TTL_SEC = 24 * 3600;

interface CacheEntry {
  answer: string;
  citations: CitationDto[];
}

/**
 * 语义缓存（保守档，计划书 P1-12）：FAQ 类高频问题的精确归一化缓存。
 * 从严策略：key 含 deptId（权限隔离）；默认关闭（SEMANTIC_CACHE_ENABLED=false）；
 * 命中需 answers 带引用。向量相似缓存见 README 的进阶说明。
 */
@Injectable()
export class SemanticCacheService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private key(deptId: string, question: string): string {
    return `scache:${deptId}:${createHash('sha1').update(normalize(question)).digest('hex')}`;
  }

  async get(deptId: string, question: string): Promise<CacheEntry | null> {
    const raw = await this.redis.get(this.key(deptId, question));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  async put(deptId: string, question: string, entry: CacheEntry): Promise<void> {
    await this.redis.set(this.key(deptId, question), JSON.stringify(entry), 'EX', CACHE_TTL_SEC);
  }
}

function normalize(q: string): string {
  return q.trim().replace(/\s+/g, ' ').toLowerCase();
}

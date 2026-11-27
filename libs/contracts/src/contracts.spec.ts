import { describe, expect, it } from 'vitest';
import { ALLOWED_EXT, MIME_EXT, OCTET_STREAM, extForMime, isAllowedMime } from './mime';
import { CHARS_PER_TOKEN, estimateTokens } from './text';
import { monthStartUtc8 } from './time';

describe('estimateTokens（唯一口径，#33）', () => {
  it('与历史实现逐字一致：ceil(chars / 1.6)', () => {
    for (const chars of [0, 1, 100, 1234, 1_000_000]) {
      expect(estimateTokens(chars)).toBe(Math.ceil(chars / 1.6));
    }
    expect(CHARS_PER_TOKEN).toBe(1.6);
  });
});

describe('MIME 映射（唯一出口，#33）', () => {
  it('每个 MIME 推出的扩展名都在允许集合内', () => {
    for (const ext of Object.values(MIME_EXT)) {
      expect(ALLOWED_EXT.has(ext)).toBe(true);
    }
  });

  it('octet-stream 放行（按扩展名兜底），未知类型拒绝', () => {
    expect(isAllowedMime(OCTET_STREAM)).toBe(true);
    expect(isAllowedMime('text/markdown')).toBe(true);
    expect(isAllowedMime('image/png')).toBe(false);
    expect(isAllowedMime('')).toBe(false);
  });

  it('text/plain 统一映射为 .txt（原先 api 侧 .txt、worker 侧 .md）', () => {
    expect(extForMime('text/plain')).toBe('.txt');
    expect(extForMime('text/markdown')).toBe('.md');
    expect(extForMime('image/png')).toBe('');
  });
});

describe('monthStartUtc8（统一月初口径，#33）', () => {
  it('返回 UTC+8 的当月 1 日 00:00', () => {
    expect(monthStartUtc8(new Date('2026-11-15T10:00:00Z')).toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });

  it('日界线按 UTC+8 判定：北京 11-01 00:30 属于 11 月', () => {
    expect(monthStartUtc8(new Date('2026-10-31T16:30:00Z')).toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });

  it('北京 10-31 23:30 仍属于 10 月', () => {
    expect(monthStartUtc8(new Date('2026-10-31T15:30:00Z')).toISOString()).toBe('2026-09-30T16:00:00.000Z');
  });
});

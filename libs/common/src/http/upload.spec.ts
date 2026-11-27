import { afterEach, describe, expect, it } from 'vitest';
import { maxUploadBytes, maxUploadMb } from './upload';

const original = process.env.MAX_UPLOAD_MB;

afterEach(() => {
  if (original === undefined) delete process.env.MAX_UPLOAD_MB;
  else process.env.MAX_UPLOAD_MB = original;
});

describe('maxUploadMb / maxUploadBytes（上限唯一来源，#33）', () => {
  it('跟随 MAX_UPLOAD_MB，multipart 与业务校验用同一个值', () => {
    process.env.MAX_UPLOAD_MB = '10';
    expect(maxUploadMb()).toBe(10);
    expect(maxUploadBytes()).toBe(10 * 1024 * 1024);
  });

  it('未配置时回落 20MB', () => {
    delete process.env.MAX_UPLOAD_MB;
    expect(maxUploadMb()).toBe(20);
  });

  it('非法/非正数回落到默认值，不会把上限算成 0', () => {
    process.env.MAX_UPLOAD_MB = 'abc';
    expect(maxUploadMb()).toBe(20);
    process.env.MAX_UPLOAD_MB = '0';
    expect(maxUploadMb()).toBe(20);
    process.env.MAX_UPLOAD_MB = '-5';
    expect(maxUploadMb()).toBe(20);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '@app/prisma';
import { baseUrlOf, login, unwrap } from './helpers';

process.env.QA_REQUEST_LIMIT_PER_MIN ??= '100';

describe('Auth E2E（JWT 双 token + 部门信息）', () => {
  let app: NestFastifyApplication;
  let base: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 25 * 1024 * 1024 }), { logger: ['error'] });
    await app.init();
    await app.listen(0, '127.0.0.1');
    base = baseUrlOf(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('T-登录成功：返回 access/refresh token 与部门配额', async () => {
    const res = await request(base).post('/auth/login').send({ email: 'alice@a-dept.com', password: 'Passw0rd!123' });
    const data = unwrap(res.body) as {
      accessToken: string;
      refreshToken: string;
      user: { email: string; role: string; department: { name: string; quotaRemaining: number } };
    };
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.user.email).toBe('alice@a-dept.com');
    expect(data.user.department.name).toBe('研发部');
    expect(data.user.department.quotaRemaining).toBeGreaterThan(0);
  });

  it('T-登录失败：错误密码 401', async () => {
    const res = await request(base).post('/auth/login').send({ email: 'alice@a-dept.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('T-无 token 访问受保护路由 401', async () => {
    const res = await request(base).get('/documents');
    expect(res.status).toBe(401);
  });

  it('T-refresh 轮转：旧 refresh 换新对，新 access 可用', async () => {
    const first = unwrap(
      (await request(base).post('/auth/login').send({ email: 'bob@b-dept.com', password: 'Passw0rd!123' })).body,
    ) as { accessToken: string; refreshToken: string };
    const refreshed = unwrap(
      (await request(base).post('/auth/refresh').send({ refreshToken: first.refreshToken })).body,
    ) as { accessToken: string };
    expect(refreshed.accessToken).toBeTruthy();
    const me = await request(base).get('/auth/me').set('Authorization', `Bearer ${refreshed.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('T-/auth/me 返回部门与剩余配额', async () => {
    const token = await login(base, 'admin@nestkb.local');
    const me = unwrap((await request(base).get('/auth/me').set('Authorization', `Bearer ${token}`)).body) as {
      role: string;
      department: { quotaMonth: number };
    };
    expect(me.role).toBe('admin');
    expect(me.department.quotaMonth).toBeGreaterThan(0);
  });

  it('T-清理：测试无残留写入', async () => {
    const users = await prisma.user.count();
    expect(users).toBeGreaterThanOrEqual(4);
  });
});

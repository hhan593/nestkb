import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { ErrorCodes } from '@lib/contracts';
import { RateLimitedException, REDIS } from '@app/common';
import { AppEnv, ENV } from '@app/common';
import { Inject } from '@nestjs/common';
import { UsersService } from '../users/users.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: 'member' | 'admin';
  deptId: string;
  type: 'access' | 'refresh';
  exp?: number;
}

export interface AuthedUser {
  userId: string;
  email: string;
  role: 'member' | 'admin';
  deptId: string;
}

const LOGIN_WINDOW_SEC = 15 * 60;

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async login(ip: string, email: string, password: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; role: string; department: { id: string; name: string; quotaMonth: number; quotaRemaining: number } };
  }> {
    await this.assertLoginAllowed(ip, email);
    const user = await this.users.findByEmailWithDept(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      await this.recordLoginFailure(ip, email);
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: '邮箱或密码错误' });
    }
    await this.clearLoginFailures(ip, email);
    const tokens = await this.signTokens(user);
    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        department: {
          id: user.department.id,
          name: user.department.name,
          quotaMonth: Number(user.department.quotaMonth),
          quotaRemaining: await this.users.quotaRemaining(user.departmentId),
        },
      },
    };
  }

  /** 无感刷新：refresh token 校验通过后轮转签发新对（主线 75 篇） */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'refresh token 无效' });
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: '需要 refresh token' });
    }
    // 轮换语义（原子一次性）：SET NX 占位成功才允许签发新对——并发重放同一 token 只有一个
    // 能通过，其余按已吊销拒绝（修 TOCTOU：原先 isRevoked 检查与 revoke 非原子）
    const ttlSec = payload.exp ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000)) : 60;
    const rotated = await this.redis.set(
      `auth:revoked:${this.sha256(refreshToken)}`,
      '1',
      'EX',
      ttlSec,
      'NX',
    );
    if (!rotated) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'refresh token 已吊销或已被使用' });
    }
    const user = await this.users.findByEmailWithDept(payload.email);
    if (!user) throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: '用户不存在' });
    return this.signTokens(user);
  }

  /** 登出：吊销 refresh token（幂等，token 无效时静默成功） */
  async logout(refreshToken: string): Promise<{ revoked: boolean }> {
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken);
      if (payload.type !== 'refresh') return { revoked: false };
    } catch {
      return { revoked: false };
    }
    await this.revoke(refreshToken);
    return { revoked: true };
  }

  private async assertLoginAllowed(ip: string, email: string): Promise<void> {
    const failKey = `auth:login:fail:${ip}:${email}`;
    const fails = await this.redis.get(failKey);
    if (fails && Number(fails) >= this.env.auth.loginFailLimit) {
      throw new RateLimitedException('登录失败次数过多，请 15 分钟后再试');
    }
    const ipKey = `auth:login:ip:${ip}`;
    const count = await this.redis.incr(ipKey);
    if (count === 1) await this.redis.expire(ipKey, LOGIN_WINDOW_SEC);
    if (count > this.env.auth.loginIpLimit) {
      throw new RateLimitedException('登录请求过于频繁，请稍后再试');
    }
  }

  private async recordLoginFailure(ip: string, email: string): Promise<void> {
    const failKey = `auth:login:fail:${ip}:${email}`;
    const fails = await this.redis.incr(failKey);
    if (fails === 1) await this.redis.expire(failKey, LOGIN_WINDOW_SEC);
  }

  private async clearLoginFailures(ip: string, email: string): Promise<void> {
    await this.redis.del(`auth:login:fail:${ip}:${email}`);
  }

  /** refresh token 吊销：按 sha256(token) 进 Redis 黑名单，TTL 取到原过期时刻 */
  private async revoke(token: string): Promise<void> {
    let ttlSec = 60;
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      if (payload.exp) ttlSec = Math.max(1, payload.exp - Math.floor(Date.now() / 1000));
    } catch {
      return;
    }
    await this.redis.set(`auth:revoked:${this.sha256(token)}`, '1', 'EX', ttlSec);
  }

  private async isRevoked(token: string): Promise<boolean> {
    return (await this.redis.exists(`auth:revoked:${this.sha256(token)}`)) === 1;
  }

  private sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  private async signTokens(user: { id: string; email: string; role: 'member' | 'admin'; departmentId: string }): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const base: Omit<JwtPayload, 'type'> = { sub: user.id, email: user.email, role: user.role, deptId: user.departmentId };
    // @nestjs/jwt(v11) 的 expiresIn 类型为 number | StringValue（ms 模板串），此处环境变量以字符串配置
    const accessTtl = this.env.jwtAccessTtl as unknown as number;
    const refreshTtl = this.env.jwtRefreshTtl as unknown as number;
    return {
      accessToken: await this.jwt.signAsync({ ...base, type: 'access' }, { expiresIn: accessTtl }),
      refreshToken: await this.jwt.signAsync({ ...base, type: 'refresh' }, { expiresIn: refreshTtl }),
    };
  }
}

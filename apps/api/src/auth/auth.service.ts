import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { ErrorCodes } from '@lib/contracts';
import { AppEnv, ENV } from '@app/common';
import { Inject } from '@nestjs/common';
import { UsersService } from '../users/users.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: 'member' | 'admin';
  deptId: string;
  type: 'access' | 'refresh';
}

export interface AuthedUser {
  userId: string;
  email: string;
  role: 'member' | 'admin';
  deptId: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async login(email: string, password: string): Promise<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; email: string; role: string; department: { id: string; name: string; quotaMonth: number; quotaRemaining: number } };
  }> {
    const user = await this.users.findByEmailWithDept(email);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: '邮箱或密码错误' });
    }
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
    const user = await this.users.findByEmailWithDept(payload.email);
    if (!user) throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: '用户不存在' });
    return this.signTokens(user);
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

import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { ErrorCodes } from '@lib/contracts';
import type { AuthedUser, JwtPayload } from '../auth.service';

export const IS_PUBLIC_KEY = 'isPublic';
/** 标记公开路由（如 POST /auth/login） */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthedUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: '缺少 Bearer token' });
    }
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: 'token 无效或已过期' });
    }
    if (payload.type !== 'access') {
      throw new UnauthorizedException({ code: ErrorCodes.UNAUTHORIZED, message: '需要 access token' });
    }
    req.user = { userId: payload.sub, email: payload.email, role: payload.role, deptId: payload.deptId };
    return true;
  }
}

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCodes } from '@lib/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthedUser } from '../auth.service';

export const ROLES_KEY = 'roles';
/** 角色白名单（如 'admin'） */
export const Roles = (...roles: Array<'member' | 'admin'>): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Array<'member' | 'admin'>>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthedUser }>();
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ForbiddenException({ code: ErrorCodes.FORBIDDEN, message: '需要管理员权限' });
    }
    return true;
  }
}

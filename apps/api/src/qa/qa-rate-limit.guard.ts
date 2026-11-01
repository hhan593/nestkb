import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AppEnv, ENV, RateLimitedException, REDIS } from '@app/common';
import type Redis from 'ioredis';
import type { AuthedUser } from '../auth/auth.service';

/** 用户级限流（计划书 36 篇 + QA_REQUEST_LIMIT_PER_MIN）：Redis INCR + 60s 滑窗 */
@Injectable()
export class QaRateLimitGuard implements CanActivate {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthedUser }>();
    const user = req.user;
    if (!user) return true;
    const key = `qa:rl:${user.userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 60);
    if (count > this.env.qa.rateLimitPerMin) {
      throw new RateLimitedException(`每分钟最多 ${this.env.qa.rateLimitPerMin} 次提问，请稍后再试`);
    }
    return true;
  }
}

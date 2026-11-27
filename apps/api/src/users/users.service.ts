import { Injectable, NotFoundException } from '@nestjs/common';
import { monthStartUtc8 } from '@lib/contracts';
import { PrismaService } from '@app/prisma';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmailWithDept(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      include: { department: true },
    });
  }

  /** 部门月配额剩余（元）：quota_month - 本月 usage 合计 */
  async quotaRemaining(deptId: string): Promise<number> {
    const dept = await this.prisma.department.findUniqueOrThrow({ where: { id: deptId } });
    const agg = await this.prisma.usageRecord.aggregate({
      _sum: { costEstimated: true },
      where: { deptId, createdAt: { gte: monthStartUtc8() } },
    });
    return Number((Number(dept.quotaMonth) - Number(agg._sum.costEstimated ?? 0)).toFixed(4));
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { department: true },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      department: {
        id: user.department.id,
        name: user.department.name,
        quotaMonth: Number(user.department.quotaMonth),
        quotaRemaining: await this.quotaRemaining(user.departmentId),
      },
    };
  }
}

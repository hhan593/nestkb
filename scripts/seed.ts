/**
 * seed：两部门 + 四账号 + 评测集骨架（计划书 5.4）。
 * 运行：pnpm seed（需先 prisma migrate）
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { loadDotenvFile, parseEnv } from '../libs/common/src/config/env';

loadDotenvFile();
const env = parseEnv(process.env);
void env;

const prisma = new PrismaClient();
const PASSWORD = 'Passw0rd!123';

async function main(): Promise<void> {
  const deptA = await prisma.department.upsert({
    where: { name: '研发部' },
    update: {},
    create: { name: '研发部', quotaMonth: 50 },
  });
  const deptB = await prisma.department.upsert({
    where: { name: '人事部' },
    update: {},
    create: { name: '人事部', quotaMonth: 50 },
  });

  const hash = await bcrypt.hash(PASSWORD, 10);
  const users = [
    { email: 'alice@a-dept.com', deptId: deptA.id, role: 'member' as const },
    { email: 'admin@nestkb.local', deptId: deptA.id, role: 'admin' as const },
    { email: 'bob@b-dept.com', deptId: deptB.id, role: 'member' as const },
    { email: 'carol@b-dept.com', deptId: deptB.id, role: 'member' as const },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { passwordHash: hash, role: u.role },
      create: { email: u.email, passwordHash: hash, departmentId: u.deptId, role: u.role },
    });
  }

  // 评测集骨架：fact / table / timeliness / deny 四类（goldMarkers 与 samples/corpus 锚点对应）
  const evalCases = [
    { question: '员工试用期考核不通过怎么处理？', caseType: 'fact' as const, goldAnswer: '延长试用或依法解除劳动合同', goldMarkers: ['延长试用或依法解除劳动合同'] },
    { question: '差旅住宿标准中西部地区的上限是多少？', caseType: 'table' as const, goldAnswer: '详见差旅住宿标准表', goldMarkers: ['西部'] },
    { question: '年假一共有多少天？', caseType: 'fact' as const, goldAnswer: '按工龄 5/10/15 天', goldMarkers: ['年假'] },
    { question: '报销单据需要在多少天内提交？', caseType: 'fact' as const, goldAnswer: '30 天', goldMarkers: ['报销单据须在费用发生后 30 天内提交'] },
    { question: '代码评审需要几个人批准？', caseType: 'fact' as const, goldAnswer: '至少 1 名高级工程师', goldMarkers: ['至少一名高级工程师批准'] },
    { question: '生产环境发布需要什么审批？', caseType: 'fact' as const, goldAnswer: '技术负责人审批 + 灰度', goldMarkers: ['技术负责人审批', '灰度'] },
    { question: '产假的法定天数是多少？', caseType: 'fact' as const, goldAnswer: '158 天', goldMarkers: ['产假 158 天'] },
    { question: '试用期社保从什么时候开始缴纳？', caseType: 'fact' as const, goldAnswer: '入职当月起', goldMarkers: ['入职当月起缴纳'] },
    { question: '旧版考勤制度下迟到怎么扣款？', caseType: 'timeliness' as const, goldAnswer: null, goldMarkers: ['旧版考勤制度'] },
    { question: '公司 2027 年的营收目标是多少？', caseType: 'deny' as const, goldAnswer: null, goldMarkers: [], expectDeny: true },
    { question: '公司市值现在是多少？', caseType: 'deny' as const, goldAnswer: null, goldMarkers: [], expectDeny: true },
    { question: '量子计算部门的预算规模是多少？', caseType: 'deny' as const, goldAnswer: null, goldMarkers: [], expectDeny: true },
  ];
  let evalCount = 0;
  for (const c of evalCases) {
    const exists = await prisma.evalCase.findFirst({ where: { question: c.question } });
    if (!exists) {
      await prisma.evalCase.create({
        data: {
          question: c.question,
          caseType: c.caseType,
          goldAnswer: c.goldAnswer,
          goldChunkIds: [],
          goldMarkers: c.goldMarkers,
          source: 'manual',
          expectDeny: c.expectDeny ?? false,
        },
      });
      evalCount++;
    }
  }

  console.log('seed 完成：');
  console.log(`  部门：研发部(${deptA.id}) 人事部(${deptB.id})`);
  console.log(`  账号：${users.map((u) => u.email).join(', ')}  密码统一：${PASSWORD}`);
  console.log(`  评测集：新增 ${evalCount} 条（共 ${evalCases.length} 条）`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

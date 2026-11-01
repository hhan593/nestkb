/**
 * 生产运行时别名注册：nest build(tsc) 不会改写 @lib/@app 导入，
 * 编译产物在 dist/apps/<app>/ 下保留了 libs/ 结构，这里按目录注册解析。
 * 用法：node -r ./scripts/runtime-paths.js dist/apps/api/apps/api/src/main.js
 */
const path = require('path');
const { register } = require('tsconfig-paths');

const distApp = process.env.NESTKB_DIST || path.join(__dirname, '..', 'dist', 'apps', 'api');

register({
  baseUrl: distApp,
  paths: {
    '@lib/contracts': ['libs/contracts/src'],
    '@lib/contracts/*': ['libs/contracts/src/*'],
    '@lib/llm': ['libs/llm/src'],
    '@lib/llm/*': ['libs/llm/src/*'],
    '@lib/chunker': ['libs/chunker/src'],
    '@lib/chunker/*': ['libs/chunker/src/*'],
    '@lib/prompts': ['libs/prompts/src'],
    '@lib/prompts/*': ['libs/prompts/src/*'],
    '@lib/vector-store': ['libs/vector-store/src'],
    '@lib/vector-store/*': ['libs/vector-store/src/*'],
    '@app/common': ['libs/common/src'],
    '@app/common/*': ['libs/common/src/*'],
    '@app/prisma': ['libs/prisma/src'],
    '@app/prisma/*': ['libs/prisma/src/*'],
  },
});

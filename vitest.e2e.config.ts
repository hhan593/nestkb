import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    // NestJS 依赖 emitDecoratorMetadata（esbuild 不支持），e2e 需要 SWC 转译
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    environment: 'node',
    include: ['apps/**/*.e2e-spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});

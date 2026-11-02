import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['libs/**/*.spec.ts', 'apps/**/*.spec.ts'],
    // apps/web 的 .tsx 渲染器测试需要 jsx —— tsconfig include 已覆盖；esbuild 按 JSX 解析 .tsx 自动
    exclude: ['**/*.e2e-spec.ts', 'node_modules/**', 'dist/**'],
  },
});

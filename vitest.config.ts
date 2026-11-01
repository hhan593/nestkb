import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['libs/**/*.spec.ts', 'apps/**/*.spec.ts'],
    exclude: ['**/*.e2e-spec.ts', 'node_modules/**', 'dist/**'],
  },
});

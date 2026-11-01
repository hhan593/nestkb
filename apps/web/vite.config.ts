import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期：/auth /documents /qa /messages /admin 代理到 NestJS API（:3000）
// 生产期：构建产物由 API 进程静态托管（同源），无需代理
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['auth', 'documents', 'qa', 'messages', 'admin'].map((p) => [`/${p}`, 'http://localhost:3000']),
    ),
  },
  build: { outDir: 'dist', sourcemap: false },
});

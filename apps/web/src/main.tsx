import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { installGlobalErrorHandlers } from './lib/global-errors';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GlobalErrorBanner } from './components/GlobalErrorBanner';
import './styles.css';

// 兜底必须在渲染前挂上：首屏拉取（/auth/me、会话列表）的 rejection 也要有人提示
installGlobalErrorHandlers();

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    {/* 后端在根路径托管 SPA（web-ui.controller.ts），路由不加 basename，避免 401 跳转 /login 落到路由器之外 */}
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary>
          <App />
          <GlobalErrorBanner />
        </ErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

declare global {
  interface Window { __boot?: string[] }
}

window.__boot = ['module-exec'];
const root = ReactDOM.createRoot(document.getElementById('root')!);
window.__boot.push('root-created');
root.render(
  <React.StrictMode>
    {/* 后端在根路径托管 SPA（web-ui.controller.ts），路由不加 basename，避免 401 跳转 /login 落到路由器之外 */}
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
window.__boot.push('render-called');
requestAnimationFrame(() => {
  window.__boot?.push('raf-root-len=' + document.getElementById('root')!.innerHTML.length);
});

import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Chat from './pages/Chat';
import Documents from './pages/Documents';
import { Layout } from './components/Layout';

// 管理端三页不在首屏路径上：拆成独立 chunk，普通用户永远不需要下载它们（#35）
const Usage = lazy(() => import('./pages/Usage'));
const RetrievalDebug = lazy(() => import('./pages/RetrievalDebug'));
const Eval = lazy(() => import('./pages/Eval'));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="login-wrap">
        <div className="spinner" />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  if (me?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** 懒加载页面的占位：与 RequireAuth 的 loading 保持视觉一致 */
function PageFallback() {
  return (
    <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}>
      <div className="spinner" />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Chat />} />
        <Route path="documents" element={<Documents />} />
        <Route
          path="admin/usage"
          element={
            <RequireAdmin>
              <Suspense fallback={<PageFallback />}>
                <Usage />
              </Suspense>
            </RequireAdmin>
          }
        />
        <Route
          path="admin/retrieval"
          element={
            <RequireAdmin>
              <Suspense fallback={<PageFallback />}>
                <RetrievalDebug />
              </Suspense>
            </RequireAdmin>
          }
        />
        <Route
          path="admin/eval"
          element={
            <RequireAdmin>
              <Suspense fallback={<PageFallback />}>
                <Eval />
              </Suspense>
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Chat from './pages/Chat';
import Documents from './pages/Documents';
import Usage from './pages/Usage';
import RetrievalDebug from './pages/RetrievalDebug';
import Eval from './pages/Eval';
import { Layout } from './components/Layout';

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
              <Usage />
            </RequireAdmin>
          }
        />
        <Route
          path="admin/retrieval"
          element={
            <RequireAdmin>
              <RetrievalDebug />
            </RequireAdmin>
          }
        />
        <Route
          path="admin/eval"
          element={
            <RequireAdmin>
              <Eval />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

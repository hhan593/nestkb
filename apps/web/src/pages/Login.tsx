import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { login, me } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) {
    navigate('/', { replace: true });
    return null;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="login-brand">
          <div className="brand-mark" style={{ width: 38, height: 38, fontSize: 18 }}>
            K
          </div>
          <div>
            <div style={{ fontWeight: 650, fontSize: 17 }}>NestKB</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Enterprise Knowledge Base</div>
          </div>
        </div>
        <h1 className="login-title">登录知识库</h1>
        <p className="login-sub">按部门隔离权限，回答带引用溯源</p>
        <form className="login-form" onSubmit={submit}>
          <div>
            <label className="field-label" htmlFor="email">邮箱</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="username"
              placeholder="alice@a-dept.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="password">密码</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy} style={{ justifyContent: 'center' }}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
        {import.meta.env.DEV && (
          <div className="login-hint">
            种子账号（pnpm seed 生成，密码 <code>Passw0rd!123</code>）：
            <br />
            <code>alice@a-dept.com</code> 研发部成员 · <code>admin@nestkb.local</code> 管理员
            <br />
            <code>bob@b-dept.com</code> / <code>carol@b-dept.com</code> 人事部成员
          </div>
        )}
      </div>
    </div>
  );
}

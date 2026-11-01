import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BookOpenText, MessageSquareText, LogOut, ScrollText, FlaskConical, Gauge } from 'lucide-react';
import { useAuth } from '../lib/auth';

const NAV = [
  { to: '/', label: '知识库问答', icon: MessageSquareText },
  { to: '/documents', label: '文档管理', icon: BookOpenText },
];

const ADMIN_NAV = [
  { to: '/admin/usage', label: '成本看板', icon: Gauge },
  { to: '/admin/retrieval', label: '检索调试', icon: ScrollText },
  { to: '/admin/eval', label: '评估回归', icon: FlaskConical },
];

export function Layout() {
  const { me, logout, refreshMe } = useAuth();
  const navigate = useNavigate();
  const [quotaPct, setQuotaPct] = useState(0);

  useEffect(() => {
    if (!me) return;
    const used = me.department.quotaMonth - me.department.quotaRemaining;
    setQuotaPct(me.department.quotaMonth > 0 ? Math.min(100, (used / me.department.quotaMonth) * 100) : 0);
    // 问答后配额变化：路由切换时轻量刷新
    const timer = setInterval(() => void refreshMe(), 30_000);
    return () => clearInterval(timer);
  }, [me, refreshMe]);

  if (!me) return null;
  const used = me.department.quotaMonth - me.department.quotaRemaining;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">K</div>
          <div>
            <div className="brand-name">NestKB</div>
            <div className="brand-sub">企业知识库问答</div>
          </div>
        </div>

        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <n.icon />
              <span>{n.label}</span>
            </NavLink>
          ))}
          {me.role === 'admin' && (
            <>
              <div className="nav-label">管理端</div>
              {ADMIN_NAV.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                  <n.icon />
                  <span>{n.label}</span>
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div className="sidebar-foot">
          <div className="quota-line">
            <span>本月已用（元）</span>
            <span className="num">{used.toFixed(2)} / {me.department.quotaMonth.toFixed(0)}</span>
          </div>
          <div className="quota-bar">
            <div style={{ width: `${quotaPct}%` }} />
          </div>
          <div className="user-line">
            <div className="user-avatar">{me.email[0].toUpperCase()}</div>
            <div>
              <div className="user-name">{me.email.split('@')[0]}</div>
              <div className="user-dept">
                {me.department.name} · {me.role === 'admin' ? '管理员' : '成员'}
              </div>
            </div>
            <button
              className="logout-btn"
              title="退出登录"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              <LogOut />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

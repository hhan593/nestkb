import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, loadTokens, saveTokens, UNAUTHORIZED_EVENT, type Me, type Tokens } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    if (!loadTokens()) {
      setMe(null);
      return;
    }
    try {
      setMe(await api<Me>('/auth/me'));
    } catch (err) {
      // 仅在 token 确认失效（401）时清空登录态；网络抖动 / 5xx 保留当前状态，避免误踢用户
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 401) {
        setMe(null);
      }
    }
  }, []);

  useEffect(() => {
    void refreshMe().finally(() => setLoading(false));
  }, [refreshMe]);

  useEffect(() => {
    const onUnauthorized = () => setMe(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ accessToken: string; refreshToken: string; user: Me }>('/auth/login', {
      body: { email, password },
    });
    const tokens: Tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken };
    saveTokens(tokens);
    setMe(data.user);
  }, []);

  const logout = useCallback(() => {
    const tokens = loadTokens();
    // 尽力通知服务端吊销 refresh token；失败不阻塞本地登出
    if (tokens?.refreshToken) {
      void fetch('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      }).catch(() => undefined);
    }
    saveTokens(null);
    setMe(null);
  }, []);

  const value = useMemo(() => ({ me, loading, login, logout, refreshMe }), [me, loading, login, logout, refreshMe]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

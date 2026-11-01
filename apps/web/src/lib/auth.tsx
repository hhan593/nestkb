import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, loadTokens, saveTokens, type Me, type Tokens } from './api';

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
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void refreshMe().finally(() => setLoading(false));
  }, [refreshMe]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ accessToken: string; refreshToken: string; user: Me }>('/auth/login', {
      body: { email, password },
    });
    const tokens: Tokens = { accessToken: data.accessToken, refreshToken: data.refreshToken };
    saveTokens(tokens);
    setMe(data.user);
  }, []);

  const logout = useCallback(() => {
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

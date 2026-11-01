/** API 客户端：统一包裹 { code, data, requestId }；401 自动用 refreshToken 无感刷新重放 */

const TOKEN_KEY = 'nestkb.tokens';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface Me {
  id: string;
  email: string;
  role: 'member' | 'admin';
  department: { id: string; name: string; quotaMonth: number; quotaRemaining: number };
}

export function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

export function saveTokens(t: Tokens | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let refreshing: Promise<Tokens | null> | null = null;

async function refreshTokens(): Promise<Tokens | null> {
  const cur = loadTokens();
  if (!cur?.refreshToken) return null;
  const res = await fetch('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: cur.refreshToken }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { code: number; data?: { accessToken: string; refreshToken: string } };
  if (body.code !== 0 || !body.data) return null;
  const next: Tokens = body.data;
  saveTokens(next);
  return next;
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; formData?: FormData; retry?: boolean } = {},
): Promise<T> {
  const tokens = loadTokens();
  const headers: Record<string, string> = {};
  if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined || opts.formData ? 'POST' : 'GET'),
    headers,
    body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });

  if (res.status === 401 && opts.retry !== false && tokens) {
    refreshing ??= refreshTokens().finally(() => {
      refreshing = null;
    });
    const next = await refreshing;
    if (next) return api<T>(path, { ...opts, retry: false });
    saveTokens(null);
    window.location.href = '/login';
    throw new ApiError(401, 'UNAUTHORIZED', '登录已过期，请重新登录');
  }

  const body = (await res.json().catch(() => ({}))) as { code?: number | string; data?: T; message?: string };
  if (res.ok && body.code === 0) return body.data as T;
  throw new ApiError(res.status, String(body.code ?? 'INTERNAL_ERROR'), body.message ?? `请求失败（${res.status}）`);
}

/** 问答专用：流式 POST，返回原始 Response 供 SSE 解析（401 不在此重试，见 sse.ts） */
export async function apiStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const tokens = loadTokens();
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(tokens ? { Authorization: `Bearer ${tokens.accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  return res;
}

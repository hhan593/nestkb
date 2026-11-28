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

/** 刷新彻底失败（token 确认失效）时广播，AuthContext 监听后在路由内跳登录页 */
export const UNAUTHORIZED_EVENT = 'nestkb:unauthorized';

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
  // 网络层错误（断网/后端重启）不能上抛原始 TypeError：并发等待刷新的请求会集体收到英文报错，
  // 且跳过 saveTokens(null) 导致登录态残留、后续每个请求都重复失败刷新
  let res: Response;
  try {
    res = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: cur.refreshToken }),
    });
  } catch {
    return null; // 网络异常视为刷新失败：调用方按未登录处理并跳转 /login
  }
  if (!res.ok) {
    // 其他标签页可能已用更新的 refreshToken 完成轮换；若本地 token 已被别处替换，直接采用
    const now = loadTokens();
    if (now && now.refreshToken !== cur.refreshToken) return now;
    return null;
  }
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
    // 刷新失败但本地 token 已被其他标签页轮换 → 用新 token 重放，而不是误杀登录态
    const now = loadTokens();
    if (now && now.refreshToken !== tokens.refreshToken) {
      return api<T>(path, { ...opts, retry: false });
    }
    saveTokens(null);
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError(401, 'UNAUTHORIZED', '登录已过期，请重新登录');
  }

  const body = (await res.json().catch(() => ({}))) as { code?: number | string; data?: T; message?: string };
  if (res.ok && body.code === 0) return body.data as T;
  throw new ApiError(res.status, String(body.code ?? 'INTERNAL_ERROR'), body.message ?? `请求失败（${res.status}）`);
}

/**
 * 问答专用：流式 POST，返回原始 Response 供 SSE 解析。
 *
 * accessToken 只有 2h：不为流式请求做刷新重放的话，token 一过期提问就永久失败（页面看着还登录着）。
 * 刷新逻辑与 api() 共用同一个 refreshing 单例，避免并发刷新把 refreshToken 轮换两次。
 */
export async function apiStream(path: string, body: unknown, signal?: AbortSignal, retry = true): Promise<Response> {
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

  if (res.status === 401 && retry && tokens) {
    refreshing ??= refreshTokens().finally(() => {
      refreshing = null;
    });
    const next = await refreshing;
    if (next) return apiStream(path, body, signal, false);
    // 其他标签页可能已轮换过 refreshToken：本地 token 变了就用新 token 重放，别误杀登录态
    const now = loadTokens();
    if (now && now.refreshToken !== tokens.refreshToken) return apiStream(path, body, signal, false);
    saveTokens(null);
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  return res;
}

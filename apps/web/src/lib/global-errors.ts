/**
 * 全局未捕获异常兜底。
 *
 * 项目里到处是 `void someAsync()`（列表刷新、配额刷新等），一旦 rejection 没被接住，
 * 浏览器只往控制台丢一行，用户侧完全无感 —— 页面看着正常，实际数据没更新（#29）。
 */

export const GLOBAL_ERROR_EVENT = 'nestkb:global-error';

export interface GlobalErrorDetail {
  message: string;
  /** 已知失败动作时提供重试入口（#59-11），横幅点击"重试"后再次执行 */
  retry?: () => void;
}

export function notifyGlobalError(message: string, retry?: () => void): void {
  window.dispatchEvent(new CustomEvent<GlobalErrorDetail>(GLOBAL_ERROR_EVENT, { detail: { message, retry } }));
}

function isAbort(err: unknown): boolean {
  // 用户点"停止生成"、切会话都会 abort：这是预期行为，不该弹提示
  return err instanceof Error && err.name === 'AbortError';
}

/** 只注册一次的全局兜底；在 ReactDOM 渲染前调用 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    if (isAbort(reason)) return;
    console.error('[unhandledrejection]', reason);
    notifyGlobalError(reason instanceof Error ? reason.message : '操作失败，请重试');
  });
}

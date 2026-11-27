import { useEffect, useState } from 'react';
import { CircleAlert, X } from 'lucide-react';
import { GLOBAL_ERROR_EVENT, type GlobalErrorDetail } from '../lib/global-errors';

/** 全局未捕获异常的兜底提示：4 秒自动消失，不阻塞操作（ErrorBoundary 只覆盖渲染期异常） */
export function GlobalErrorBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onError = (ev: Event): void => {
      setMessage((ev as CustomEvent<GlobalErrorDetail>).detail?.message ?? '操作失败，请重试');
    };
    window.addEventListener(GLOBAL_ERROR_EVENT, onError);
    return () => window.removeEventListener(GLOBAL_ERROR_EVENT, onError);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message) return null;
  return (
    <div
      className="alert-banner alert-critical"
      style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 90, maxWidth: 560 }}
    >
      <CircleAlert />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{message}</span>
        <button className="icon-btn" title="关闭" onClick={() => setMessage(null)}>
          <X />
        </button>
      </div>
    </div>
  );
}

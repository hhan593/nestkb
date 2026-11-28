import { useEffect, useState } from 'react';
import { CircleAlert, X } from 'lucide-react';
import { GLOBAL_ERROR_EVENT, type GlobalErrorDetail } from '../lib/global-errors';

/** 全局未捕获异常兜底：常驻直至用户关闭（#59-11，不再 4 秒自动消失），带重试入口时显示"重试" */
export function GlobalErrorBanner() {
  const [detail, setDetail] = useState<GlobalErrorDetail | null>(null);

  useEffect(() => {
    const onError = (ev: Event): void => {
      setDetail((ev as CustomEvent<GlobalErrorDetail>).detail ?? { message: '操作失败，请重试' });
    };
    window.addEventListener(GLOBAL_ERROR_EVENT, onError);
    return () => window.removeEventListener(GLOBAL_ERROR_EVENT, onError);
  }, []);

  if (!detail) return null;
  return (
    <div
      className="alert-banner alert-critical"
      role="alert"
      style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 90, maxWidth: 640 }}
    >
      <CircleAlert />
      <span style={{ minWidth: 0 }}>{detail.message}</span>
      <div className="alert-actions">
        {detail.retry && (
          <button
            className="btn-retry"
            onClick={() => {
              detail.retry?.();
              setDetail(null);
            }}
          >
            重试
          </button>
        )}
        <button className="btn-retry" title="关闭" aria-label="关闭" onClick={() => setDetail(null)}>
          <X style={{ width: 13, height: 13, display: 'block' }} />
        </button>
      </div>
    </div>
  );
}

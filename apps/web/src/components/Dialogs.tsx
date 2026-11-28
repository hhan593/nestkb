/**
 * 统一对话框（#59-9）：替代原生 window.confirm / window.prompt，
 * 复用台账世界的 overlay/dialog 样式（200ms 过渡），Esc 与点击遮罩均视为取消。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

function useDialogShell(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export function ConfirmDialog(props: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { title, message, confirmLabel = '确认', danger, busy, onConfirm, onClose } = props;
  useDialogShell(onClose);
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog dialog-anim"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{title}</div>
        <div className="dialog-message">{message}</div>
        <div className="dialog-foot">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 单输入对话框（替代 window.prompt）：Enter 提交，空值不提交 */
export function PromptDialog(props: {
  title: string;
  message?: ReactNode;
  fieldLabel: string;
  initialValue?: string;
  inputType?: string;
  placeholder?: string;
  hint?: string;
  submitLabel?: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const { title, message, fieldLabel, initialValue = '', inputType = 'text', placeholder, hint, submitLabel = '提交', busy, onSubmit, onClose } = props;
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useDialogShell(onClose);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const submit = (): void => {
    const v = value.trim();
    if (!v || busy) return;
    onSubmit(v);
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog dialog-anim"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{title}</div>
        {message && <div className="dialog-message">{message}</div>}
        <div className="dialog-form">
          <label className="field-label" htmlFor="prompt-dialog-input">{fieldLabel}</label>
          <input
            id="prompt-dialog-input"
            ref={inputRef}
            className="input"
            type={inputType}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          {hint && <div className="field-hint">{hint}</div>}
        </div>
        <div className="dialog-foot">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !value.trim()} onClick={submit}>
            {busy ? '处理中…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 危险操作确认里的警示行（可选） */
export function DialogWarning({ children }: { children: ReactNode }) {
  return (
    <div className="dialog-warning">
      <CircleAlert style={{ width: 14, height: 14, flex: 'none' }} />
      <span>{children}</span>
    </div>
  );
}

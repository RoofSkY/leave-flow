import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import "./ui.css";

type ButtonVariant = "default" | "primary" | "danger" | "ghost";

export function Button({
  variant = "default",
  size,
  icon,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm";
  /** 아이콘만 있는 정사각형 버튼 (title 로 설명 필수) */
  icon?: boolean;
}) {
  const cls = [
    "btn",
    variant !== "default" && `btn-${variant}`,
    size === "sm" && "btn-sm",
    icon && "btn-icon",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={cls} {...rest} />;
}

export function Field({
  label,
  required,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={["field", className].filter(Boolean).join(" ")}>
      <span className="field-label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={["input", props.className].filter(Boolean).join(" ")} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={["select", props.className].filter(Boolean).join(" ")} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={["textarea", props.className].filter(Boolean).join(" ")} />;
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Badge({
  tone,
  children,
  title,
}: {
  tone?: "accent" | "danger" | "warning" | "success";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={["badge", tone && `badge-${tone}`].filter(Boolean).join(" ")} title={title}>
      {children}
    </span>
  );
}

export function ColorDot({ color }: { color: string }) {
  return <span className="color-dot" style={{ background: color }} aria-hidden />;
}

export function Callout({
  tone,
  children,
}: {
  tone?: "warning" | "danger" | "info";
  children: ReactNode;
}) {
  return <div className={["callout", tone && `callout-${tone}`].filter(Boolean).join(" ")}>{children}</div>;
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}

export function Spinner({ label = "불러오는 중" }: { label?: string }) {
  return (
    <div className="row" role="status">
      <span className="spinner" aria-hidden />
      <span className="muted">{label}</span>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <h1 className="page-title">{title}</h1>
      <span className="spacer" />
      {actions}
      {description && <p className="page-desc">{description}</p>}
    </div>
  );
}

/** 오류 메시지 표시 (쿼리 실패 등) */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <Callout tone="danger">{message}</Callout>;
}

/** 열린 창 순서 (나중에 연 창이 끝). Esc는 맨 위 창만 닫음 */
const modalStack: object[] = [];

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size,
  closeOnOverlay = false,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "lg";
  /** 바깥 클릭으로 닫기 (입력 중인 폼은 기본 false) */
  closeOnOverlay?: boolean;
}) {
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    // 확인 창이 입력 창 위에 뜬 경우 Esc 한 번에 둘 다 닫혀 입력이 사라지지 않도록 맨 위 창만 반응
    const token = {};
    modalStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modalStack[modalStack.length - 1] !== token) return;
      e.stopImmediatePropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={["modal", size && `modal-${size}`].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <span className="spacer" />
          <Button variant="ghost" size="sm" icon onClick={onClose} title="닫기" aria-label="닫기">
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------- 확인 창 ---------- */

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 위험한 작업(취소·삭제·복구 등)은 빨간 버튼 */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  );
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext value={confirm}>
      {children}
      <Modal
        open={!!state}
        size="sm"
        title={state?.title ?? ""}
        onClose={() => close(false)}
        closeOnOverlay
        footer={
          <>
            <Button onClick={() => close(false)}>{state?.cancelLabel ?? "취소"}</Button>
            <Button variant={state?.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
              {state?.confirmLabel ?? "확인"}
            </Button>
          </>
        }
      >
        <div style={{ whiteSpace: "pre-line" }}>{state?.message}</div>
      </Modal>
    </ConfirmContext>
  );
}

/** 되돌리기 어려운 작업 전에: `if (!(await confirm({...}))) return;` */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("ConfirmProvider 안에서 사용하세요.");
  return fn;
}

/* ---------- 토스트 ---------- */

type ToastTone = "info" | "error" | "warning";
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}
type ToastFn = (message: string, tone?: ToastTone) => void;
const ToastContext = createContext<ToastFn | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const toast = useCallback<ToastFn>((message, tone = "info") => {
    const id = nextId.current++;
    setItems((list) => [...list, { id, message, tone }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === "info" ? 3000 : 6000);
  }, []);
  return (
    <ToastContext value={toast}>
      {children}
      {createPortal(
        <div className="toast-stack" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className={["toast", t.tone !== "info" && `toast-${t.tone}`].filter(Boolean).join(" ")}>
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext>
  );
}

/** 짧은 알림: toast("저장했습니다"), toast(err.message, "error") */
export function useToast(): ToastFn {
  const fn = useContext(ToastContext);
  if (!fn) throw new Error("ToastProvider 안에서 사용하세요.");
  return fn;
}

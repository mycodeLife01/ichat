import { ghostBtn, primaryBtn } from "./classes";

type ConfirmDialogProps = {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,20,19,0.4)] p-6"
      onClick={onCancel}
    >
      <div
        className="dialog w-full max-w-[360px] rounded-lg border border-border-strong bg-bg-raised p-[22px]"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="mb-2 text-[15px] font-semibold">{title}</h3>
        <p className="mb-5 text-[13.5px] leading-[1.6] text-fg-muted">{body}</p>
        <div className="flex justify-end gap-2">
          <button className={ghostBtn} onClick={onCancel}>
            取消
          </button>
          <button
            className={primaryBtn}
            style={destructive ? { background: "var(--color-danger)" } : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

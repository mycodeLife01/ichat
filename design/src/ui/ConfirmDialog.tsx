import { useId } from "react";

import { buttonControl, primaryButton, solidDangerButton } from "./classes";
import { ModalDialog } from "./ModalDialog";

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
  const titleId = useId();
  const bodyId = useId();

  return (
    <ModalDialog
      role={destructive ? "alertdialog" : "dialog"}
      titleId={titleId}
      descriptionId={bodyId}
      onClose={onCancel}
      className="w-full max-w-[360px] p-[22px]"
    >
      <h3 id={titleId} className="mb-2 text-[15px] font-semibold">{title}</h3>
      <p id={bodyId} className="mb-5 text-[13.5px] leading-[1.6] text-text-muted">{body}</p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={`${buttonControl} h-9 px-3.5 text-[13px]`}
          data-dialog-initial-focus={destructive ? "" : undefined}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className={`${destructive ? solidDangerButton : primaryButton} h-9 px-3.5 text-[13px] font-medium`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalDialog>
  );
}

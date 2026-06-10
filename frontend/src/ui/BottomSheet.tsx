import type { ReactNode } from "react";
import { createPortal } from "react-dom";

type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

// Mobile bottom action panel. Tapping the backdrop closes it; taps inside the
// panel are stopped so action buttons don't dismiss before their handler runs.
// Portaled to <body> so the fixed-position backdrop spans the full viewport even
// when opened from a transformed ancestor (e.g. the open mobile sidebar, whose
// translateX would otherwise become the containing block and clamp its width).
export function BottomSheet({ open, onClose, children }: BottomSheetProps) {
  if (!open) return null;
  return createPortal(
    <div
      className="sheet-backdrop fixed inset-0 z-40 flex items-end justify-center bg-[rgba(20,20,19,0.32)]"
      onClick={onClose}
    >
      <div
        className="sheet w-full max-w-[480px] animate-sheet-in rounded-t-2xl bg-bg-raised pt-2 pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle mx-auto mb-2.5 h-1 w-9 rounded-full bg-border-strong" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

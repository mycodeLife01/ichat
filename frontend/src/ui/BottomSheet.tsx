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
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

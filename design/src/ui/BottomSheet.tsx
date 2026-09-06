import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  // A sheet opened above an already-dimmed drawer keeps only its click layer.
  dimBackground?: boolean;
};

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Mobile bottom action panel. Tapping the backdrop closes it; taps inside the
// panel are stopped so action buttons don't dismiss before their handler runs.
// Portaled to <body> so the fixed-position backdrop spans the full viewport even
// when opened from a transformed ancestor (e.g. the open mobile sidebar, whose
// translateX would otherwise become the containing block and clamp its width).
export function BottomSheet({
  open,
  onClose,
  ariaLabel,
  children,
  dimBackground = true,
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    const focusableElements = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");

    panel?.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        panel?.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === panel ||
          !panel?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === panel ||
          !panel?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (
        previouslyFocused instanceof HTMLElement &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="sheet-backdrop fixed inset-0 z-40 isolate flex items-end justify-center overflow-x-hidden"
    >
      <div
        className={`sheet-scrim absolute inset-0 ${
          dimBackground ? "bg-overlay" : "bg-transparent"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className="sheet relative z-10 max-h-[calc(100dvh-8px)] w-full max-w-[480px] animate-sheet-in overflow-x-hidden overflow-y-auto rounded-t-card border border-b-0 border-border-strong bg-surface px-2 pt-2 shadow-dialog outline-none pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
      >
        <div
          className="sheet-handle mx-auto mb-2 h-1 w-9 rounded-pill bg-border-strong"
          aria-hidden="true"
        />
        {children}
      </div>
    </div>,
    document.body,
  );
}

import { useEffect } from "react";

import type { ToastState } from "./state";

type ToastProps = {
  toast: ToastState;
  onDismiss: () => void;
  duration?: number;
};

// A single, auto-dismissing status toast. The component is keyed on toast.id by
// the effect dependency, so a new toast (even with the same message) clears the
// previous timer and restarts the countdown.
export function Toast({ toast, onDismiss, duration = 2600 }: ToastProps) {
  const id = toast?.id;

  useEffect(() => {
    if (id == null) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [id, duration, onDismiss]);

  if (toast == null) return null;
  return (
    <div className="toast" role="status">
      {toast.message}
    </div>
  );
}

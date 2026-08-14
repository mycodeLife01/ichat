import { useEffect } from "react";
import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";

import { toastSurface } from "./classes";
import { Icons } from "./icons";
import type { ToastState, ToastTone } from "./state";

type ToastProps = {
  toast: ToastState;
  onDismiss: () => void;
  duration?: number;
};

const presentations = {
  neutral: {
    Icon: Info,
    classes: "border-neutral-border bg-neutral-soft text-neutral-foreground",
  },
  success: {
    Icon: Icons.Check,
    classes: "border-accent bg-accent text-accent-foreground",
  },
  error: {
    Icon: CircleAlert,
    classes: "border-error-border bg-error-soft text-error-foreground",
  },
  warning: {
    Icon: TriangleAlert,
    classes: "border-warning-border bg-warning-soft text-warning-foreground",
  },
} satisfies Record<ToastTone, { Icon: LucideIcon; classes: string }>;

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
  const { Icon, classes } = presentations[toast.tone];

  return (
    <div
      key={toast.id}
      className={`toast fixed top-5 left-1/2 z-[60] [transform:translateX(-50%)] animate-toast-in ${toastSurface} ${classes}`}
      data-tone={toast.tone}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-atomic="true"
    >
      <Icon
        className="shrink-0"
        data-toast-icon={toast.tone}
        size={15}
        strokeWidth={1.9}
        aria-hidden="true"
      />
      <span>{toast.message}</span>
    </div>
  );
}

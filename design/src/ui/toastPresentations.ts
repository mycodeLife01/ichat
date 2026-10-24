import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";

import { Icons } from "./icons";
import type { ToastTone } from "./state";

export const toastPresentations = {
  neutral: {
    Icon: Info,
    classes: "border-neutral-border bg-neutral-soft text-neutral-foreground",
  },
  success: {
    Icon: Icons.Check,
    classes: "border-success-border bg-success-soft text-success-foreground",
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
